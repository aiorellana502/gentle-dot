import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Logical display metadata only: workspace must be a trusted, normalized absolute
 * engine cwd. No filesystem access or symlink confinement is implied. UNC roots
 * are unsupported and fail closed, as do foreign-platform path spellings.
 */
export function safeRelativeTarget(workspace: string | undefined, rawPath: unknown): string | undefined {
	if (!workspace || !isAbsolute(workspace) || /^[\\/]{2}/.test(workspace)) return undefined;
	if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
	if (/[?#\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(rawPath)) return undefined;
	if (/^[\\/]{2}/.test(rawPath) || /^[a-z]:[^\\/]/i.test(rawPath)) return undefined;
	// Colons outside a rooted Windows drive can denote URLs or alternate streams.
	const local = sep === "\\" ? rawPath.replace(/^[a-z]:[\\/]/i, "") : rawPath;
	if (local.includes(":") || (sep !== "\\" && rawPath.includes("\\"))) return undefined;
	const target = relative(workspace, resolve(workspace, rawPath));
	if (!target || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return undefined;
	return target.split(sep).join("/");
}
