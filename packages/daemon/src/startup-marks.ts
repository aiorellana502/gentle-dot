/**
 * Fixed startup breadcrumbs. When the event loop stops turning, the only reliable question is what
 * it was doing at that instant: every synchronous call keeps the last mark, so the stall watchdog can
 * name the step instead of guessing. Names are a closed vocabulary, never user data.
 */
let activity = "startup.import";
let since = Date.now();

/** Records the step that is starting now. Cheap by design: no I/O, no allocation of note. */
export function mark(name: string): void {
	activity = name;
	since = Date.now();
}

/** The last recorded step and how long ago it started. */
export function currentActivity(): { name: string; ageMs: number } {
	return { name: activity, ageMs: Date.now() - since };
}

/**
 * An HTTP entry mark from a closed set of route names: request paths and queries can carry file
 * names or user text, so no part of the URL itself reaches the diagnostics.
 */
export function markHttp(url: string | undefined): void {
	const path = (url ?? "").split("?")[0] ?? "";
	let route = "static";
	if (path === "/health") route = "health";
	else if (path === "/ws") route = "ws";
	else if (path === "/upload") route = "upload";
	else if (path.startsWith("/mcp/")) route = "mcp";
	mark(`http:${route}`);
}

/** A bounded, filtered entry mark: nothing a client sends reaches the diagnostics verbatim. */
export function markEntry(prefix: string, text: string | undefined): void {
	const clean = (text ?? "").replace(/[^A-Za-z0-9/_.:-]/g, "").slice(0, 24);
	mark(clean === "" ? prefix : `${prefix}:${clean}`);
}
