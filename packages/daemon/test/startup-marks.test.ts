import { expect, test } from "vitest";
import { currentActivity, markEntry, markHttp } from "../src/startup-marks.ts";

test.each([
	["/health", "http:health"],
	["/ws", "http:ws"],
	["/upload", "http:upload"],
	["/mcp/connector-secret-name/tools", "http:mcp"],
	["/", "http:static"],
	["/assets/index-1a2b3c.js", "http:static"],
	["/?q=private-query-text", "http:static"],
	["/C:/Users/someone/Documents/private.txt", "http:static"],
	["/health?token=synthetic-canary", "http:health"],
	[undefined, "http:static"],
	["not a url at all %%%", "http:static"],
])("HTTP entry %s is recorded only as a fixed route name", (url, expected) => {
	markHttp(url);
	expect(currentActivity().name).toBe(expected);
});

test("app channel entries keep their filtered method name", () => {
	markEntry("app", "connector.set");
	expect(currentActivity().name).toBe("app:connector.set");
	markEntry("app", undefined);
	expect(currentActivity().name).toBe("app");
});
