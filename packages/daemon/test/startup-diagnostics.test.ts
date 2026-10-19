import { afterEach, expect, test, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { AgentSupervisor, SupervisorEvent } from "../src/supervisor.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function fixture() {
 const listeners = new Set<(event: SupervisorEvent) => void>();
 const supervisor = {
  state: "starting", busy: false,
  request: async () => ({ data: {} }),
  onEvent(fn: (event: SupervisorEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
 } as unknown as AgentSupervisor;
 const logs: string[] = [];
 const bridge = new DotBridge(supervisor, { dataDir: ".cache/windows-local/unused", log: line => logs.push(line) });
 const payloads: unknown[] = [];
 return { supervisor, logs, payloads, bridge, emit(state: "stopped") {
  supervisor.state = state;
  for (const fn of listeners) fn({ type: "supervisor_state", state, secret: "NEVER_PRINT" });
 } };
}

test.each([undefined, "", "0", "true", " 1", "1 ", "1"])("history diagnostics exact opt-in %s", async value => {
 vi.useFakeTimers();
 vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", value);
 const f = fixture();
 const pending = f.bridge.handle({ send: p => f.payloads.push(p) }, { type: "get_history" });
 f.emit("stopped");
 await pending;
 expect(f.payloads).toContainEqual({ type: "error", code: "agent_unavailable", message: "The assistant is restarting. Try again in a moment." });
 const diagnostic = f.logs.filter(line => line.startsWith("[startup-diagnostics]"));
 if (value !== "1") expect(diagnostic).toEqual([]);
 else {
  expect(diagnostic.map(line => line.replace(/elapsed_ms=\d+/, "elapsed_ms=N"))).toEqual([
   "[startup-diagnostics] history phase=entry state=starting elapsed_ms=N",
   "[startup-diagnostics] history phase=subscribed state=starting elapsed_ms=N",
   "[startup-diagnostics] history phase=stopped state=stopped elapsed_ms=N",
  ]);
 }
 expect(f.logs.join("\n")).not.toContain("NEVER_PRINT");
 expect(vi.getTimerCount()).toBe(0);
});

test("already-ready history preserves immediate delivery", async () => {
 vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1");
 const f = fixture(); f.supervisor.state = "ready";
 await f.bridge.handle({ send: p => f.payloads.push(p) }, { type: "get_history" });
 expect(f.payloads).toEqual([{ type: "history", messages: [], hasEarlier: false }]);
 expect(f.logs.filter(line => line.startsWith("[startup-diagnostics]")).map(line => line.replace(/elapsed_ms=\d+/, "elapsed_ms=N"))).toEqual([
  "[startup-diagnostics] history phase=entry state=ready elapsed_ms=N",
  "[startup-diagnostics] history phase=ready state=ready elapsed_ms=N",
 ]);
});

test("history timeout remains sixty seconds with sanitized diagnostics", async () => {
 vi.useFakeTimers(); vi.stubEnv("GENTLE_DOT_STARTUP_DIAGNOSTICS", "1");
 const f = fixture();
 const pending = f.bridge.handle({ send: p => f.payloads.push(p) }, { type: "get_history" });
 await vi.advanceTimersByTimeAsync(60_000); await pending;
 expect(f.logs).toContain("[startup-diagnostics] history phase=timeout state=starting elapsed_ms=60000");
 expect(f.logs).toContain("command get_history failed: the agent did not start in time");
 expect(vi.getTimerCount()).toBe(0);
});
