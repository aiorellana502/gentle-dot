import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { historyFromMessages, pageHistory, resolveConversation } from "../src/conversations.ts";
import { describeTool } from "../src/presentation.ts";
import { tempDir } from "./helpers.ts";

describe("tool history", () => {
	it("binds history targets and cached pages to the trusted workspace", () => {
		const workspace = tempDir();
		const messages = [{ role: "assistant", content: [
			{ type: "toolCall", id: "safe", name: "read", arguments: { path: join(workspace, "src", "app.ts") } },
			{ type: "toolCall", id: "external", name: "edit", arguments: { path: join(workspace, "..", "CANARY") } },
		] }];
		const activities = historyFromMessages(messages, workspace)[0]?.activities;
		expect(activities?.[0]).toMatchObject({ tool: "read", target: "src/app.ts", status: "done" });
		expect(activities?.[1]).not.toHaveProperty("target");
		expect(JSON.stringify(activities)).not.toContain("CANARY");
		const file = join(tempDir(), "targets.jsonl");
		writeFileSync(file, JSON.stringify({ type: "message", message: messages[0] }));
		expect(pageHistory([file], 1, undefined, workspace).messages[0]?.activities).toEqual(activities);
		for (const context of [undefined, tempDir()]) {
			for (const activity of pageHistory([file], 1, undefined, context).messages[0]?.activities ?? []) {
				expect(activity).not.toHaveProperty("target");
			}
		}
		expect(pageHistory([file], 1, undefined, workspace).messages[0]?.activities).toEqual(activities);
	});

	it("replays safe live details with failed results and preserves turn association and paging", () => {
		const messages = [
			{ role: "user", content: "Check" },
			{ role: "assistant", content: [
				{ type: "text", text: "Answer" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/CANARY/file", content: "CANARY" } },
				{ type: "toolCall", id: "t2", name: "connector_CANARY", arguments: { command: "CANARY" } },
			] },
			{ role: "toolResult", toolCallId: "t1", isError: true, content: "CANARY error" },
		];
		const history = historyFromMessages(messages);
		expect(history).toEqual([
			{ id: "h1", role: "user", text: "Check", activities: [] },
			{ id: "h2", role: "assistant", text: "Answer", activities: [
				{ id: "t1", ...describeTool("read", {}, "failed"), status: "failed" },
				{ id: "t2", kind: "other", title: "Finished", status: "done" },
			] },
		]);
		expect(JSON.stringify(history)).not.toContain("CANARY");
		const file = join(tempDir(), "history.jsonl");
		writeFileSync(file, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
		const page = pageHistory([file], 1);
		expect(page).toEqual({ messages: [{ ...history[1], id: "s0-2" }], hasEarlier: true });
		expect(pageHistory([file], 1)).toEqual(page);
		expect(pageHistory([file], 1, "s0-2").messages).toEqual([{ ...history[0], id: "s0-1" }]);
	});
});

describe("resolveConversation", () => {
	it("resolves a session file inside the sessions folder", () => {
		const sessions = join(tempDir(), "sessions");
		mkdirSync(join(sessions, "nested"), { recursive: true });
		writeFileSync(join(sessions, "nested", "a.jsonl"), "");
		expect(resolveConversation(sessions, "nested/a.jsonl")).toBe(join(sessions, "nested", "a.jsonl"));
		expect(resolveConversation(sessions, "../a.jsonl")).toBeUndefined();
	});

	it("refuses a symlink that leads outside the sessions folder", () => {
		const root = tempDir();
		const sessions = join(root, "sessions");
		mkdirSync(join(root, "elsewhere"), { recursive: true });
		mkdirSync(sessions);
		writeFileSync(join(root, "elsewhere", "secret.jsonl"), "");
		symlinkSync(join(root, "elsewhere", "secret.jsonl"), join(sessions, "link.jsonl"));
		symlinkSync(join(root, "elsewhere"), join(sessions, "dir"));
		expect(resolveConversation(sessions, "link.jsonl")).toBeUndefined();
		expect(resolveConversation(sessions, "dir/secret.jsonl")).toBeUndefined();
	});
});
