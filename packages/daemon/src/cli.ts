#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inheritedAppSocket, openNamedPipeChannel } from "./app-channel.ts";
import { serveAuthHelper } from "./auth-helper.ts";
import { loadConfig } from "./config.ts";
import { APPROVAL_GUARD, bundledMcpCli } from "./connectors.ts";
import { startDaemon, startupMessage } from "./daemon.ts";
import { resolveEngramBin, runtimeDir } from "./runtime.ts";
import { SECRETS_KEY_VAR } from "./secret-file.ts";
import { currentActivity, mark } from "./startup-marks.ts";
import { authenticateThenProfile, startStartupProfile } from "./startup-profile.ts";
import { loadVpsOptions } from "./vps.ts";
import { IDENTITY_SOURCE } from "./white-label.ts";

/** This file (or the bundled `cli.mjs`), which the sign-in helper runs again. */
const ENTRY = fileURLToPath(import.meta.url);
const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

/**
 * `--self-check`: resolves the files the daemon runs on, without starting anything or
 * using the network, prints them as JSON, and exits 1 when one is missing.
 */
function selfCheck(): void {
	const config = loadConfig();
	const runtime = runtimeDir();
	const report = {
		runtime,
		uiDir: config.uiDir,
		gentleShell: config.agentArgs[0],
		engineCli: bundledMcpCli().args[0],
		approvalGuard: APPROVAL_GUARD,
		identity: fileURLToPath(IDENTITY_SOURCE),
		engramBin: runtime ? resolveEngramBin(process.env, runtime) : undefined,
	};
	const required = [report.gentleShell, report.engineCli, report.approvalGuard, report.identity];
	const ok = required.every((path) => path !== undefined && existsSync(path));
	process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
	process.exit(ok ? 0 : 1);
}

