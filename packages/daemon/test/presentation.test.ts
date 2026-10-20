import { ACTIVITY_TOOLS } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { describeTool } from "../src/presentation.ts";

describe("describeTool", () => {
	it("shows only known file targets with trusted workspace context", () => {
		const workspace = process.platform === "win32" ? "C:\\project" : "/project";
		for (const name of ["read", "write", "edit"]) {
			for (const key of ["path", "file_path", "filePath"]) {
				expect(describeTool(name, { [key]: "src/app.ts" }, "done", workspace)).toMatchObject({ target: "src/app.ts" });
			}
			for (const path of [undefined, "../CANARY", "/external/CANARY", "D:\\CANARY"]) {
				expect(describeTool(name, { path }, "failed", workspace)).not.toHaveProperty("target");
			}
			expect(describeTool(name, { path: "src/app.ts" }, "done")).not.toHaveProperty("target");
		}
		for (const name of [...ACTIVITY_TOOLS.filter((t) => !(["read", "write", "edit"] as const).includes(t as never)), "connector_CANARY"]) {
			for (const key of ["path", "file_path", "filePath"]) {
				expect(describeTool(name, { [key]: "src/app.ts" }, "done", workspace), name).not.toHaveProperty("target");
			}
		}
	});

	it("exposes only allowlisted identity and hides every target and payload", () => {
		for (const path of ["src/canary.md", "/external/canary.md", "C:\\private\\canary.md"]) {
			expect(describeTool("read", { path, content: "CANARY" }, "done")).toEqual({
				kind: "read", title: "Read a file", tool: "read",
			});
		}
		for (const name of ["connector_CANARY", "mem_CANARY", "codegraph_CANARY"]) {
			expect(describeTool(name, { command: "CANARY" }, "failed")).not.toHaveProperty("tool");
			expect(JSON.stringify(describeTool(name, { path: "CANARY" }))).not.toContain("CANARY");
		}
	});

	it("gives identity only to exact known names, case-insensitively", () => {
		expect(describeTool("READ", { path: "C:/x/CANARY" }, "done")).toEqual({
			kind: "read", title: "Read a file", tool: "read",
		});
		for (const name of ["__proto__", "constructor", "toString", "", "mem_save_CANARY", "subagent_CANARY"]) {
			expect(describeTool(name, {}, "done")).not.toHaveProperty("tool");
		}
	});

	it("titles a bash call by its status", () => {
		for (const [status, title] of [
			["running", "Running a command"], ["done", "Ran a command"], ["failed", "A command failed"],
		] as const) {
			expect(describeTool("bash", {}, status)).toEqual({ kind: "run", title, tool: "bash" });
		}
	});

	it("titles a read call with neutral tense regardless of file", () => {
		for (const [status, title] of [
			["running", "Reading a file"], ["done", "Read a file"], ["failed", "Could not read a file"],
		] as const) {
			expect(describeTool("read", { path: "/tmp/a.md" }, status)).toEqual({ kind: "read", title, tool: "read" });
		}
	});

	it("titles a read call without a file", () => {
		expect(describeTool("read", {}, "done")).toEqual({ kind: "read", title: "Read a file", tool: "read" });
	});

	it("titles edit and write calls with neutral tense", () => {
		expect(describeTool("edit", { path: "/tmp/a.ts" }, "running")).toEqual({
			kind: "edit", title: "Editing a file", tool: "edit",
		});
		expect(describeTool("write", { path: "/tmp/a.ts" }, "done")).toEqual({
			kind: "edit", title: "Edited a file", tool: "write",
		});
		expect(describeTool("edit", { path: "/tmp/a.ts" }, "failed")).toEqual({
			kind: "edit", title: "Could not edit a file", tool: "edit",
		});
	});

	it("preserves memory, delegate, search, and ask titles", () => {
		expect(describeTool("mem_save", {}, "done").title).toBe("Saved a note");
		expect(describeTool("mem_search", {}, "done").title).toBe("Checked my notes");
		expect(describeTool("mem_save", {}, "failed").title).toBe("Could not save a note");
		expect(describeTool("subagent_run", {}, "done").title).toBe("Asked a helper");
		expect(describeTool("web_search", {}, "done").title).toBe("Looked things up online");
		expect(describeTool("grep", { pattern: "x" }, "done").title).toBe("Searched files");
		expect(describeTool("codegraph_query", {}, "failed").title).toBe("Could not search files");
		expect(describeTool("ask_user_choice", {}, "done").title).toBe("Asked you");
	});

	it("defaults to running", () => {
		expect(describeTool("bash", {})).toEqual({ kind: "run", title: "Running a command", tool: "bash" });
	});

	it("titles unknown tools in all three tenses", () => {
		expect(describeTool("mystery", {}, "running")).toEqual({ kind: "other", title: "Working" });
		expect(describeTool("mystery", {}, "done").title).toBe("Finished");
		expect(describeTool("mystery", {}, "failed").title).toBe("Failed");
	});
});
