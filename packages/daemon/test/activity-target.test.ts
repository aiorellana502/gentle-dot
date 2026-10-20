import { resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { safeRelativeTarget } from "../src/activity-target.ts";

const workspace = resolve("synthetic-project");

it("returns only normalized interior paths with forward slashes", () => {
	expect(safeRelativeTarget(workspace, "src/../src/app.ts")).toBe("src/app.ts");
	expect(safeRelativeTarget(workspace, resolve(workspace, "src/app.ts"))).toBe("src/app.ts");
	if (sep === "\\") {
		expect(safeRelativeTarget(workspace.toUpperCase(), resolve(workspace, "src/app.ts"))).toBe("src/app.ts");
	}
});

it("omits roots, escapes, ambiguous paths and arbitrary payloads", () => {
	for (const candidate of [
		undefined, null, "", " ", ".", workspace, "../secret", "src/../../secret",
		"D:\\x", "C:relative", "\\\\server\\share\\file", "//server/share/file",
		"src/a?token", "src/a#fragment", "https://example.test/a", "a\0b", "a\nb", "a\u007fb",
		42, [], {}, { path: "src/app.ts" },
	]) {
		expect(safeRelativeTarget(workspace, candidate), String(candidate)).toBeUndefined();
	}
	expect(safeRelativeTarget(undefined, "src/app.ts")).toBeUndefined();
});

it("rejects bidirectional and other Unicode format characters", () => {
	for (const mark of ["\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\u2028", "\u2029"]) {
		expect(safeRelativeTarget(workspace, `src/${mark}app.ts`), mark).toBeUndefined();
	}
});

it("rejects Windows device, root-relative and sibling-prefix paths", () => {
	if (sep !== "\\") return;
	for (const candidate of [
		"\\\\?\\C:\\x", "\\\\.\\pipe\\x", "\\x", "/x", "src/a.ts:secret", "C:", "C:..\\x", "\u0085x",
		`${workspace}X\\a`,
	]) {
		expect(safeRelativeTarget(workspace, candidate), candidate).toBeUndefined();
	}
	expect(safeRelativeTarget(workspace, workspace.toLowerCase() + "\\src\\a.ts")).toBe("src/a.ts");
});
