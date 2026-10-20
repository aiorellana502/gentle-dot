import { ACTIVITY_TOOLS, type ActivityKind, type ActivityTool } from "@gentle-dot/protocol";
import { safeRelativeTarget } from "./activity-target.ts";

/** The life cycle of one tool call, as the activity list shows it. */
export type ActivityStatus = "running" | "done" | "failed";

/** The titles of one tool family: while it runs, once it succeeded, once it failed. */
type Tense = readonly [running: string, done: string, failed: string];

/**
 * Turns an internal tool call into a neutral activity with an optional fixed
 * display identity. Arguments and targets never reach titles. The title matches the
 * call's status, so a finished or failed call never shows as still running.
 */
export function describeTool(
	toolName: string,
	args: unknown,
	status: ActivityStatus = "running",
	workspace?: string,
): { kind: ActivityKind; title: string; tool?: ActivityTool; target?: string } {
	const name = toolName.toLowerCase();
	const tool = ACTIVITY_TOOLS.find((known) => known === name);
	const fileArgs = args && typeof args === "object" && !Array.isArray(args)
		? args as Record<string, unknown> : undefined;
	const target = tool && ["read", "write", "edit"].includes(tool)
		? safeRelativeTarget(workspace, fileArgs?.path ?? fileArgs?.file_path ?? fileArgs?.filePath)
		: undefined;
	const titled = (kind: ActivityKind, titles: Tense) => ({
		kind,
		...(tool ? { tool } : {}),
		...(target ? { target } : {}),
		title: status === "running" ? titles[0] : status === "done" ? titles[1] : titles[2],
	});
	if (name === "read")
		return titled(
			"read",
			["Reading a file", "Read a file", "Could not read a file"],
		);
	if (name === "write" || name === "edit")
		return titled(
			"edit",
			["Editing a file", "Edited a file", "Could not edit a file"],
		);
	if (name === "bash") return titled("run", ["Running a command", "Ran a command", "A command failed"]);
	if (name.startsWith("mem_save") || name === "mem_update" || name === "mem_session_summary")
		return titled("memory", ["Saving a note", "Saved a note", "Could not save a note"]);
	if (name.startsWith("mem_"))
		return titled("memory", ["Checking my notes", "Checked my notes", "Could not check my notes"]);
	if (name.startsWith("subagent_"))
		return titled("delegate", ["Asking a helper", "Asked a helper", "Could not ask a helper"]);
	if (["web_search", "fetch_content", "get_search_content", "source_check"].includes(name))
		return titled("search", [
			"Looking things up online",
			"Looked things up online",
			"Could not look things up online",
		]);
	if (["grep", "find", "ls"].includes(name) || name.startsWith("codegraph"))
		return titled("search", ["Searching files", "Searched files", "Could not search files"]);
	if (name.startsWith("ask_user")) return titled("other", ["Asking you", "Asked you", "Could not ask you"]);
	return titled("other", ["Working", "Finished", "Failed"]);
}

/** Plain text of a user or assistant message whose content is a string or content blocks. */
export function textOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) => {
			const b = block as { type?: string; text?: unknown };
			return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
		})
		.join("");
}
