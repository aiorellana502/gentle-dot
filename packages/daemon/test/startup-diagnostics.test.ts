import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { afterEach, expect, test, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import { authenticateThenProfile } from "../src/startup-profile.ts";
import type { AgentSupervisor, SupervisorEvent } from "../src/supervisor.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// Execute the CLI control flow with every import replaced by synthetic dependencies.
// No production config module, named pipe, daemon or personal profile is loaded.
async function bootstrapFixture(args: string[], enabled = "1", rejectPipe = false) {
	const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
		.replace(/^#!.*\n/, "")
		.replace(/^import .*;\r?$/gm, "")
		.replace("fileURLToPath(import.meta.url)", '"synthetic-entry"')
		.replace("main(namedPipeSelection).catch", "return main(namedPipeSelection).catch");
	const logs: string[] = [],
		output: string[] = [],
		order: string[] = [];
	const exit = { code: undefined as number | undefined };
	const config = { agentArgs: ["synthetic"], dataDir: "synthetic", port: 1 };
	const stop = {};
	const deps = {
		process: {
			argv: ["node", "cli", ...args],
			env: { GENTLE_DOT_STARTUP_DIAGNOSTICS: enabled },
			stderr: { write: (s: string) => logs.push(s) },
			stdout: { write: (s: string) => output.push(s) },
			exit: (code: number) => {
				exit.code = code;
				throw stop;
			},
			on: () => {},
			getuid: () => 0,
		},
		authenticateThenProfile,
		startStartupProfile: async () => {
			order.push("profile");
			return false;
		},
		openNamedPipeChannel: async () => {
			order.push("auth");
			if (rejectPipe) throw new Error("synthetic rejection");
			return {};
		},
		loadConfig: () => {
			order.push("config");
			return config;
		},
		mark: () => {},
		inheritedAppSocket: () => {
			order.push("inherited");
			return undefined;
		},
		loadVpsOptions: () => undefined,
		SECRETS_KEY_VAR: "SYNTHETIC",
		startDaemon: async () => {
			order.push("daemon");
			return { url: "synthetic", closed: new Promise(() => {}) };
		},
		startupMessage: () => "banner",
		serveAuthHelper: () => {
			order.push("helper");
		},
		runtimeDir: () => "synthetic",
		bundledMcpCli: () => ({ args: ["synthetic"] }),
		APPROVAL_GUARD: "synthetic",
		IDENTITY_SOURCE: "synthetic",
		fileURLToPath: () => "synthetic",
		resolveEngramBin: () => "synthetic",
		existsSync: () => true,
		// Never schedule the real watchdog or read/write files.
		join: () => "synthetic",
		setInterval: () => ({ unref() {} }),
		appendFileSync: () => {
			throw new Error("unexpected write");
		},
	};
	const code = transformSync(source, { loader: "ts", target: "esnext" }).code;
	try {
		await new Function(...Object.keys(deps), code)(...Object.values(deps));
	} catch (error) {
		if (error !== stop) throw error;
	}
	return { logs, output, order, exit: exit.code };
}
const pipeArgs = [
	"--app-channel-named-pipe",
	"synthetic",
	"--app-channel-named-pipe-server-pid",
	"1",
	"--app-channel-named-pipe-server-created-at",
	"1",
];
test("CLI selected bootstrap orders authentication before profiling and configuration", async () => {
	const f = await bootstrapFixture(pipeArgs);
	expect(f.order).toEqual(["auth", "profile", "config", "daemon"]);
	expect(f.output).toEqual(["banner\n"]);
	expect(f.exit).toBeUndefined();
	expect(f.logs.map((s) => s.replace(/elapsed_ms=\d+/, "elapsed_ms=N"))).toEqual([
		"[startup-diagnostics] bootstrap phase=entry elapsed_ms=N\n",
		"[startup-diagnostics] bootstrap phase=pipe_begin elapsed_ms=N\n",
		"[startup-diagnostics] bootstrap phase=pipe_ok elapsed_ms=N\n",
	]);
	const rejected = await bootstrapFixture(pipeArgs, "1", true);
	expect(rejected.order).toEqual(["auth"]);
	expect(rejected.exit).toBe(1);
	expect(rejected.output).toEqual([]);
	expect(
		rejected.logs
			.filter((s) => s.startsWith("[startup-diagnostics]"))
			.map((s) => s.replace(/elapsed_ms=\d+/, "elapsed_ms=N")),
	).toEqual([
		"[startup-diagnostics] bootstrap phase=entry elapsed_ms=N\n",
		"[startup-diagnostics] bootstrap phase=pipe_begin elapsed_ms=N\n",
		"[startup-diagnostics] bootstrap phase=pipe_fail elapsed_ms=N\n",
	]);
	expect(rejected.logs.at(-1)).toMatch(/ failed to start: synthetic rejection\n$/);
});
test("CLI diagnostic opt-out preserves ordinary startup and special branches", async () => {
	const f = await bootstrapFixture([], "0");
	expect(f.order).toEqual(["profile", "config", "inherited", "daemon"]);
	expect(f.logs).toEqual([]);
	expect(f.output).toEqual(["banner\n"]);
	expect(f.exit).toBeUndefined();
	const helper = await bootstrapFixture(["--auth-helper"]);
	expect(helper.order).toEqual(["helper"]);
	expect(helper.logs).toEqual([]);
	expect(helper.output).toEqual([]);
	const check = await bootstrapFixture(["--self-check"]);
	expect(check.order).toEqual(["config"]);
	expect(check.exit).toBe(0);
	expect(check.logs).toEqual([]);
	expect(JSON.parse(check.output.join(""))).toMatchObject({ ok: true });
});

function fixture() {
	const listeners = new Set<(event: SupervisorEvent) => void>();
	const supervisor = {
		state: "starting",
		busy: false,
		request: async () => ({ data: {} }),
		onEvent(fn: (event: SupervisorEvent) => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	} as unknown as AgentSupervisor;
	const logs: string[] = [];
	const bridge = new DotBridge(supervisor, {
		dataDir: ".cache/windows-local/unused",
		log: (line) => logs.push(line),
	});
	const payloads: unknown[] = [];
	return {
		supervisor,
		logs,
		payloads,
		bridge,
		emit(state: "stopped") {
			supervisor.state = state;
			for (const fn of listeners) fn({ type: "supervisor_state", state, secret: "NEVER_PRINT" });
		},
	};
}

test.each([undefined, "", "0", "true", " 1", "1 ", "1"])(
	"history diagnostics exact opt-in %s",
	async (value) => {
		vi.useFakeTimers();
		vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", value);
		const f = fixture();
		const pending = f.bridge.handle({ send: (p) => f.payloads.push(p) }, { type: "get_history" });
		f.emit("stopped");
		await pending;
		expect(f.payloads).toContainEqual({
			type: "error",
			code: "agent_unavailable",
			message: "The assistant is restarting. Try again in a moment.",
		});
		const diagnostic = f.logs.filter((line) => line.startsWith("[startup-diagnostics]"));
		if (value !== "1") expect(diagnostic).toEqual([]);
		else {
			expect(diagnostic.map((line) => line.replace(/elapsed_ms=\d+/, "elapsed_ms=N"))).toEqual([
				"[startup-diagnostics] history phase=entry state=starting elapsed_ms=N",
				"[startup-diagnostics] history phase=subscribed state=starting elapsed_ms=N",
				"[startup-diagnostics] history phase=stopped state=stopped elapsed_ms=N",
			]);
		}
		expect(f.logs.join("\n")).not.toContain("NEVER_PRINT");
		expect(vi.getTimerCount()).toBe(0);
	},
);

test("already-ready history preserves immediate delivery", async () => {
	vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1");
	const f = fixture();
	f.supervisor.state = "ready";
	await f.bridge.handle({ send: (p) => f.payloads.push(p) }, { type: "get_history" });
	expect(f.payloads).toEqual([{ type: "history", messages: [], hasEarlier: false }]);
	expect(
		f.logs
			.filter((line) => line.startsWith("[startup-diagnostics]"))
			.map((line) =>
				line.replace(/elapsed_ms=\d+/, "elapsed_ms=N").replace(/duration_ms=\d+/, "duration_ms=N"),
			),
	).toEqual([
		"[startup-diagnostics] history phase=entry state=ready elapsed_ms=N",
		"[startup-diagnostics] history phase=ready state=ready elapsed_ms=N",
		"[startup-diagnostics] history_sync op=page files=0 bytes=0 duration_ms=N",
	]);
});

test.each([undefined, "0", "1"])("synchronous history work timing exact opt-in %s", async (value) => {
	vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", value);
	const f = fixture();
	f.supervisor.state = "ready";
	const client = { send: (p: unknown) => f.payloads.push(p) };
	await f.bridge.handle(client, { type: "get_history" });
	await f.bridge.handle(client, { type: "list_conversations" });
	expect(f.payloads[0]).toEqual({ type: "history", messages: [], hasEarlier: false });
	expect(f.payloads[1]).toMatchObject({ type: "conversations", conversations: [] });
	const timing = f.logs
		.filter((line) => line.includes("history_sync"))
		.map((line) => line.replace(/duration_ms=\d+/, "duration_ms=N"));
	if (value !== "1") expect(timing).toEqual([]);
	else
		expect(timing).toEqual([
			"[startup-diagnostics] history_sync op=page files=0 bytes=0 duration_ms=N",
			"[startup-diagnostics] history_sync op=list files=0 duration_ms=N",
		]);
});

test("history timeout remains sixty seconds with sanitized diagnostics", async () => {
	vi.useFakeTimers();
	vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1");
	const f = fixture();
	const pending = f.bridge.handle({ send: (p) => f.payloads.push(p) }, { type: "get_history" });
	await vi.advanceTimersByTimeAsync(60_000);
	await pending;
	expect(f.logs).toContain("[startup-diagnostics] history phase=timeout state=starting elapsed_ms=60000");
	expect(f.logs).toContain("command get_history failed: the agent did not start in time");
	expect(vi.getTimerCount()).toBe(0);
});
