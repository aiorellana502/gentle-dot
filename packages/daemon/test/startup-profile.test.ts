import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { authenticateThenProfile, startStartupProfile } from "../src/startup-profile.ts";

const roots: string[] = [];
afterEach(() => {
 vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks();
 for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo(withProfiles: boolean) {
 const root = mkdtempSync(join(tmpdir(), "gentle-dot-profile-")); roots.push(root);
 const dir = join(root, ".cache", "windows-local", "cpu-profiles");
 if (withProfiles) mkdirSync(dir, { recursive: true });
 return { entry: join(root, "packages", "daemon", "src", "cli.ts"), dir };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 400));
test("writes one CPU profile of the requested window when opted in", async () => {
 vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1");
 const { entry, dir } = repo(true);
 expect(await startStartupProfile(entry, 50)).toBe(true); await settle();
 const files = readdirSync(dir); expect(files).toHaveLength(1);
 expect(files[0]).toMatch(/^daemon-\d+\.cpuprofile$/);
 const profile = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
 expect(Array.isArray(profile.nodes)).toBe(true); expect(Array.isArray(profile.samples)).toBe(true);
});
test("stays off without the repo-local folder and never loads inspector", async () => {
 vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1"); const { entry, dir } = repo(false);
 const load = vi.fn(); expect(await startStartupProfile(entry, 50, load)).toBe(false);
 expect(load).not.toHaveBeenCalled(); expect(() => readdirSync(dir)).toThrow();
});
test.each([undefined, "", "0", "true", " 1", "1 "])("stays off unless diagnostics are exactly 1 (%s)", async value => {
 vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", value); const { entry, dir } = repo(true);
 const load = vi.fn(); expect(await startStartupProfile(entry, 50, load)).toBe(false);
 expect(load).not.toHaveBeenCalled(); expect(readdirSync(dir)).toEqual([]);
});
test.each(["import", "construct", "connect", "enable", "start"])("inspector %s failure is nonfatal and disconnects created sessions", async stage => {
 vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1"); const { entry, dir } = repo(true);
 const disconnect = vi.fn();
 const load = async () => {
  if (stage === "import") throw new Error("CANARY");
  return { Session: class {
   constructor() { if (stage === "construct") throw new Error("CANARY"); }
   connect() { if (stage === "connect") throw new Error("CANARY"); }
   disconnect = disconnect;
   post(method: string, cb: (error?: Error) => void) { cb(method.toLowerCase().endsWith(stage) ? new Error("CANARY") : undefined); }
  } };
 };
 expect(await startStartupProfile(entry, 50, load as never)).toBe(false);
 expect(disconnect).toHaveBeenCalledTimes(["import", "construct"].includes(stage) ? 0 : 1);
 expect(readdirSync(dir)).toEqual([]);
});
test("default sixty-second synthetic profile and stop failure clean up without raw diagnostics", async () => {
 vi.useFakeTimers(); vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1");
 const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
 for (const fail of [false, true]) {
  const { entry, dir } = repo(true); const disconnect = vi.fn();
  const load = async () => ({ Session: class {
   connect() {} disconnect = disconnect;
   post(method: string, cb: (error: Error | null, result?: unknown) => void) {
    cb(fail && method === "Profiler.stop" ? new Error("CANARY") : null, { profile: { nodes: [], samples: [] } });
   }
  } });
  expect(await startStartupProfile(entry, undefined, load as never)).toBe(true);
  await vi.advanceTimersByTimeAsync(59_999); expect(readdirSync(dir)).toEqual([]); expect(disconnect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(disconnect).toHaveBeenCalledTimes(1);
  expect(readdirSync(dir)).toHaveLength(fail ? 0 : 1);
 }
 expect(stderr.mock.calls.map(([line]) => String(line).replace(/elapsed_ms=\d+/, "elapsed_ms=N"))).toEqual([
  "[startup-diagnostics] bootstrap phase=profiler_begin elapsed_ms=N\n",
  "[startup-diagnostics] bootstrap phase=profiler_ready elapsed_ms=N\n",
  "[startup-diagnostics] bootstrap phase=profiler_begin elapsed_ms=N\n",
  "[startup-diagnostics] bootstrap phase=profiler_ready elapsed_ms=N\n",
  "[startup-diagnostics] bootstrap phase=profiler_fail elapsed_ms=N\n",
 ]);
 expect(vi.getTimerCount()).toBe(0);
});
test("bootstrap authenticates before optional profiler, preserves channel and rejects without profiling", async () => {
 const order: string[] = []; const channel = {};
 expect(await authenticateThenProfile(async () => { order.push("auth"); return channel; }, async () => { order.push("profile"); })).toBe(channel);
 expect(order).toEqual(["auth", "profile"]);
 const error = new Error("CANARY"); const profile = vi.fn();
 await expect(authenticateThenProfile(async () => { throw error; }, profile)).rejects.toBe(error);
 expect(profile).not.toHaveBeenCalled();
});
