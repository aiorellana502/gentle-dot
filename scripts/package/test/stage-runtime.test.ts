import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { TARGETS } from "../lib.mjs";

const script = readFileSync(new URL("../stage-runtime.mjs", import.meta.url), "utf8");
const copyFunction = script.slice(
	script.indexOf("function installNativeAddon("),
	script.indexOf("/** The Engram release"),
);

// Exercise the actual copy function without running downloads, npm, or main().
function harness(missing: boolean) {
	const directories: string[] = [];
	const copies: string[] = [];
	const modes: number[] = [];
	const install = runInNewContext(`(${copyFunction.trim()})`, {
		REPO: join(import.meta.dirname, "absent-addon-source"),
		TARGETS: { ...TARGETS, "win32-x64": { platform: "win32", arch: "x64" } },
		join,
		mkdirSync: (path: string) => directories.push(path),
		copyFileSync: (source: string, destination: string) => {
			if (missing) copyFileSync(source, destination);
			copies.push(destination);
		},
		chmodSync: (_path: string, mode: number) => modes.push(mode),
	});
	return { install, directories, copies, modes };
}

describe("native addon staging", () => {
	it.each(Object.keys(TARGETS))("skips %s even with no addon artifacts", (target) => {
		const { install, directories, copies, modes } = harness(true);
		expect(() => install("output", target)).not.toThrow();
		expect(directories).toEqual([]);
		expect(copies).toEqual([]);
		expect(modes).toEqual([]);
	});

	it("preserves the four artifact copies and permissions for a future Windows target", () => {
		const { install, directories, copies, modes } = harness(false);
		install("output", "win32-x64");
		const destination = join("output", "daemon", "node_modules", "@gentle-dot", "pipe-bridge-windows");
		expect(directories).toEqual([destination]);
		expect(copies).toEqual(
			["package.json", "index.js", "index.d.ts", "pipe-bridge-windows.win32-x64-msvc.node"].map((name) =>
				join(destination, name),
			),
		);
		expect(modes).toEqual([0o644, 0o644, 0o644, 0o755]);
	});
});
