import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Socket, connect as unixConnect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("gentle-dot command", () => {
	it.each([
		["--app-channel-named-pipe", "test"],
		[
			"--app-channel-named-pipe",
			"test",
			"--app-channel-named-pipe-server-pid",
			"bad",
			"--app-channel-named-pipe-server-created-at",
			"1",
		],
		[
			"--app-channel-named-pipe",
			"test",
			"--app-channel-named-pipe-server-pid",
			"1",
			"--app-channel-named-pipe-server-created-at",
			"bad",
		],
		[
			"--app-channel-named-pipe",
			"test",
			"--app-channel-named-pipe-server-pid",
			"1",
			"--app-channel-named-pipe-server-created-at",
			"1",
			"--self-check",
		],
		...[
			["--app-channel-named-pipe-server-pid", "1"],
			["--app-channel-named-pipe-server-created-at", "1"],
			[
				"--app-channel-named-pipe-server-pid",
				"4294967296",
				"--app-channel-named-pipe-server-created-at",
				"1",
			],
			[
				"--app-channel-named-pipe-server-pid",
				"1",
				"--app-channel-named-pipe-server-created-at",
				"18446744073709551616",
			],
			...["-1", "1.5", "Infinity", "4294967296"].map((timeout) => [
				"--app-channel-named-pipe-server-pid",
				"1",
				"--app-channel-named-pipe-server-created-at",
				"1",
				"--app-channel-named-pipe-timeout-ms",
				timeout,
			]),
		].map((companions) => ["--app-channel-named-pipe", "test", ...companions]),
	])("rejects invalid named-pipe selection before stdout: %j", async (...args) => {
		const dataDir = join(tempDir(), "not-created");
		const child = spawn(process.execPath, [CLI, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GENTLE_DOT_DATA_DIR: dataDir },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (bytes) => {
			stdout += bytes;
		});
		child.stderr.on("data", (bytes) => {
			stderr += bytes;
		});
		expect(await new Promise((resolve) => child.on("close", resolve))).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("--app-channel-named-pipe");
		expect(existsSync(dataDir)).toBe(false);
	});
	it("fails closed on a selected connection failure before configuration or stdout", async () => {
		const dataDir = join(tempDir(), "not-created");
		const child = spawn(
			process.execPath,
			[
				CLI,
				"--app-channel-named-pipe",
				`\\\\.\\pipe\\gentle-dot-absent-${process.pid}-${Date.now()}`,
				"--app-channel-named-pipe-server-pid",
				"1",
				"--app-channel-named-pipe-server-created-at",
				"1",
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_PORT: "invalid" },
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (bytes) => {
			stdout += bytes;
		});
		child.stderr.on("data", (bytes) => {
			stderr += bytes;
		});
		expect(await new Promise((resolve) => child.on("close", resolve))).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain(
			process.platform === "win32" ? "PipeConnectionRefused" : "only supported on Windows",
		);
		expect(existsSync(dataDir)).toBe(false);
	});
	it("keeps the access key out of redirected output, such as a log file", async () => {
		const dataDir = join(tempDir(), "data");
		const child = spawn(process.execPath, [CLI], {
			env: {
				...process.env,
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_AGENT_BIN: process.execPath,
				GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const exited = new Promise((resolve) => child.on("close", resolve));
		try {
			await waitFor(() => output.includes("Gentle Dot is running"), 15_000);
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
		const token = readFileSync(join(dataDir, "token"), "utf8").trim();
		expect(output).not.toContain(token);
		expect(output).toContain(`the access key is in ${join(dataDir, "token")}`);
		expect(statSync(dataDir).mode & 0o777).toBe(0o700);
	});

	it.skipIf((process.getuid?.() ?? 0) === 0)(
		"refuses server mode it cannot keep: GENTLE_DOT_VPS as a user that is not root (S25.8)",
		async () => {
			const dataDir = join(tempDir(), "data");
			const child = spawn(process.execPath, [CLI], {
				env: {
					...process.env,
					GENTLE_DOT_VPS: "1",
					GENTLE_DOT_DATA_DIR: dataDir,
					GENTLE_DOT_PORT: "0",
					GENTLE_DOT_AGENT_BIN: process.execPath,
					GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
			const code = await Promise.race([
				new Promise((resolve) => child.on("close", resolve)),
				new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000)),
			]);
			if (code === "still running") child.kill("SIGTERM");
			expect(code).toBe(1);
			expect(output).toMatch(/failed to start: Server mode .* root/);
			expect(output).not.toContain("Gentle Dot is running");
		},
	);

	it("a daemon launched with the app's channel exits when the app goes (S35.2, #22)", async () => {
		const dataDir = join(tempDir(), "data");
		const { app, daemon } = await socketPair();
		const child = spawn(process.execPath, [CLI], {
			env: {
				...process.env,
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_AGENT_BIN: process.execPath,
				GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
			},
			stdio: ["ignore", "pipe", "pipe", daemon],
		});
		daemon.destroy();
		let output = "";
		const collect = (chunk: Buffer) => {
			output += chunk.toString();
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
		try {
			// The daemon is up once it asks the app for something (the connectors' integrity key).
			await new Promise((resolve) => app.once("data", resolve));
			// The app quits, crashes, or is killed: the kernel closes its end of the pair.
			app.destroy();
			expect(await exited).toBe(0);
		} finally {
			child.kill("SIGKILL");
		}
		expect(output).toContain("the desktop app's channel closed; stopping the assistant");
	});
});

/** A connected pair of Unix sockets (Node has no socketpair): the app's end and the daemon's. */
async function socketPair(): Promise<{ app: Socket; daemon: Socket }> {
	const path = join(tempDir(), "pair.sock");
	const server = createServer();
	await new Promise<void>((done) => server.listen(path, done));
	const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
	const daemon = unixConnect(path);
	await new Promise((resolve) => daemon.once("connect", resolve));
	const app = await accepted;
	server.close();
	return { app, daemon };
}