async function main(namedPipeSelection?: NamedPipeSelection): Promise<void> {
	const started = Date.now();
	const phase = (value: "entry" | "pipe_begin" | "pipe_ok" | "pipe_fail") => {
		if (process.env.GENTLE_DOT_STARTUP_DIAGNOSTICS === "1")
			process.stderr.write(`[startup-diagnostics] bootstrap phase=${value} elapsed_ms=${Math.max(0, Date.now() - started)}\n`);
	};
	phase("entry");
	// Authentication remains ahead of optional profiling, configuration and stdout.
	const namedPipeChannel = await authenticateThenProfile(async () => {
		mark("cli.pipe.connect");
		if (!namedPipeSelection) return undefined;
		phase("pipe_begin");
		try {
			const channel = await openNamedPipeChannel({ ...namedPipeSelection, log });
			phase("pipe_ok");
			return channel;
		} catch (error) {
			phase("pipe_fail");
			throw error;
		}
	}, () => startStartupProfile(ENTRY));
	mark("cli.config.load");
	const config = loadConfig();
	// Fixed diagnostics: an event loop that stops turning is invisible in every other signal, and it
	// looks exactly like a dead daemon to `GET /health` (opt-in, one line per stall over 250 ms).
	if (process.env.GENTLE_DOT_STARTUP_DIAGNOSTICS === "1") {
		const file = join(config.dataDir, "event-loop-lag.log");
		let last = Date.now();
		setInterval(() => {
			const now = Date.now();
			const lag = now - last - 100;
			last = now;
			if (lag > 250) {
				const activity = currentActivity();
				process.stderr.write(
					`[startup-diagnostics] daemon stalled_ms=${lag} last_activity=${activity.name} activity_age_ms=${activity.ageMs}\n`,
				);
				try {
					appendFileSync(
						file,
						`${new Date().toISOString()} stalled_ms=${lag} last_activity=${activity.name} activity_age_ms=${activity.ageMs}\n`,
					);
				} catch {}
			}
		}, 100).unref();
	}
	// The desktop app that launched the daemon hands over its private channel on fd 3 (S25.1); it is
	// opened before anything is spawned, and refused if children would inherit it.
	const appChannel = namedPipeSelection ? namedPipeChannel : inheritedAppSocket({ log });
	// Server mode only when GENTLE_DOT_VPS says so (S25.8). The secrets key is read once and removed
	// from the process environment, so no child the daemon starts can inherit it.
	const vps = loadVpsOptions(process.env, { uid: process.getuid?.() ?? -1 });
	delete process.env[SECRETS_KEY_VAR];
	mark("cli.daemon.start");
	const daemon = await startDaemon({
		port: config.port,
		host: config.host,
		dataDir: config.dataDir,
		workspace: config.workspace,
		...(config.preferredFolder ? { preferredFolder: config.preferredFolder } : {}),
		uiDir: config.uiDir,
		agentCommand: config.agentCommand,
		agentArgs: config.agentArgs,
		...(config.agentHome ? { agentHome: config.agentHome } : {}),
		allowedOrigins: config.allowedOrigins,
		...(appChannel ? { appChannel } : {}),
		// Sign-in runs in this same entry point as the engine's user (`--auth-helper`, B1).
		...(vps
			? { vps: { ...vps, authHelper: { command: process.execPath, args: [ENTRY, "--auth-helper"] } } }
			: {}),
		log,
	});
	// Named pipes do not carry protocol bytes on stdout; keep the ordinary startup banner.
	process.stdout.write(`${startupMessage(daemon.url, config.dataDir, process.stdout.isTTY === true)}\n`);

	let closing = false;
	const shutdown = (signal: string) => {
		if (closing) return;
		closing = true;
		log(`received ${signal}, shutting down`);
		daemon.close().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	// A daemon the app launched stops itself when the app's channel closes (S35.2); so does the process.
	void daemon.closed.then(() => process.exit(0));
}

interface NamedPipeSelection {
	pipeName: string;
	expectedServerPid: number;
	expectedServerCreatedAt: bigint;
	timeoutMs: number;
}

/**
 * Private Windows bootstrap: --app-channel-named-pipe <name> requires
 * --app-channel-named-pipe-server-pid <positive u32> and
 * --app-channel-named-pipe-server-created-at <unsigned u64 decimal FILETIME ticks>.
 * Optional --app-channel-named-pipe-timeout-ms <u32> defaults to 5000; zero expires immediately.
 * Parse these nonsecret flags before every other branch, without loading the addon.
 */
function parseNamedPipeSelection(): NamedPipeSelection | undefined {
	const prefix = "--app-channel-named-pipe";
	const flags = [prefix, `${prefix}-server-pid`, `${prefix}-server-created-at`, `${prefix}-timeout-ms`];
	if (!process.argv.some((arg) => arg.startsWith(prefix))) return undefined;
	if (process.argv.includes("--self-check") || process.argv.includes("--auth-helper")) {
		throw new Error(`${prefix} cannot be combined with --self-check or --auth-helper`);
	}
	const values = new Map<string, string>();
	for (let i = 2; i < process.argv.length; i++) {
		const flag = process.argv[i];
		if (!flag?.startsWith(prefix)) continue;
		if (!flags.includes(flag) || values.has(flag))
			throw new Error(`Invalid or duplicate ${prefix} flag: ${flag}`);
		const value = process.argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		values.set(flag, value);
	}
	const required = (flag: string): string => {
		const value = values.get(flag);
		if (value === undefined) throw new Error(`Missing required ${flag}`);
		return value;
	};
	const decimal = (flag: string, value: string, max: bigint): bigint => {
		if (!/^\d+$/.test(value)) throw new Error(`Invalid decimal ${flag}`);
		const number = BigInt(value);
		if (number > max) throw new Error(`Out of range ${flag}`);
		return number;
	};
	const pipeName = required(prefix);
	const pidFlag = `${prefix}-server-pid`;
	const expectedServerPid = Number(decimal(pidFlag, required(pidFlag), 0xffffffffn));
	if (expectedServerPid === 0) throw new Error(`Out of range ${pidFlag}`);
	const createdFlag = `${prefix}-server-created-at`;
	const expectedServerCreatedAt = decimal(createdFlag, required(createdFlag), (1n << 64n) - 1n);
	const timeoutFlag = `${prefix}-timeout-ms`;
	const timeoutMs = Number(decimal(timeoutFlag, values.get(timeoutFlag) ?? "5000", 0xffffffffn));
	return { pipeName, expectedServerPid, expectedServerCreatedAt, timeoutMs };
}

let namedPipeSelection: NamedPipeSelection | undefined;
try {
	namedPipeSelection = parseNamedPipeSelection();
} catch (error) {
	log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

if (process.argv.includes("--auth-helper")) serveAuthHelper();
else {
	if (process.argv.includes("--self-check")) selfCheck();
	main(namedPipeSelection).catch((error: Error) => {
		log(`failed to start: ${error.message}`);
		process.exit(1);
	});
}
