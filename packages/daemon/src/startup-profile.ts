import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const STARTUP_PROFILE_MS = 60_000;

/** Shared ordering seam: rejection must never reach optional diagnostic setup. */
export async function authenticateThenProfile<T>(
	authenticate: () => Promise<T>,
	profile: () => Promise<unknown>,
): Promise<T> {
	const channel = await authenticate();
	await profile();
	return channel;
}

/** Repo-local opt-in CPU sampling. Profiles contain sensitive code/module paths; keep local. */
export async function startStartupProfile(
	entry: string,
	durationMs = STARTUP_PROFILE_MS,
	loadInspector: () => Promise<typeof import("node:inspector")> = () => import("node:inspector"),
): Promise<boolean> {
	if (process.env.GENTLE_DOT_STARTUP_DIAGNOSTICS !== "1") return false;
	const dir = resolve(entry, "../../../../.cache/windows-local/cpu-profiles");
	if (!existsSync(dir)) return false;
	const started = Date.now();
	const event = (phase: "profiler_begin" | "profiler_ready" | "profiler_fail") => {
		process.stderr.write(
			`[startup-diagnostics] bootstrap phase=${phase} elapsed_ms=${Math.max(0, Date.now() - started)}\n`,
		);
	};
	let session: import("node:inspector").Session | undefined;
	const disconnect = () => {
		try {
			session?.disconnect();
		} catch {}
		session = undefined;
	};
	const post = (method: string) =>
		new Promise<any>((resolve, reject) => {
			session!.post(method as never, (error: Error | null, result: unknown) =>
				error ? reject(error) : resolve(result),
			);
		});
	event("profiler_begin");
	try {
		const { Session } = await loadInspector();
		session = new Session();
		session.connect();
		await post("Profiler.enable");
		await post("Profiler.start");
		setTimeout(() => {
			void (async () => {
				try {
					const result = await post("Profiler.stop");
					writeFileSync(join(dir, `daemon-${Date.now()}.cpuprofile`), JSON.stringify(result.profile));
				} catch {
					event("profiler_fail");
				} finally {
					disconnect();
				}
			})();
		}, durationMs).unref();
		event("profiler_ready");
		return true;
	} catch {
		disconnect();
		event("profiler_fail");
		return false;
	}
}
