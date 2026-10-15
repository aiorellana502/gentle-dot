const assert = require("node:assert/strict");
const test = require("node:test");

const { identityMatches, connectVerified } = require("./index.js");

test("matches only when both pid and exact BigInt creation time agree", () => {
	assert.equal(identityMatches(100, 5000n, 100, 5000n), true);
	assert.equal(identityMatches(100, 5000n, 101, 5000n), false);
	assert.equal(identityMatches(100, 5000n, 100, 5001n), false);
	assert.equal(identityMatches(1, 133700000000000001n, 1, 133700000000000002n), false);
	assert.equal(identityMatches(0xffffffff, (1n << 64n) - 1n, 0xffffffff, (1n << 64n) - 1n), true);
});

test("rejects invalid binding arguments and out-of-range FILETIME", () => {
	assert.throws(() => identityMatches("1", 1n, 1, 1n));
	assert.throws(() => identityMatches(1, 1, 1, 1n));
	assert.throws(() => identityMatches(1, 1n, 1));
	for (const invalid of [-1n, 1n << 64n]) {
		assert.throws(() => identityMatches(1, invalid, 1, invalid), /InvalidFileTime/);
	}
});

test("async connect rejects a missing pipe without blocking the JS caller", async () => {
	const pending = connectVerified(`\\\\.\\pipe\\gentle-dot-missing-${process.pid}`, process.pid, 1n, 50);
	assert.equal(typeof pending.then, "function");
	await assert.rejects(pending, /PipeConnectionRefused: CreateFileW/);
});

test("connect validates local pipe names and deadline before opening", () => {
	assert.throws(() => connectVerified("not-a-pipe", 1, 1n, 100), /InvalidPipeName/);
	assert.throws(() => connectVerified("\\\\.\\pipe\\test\0suffix", 1, 1n, 100), /InvalidPipeName/);
	assert.throws(() => connectVerified("\\\\.\\pipe\\test", 1, -1n, 100), /InvalidFileTime/);
});

test("zero timeout rejects through the async API", async () => {
	await assert.rejects(connectVerified("\\\\.\\pipe\\test", 1, 1n, 0), /PipeConnectTimeout/);
});
