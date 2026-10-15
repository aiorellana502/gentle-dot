const assert = require("node:assert/strict");
const test = require("node:test");

const { identityMatches, connectVerified } = require("./index.js");
const net = require("node:net");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sequence = 0;
let createdAt;

async function duplexFixture(t) {
	// Independent OS FILETIME oracle; never round creation ticks through a JS Number.
	createdAt ??= BigInt(execFileSync("powershell.exe", [
		"-NoProfile", "-NonInteractive", "-Command",
		`(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`,
	], { encoding: "utf8" }).trim());
	const name = `\\\\.\\pipe\\gentle-dot-duplex-node-${process.pid}-${sequence++}`;
	const listener = net.createServer();
	let native;
	let peer;
	t.after(async () => {
		native?.close();
		peer?.destroy();
		if (listener.listening) await new Promise((resolve) => listener.close(resolve));
	});
	listener.listen(name);
	await once(listener, "listening");
	const connection = once(listener, "connection");
	native = await connectVerified(name, process.pid, createdAt, 5000);
	[peer] = await connection;
	peer.on("error", () => {}); // Teardown/cancellation may reset the peer.
	return { native, peer };
}

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

test("real async concurrent duplex preserves every byte and snapshots writes", { timeout: 15000 }, async (t) => {
	const { native, peer } = await duplexFixture(t);
	assert.equal(native.isAlive(), true);
	const expected = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 256));
	const chunks = [];
	let received = 0;
	peer.on("data", (chunk) => {
		chunks.push(chunk);
		received += chunk.length;
		if (received === expected.length) {
			assert.deepEqual(Buffer.concat(chunks), expected);
			peer.write(expected);
		}
	});
	const firstRead = native.read(8192);
	assert.equal(typeof firstRead.then, "function");
	const source = Buffer.from(expected);
	const writing = native.write(source);
	assert.equal(typeof writing.then, "function");
	source.fill(0); // Kernel must not observe later JS mutation.
	const returned = [];
	let count = 0;
	let reading = firstRead;
	while (count < expected.length) {
		const chunk = await reading;
		assert.ok(Buffer.isBuffer(chunk));
		returned.push(chunk);
		count += chunk.length;
		if (count < expected.length) reading = native.read(8192);
	}
	assert.equal(await writing, undefined);
	assert.deepEqual(Buffer.concat(returned), expected);
	peer.destroy();
	assert.equal(await native.read(1), null);
	await assert.rejects(native.write(Buffer.from([1])), /PipeBroken:/);
	native.close();
	native.close();
	assert.equal(native.isAlive(), false);
	await assert.rejects(native.read(1), /PipeClosed:/);
	await assert.rejects(native.write(Buffer.alloc(0)), /PipeClosed:/);
});

test("read overlap rejects and cancelRead leaves writes usable", { timeout: 15000 }, async (t) => {
	const { native, peer } = await duplexFixture(t);
	for (const size of [0, -1, 1.5, NaN, Infinity, 16777217]) {
		assert.throws(() => native.read(size), /InvalidReadSize:/);
	}
	const pending = native.read(1);
	const cancelled = assert.rejects(pending, /PipeCancelled:/);
	await assert.rejects(native.read(1), /PipeBusy:/);
	await delay(50);
	native.cancelRead();
	native.cancelRead();
	await cancelled;
	await assert.rejects(native.read(1), /PipeCancelled:/);
	const data = once(peer, "data");
	await native.write(Buffer.from("still writable"));
	assert.equal((await data)[0].toString(), "still writable");
});

test("write overlap rejects and cancelWrite leaves reads usable", { timeout: 15000 }, async (t) => {
	const { native, peer } = await duplexFixture(t);
	peer.pause();
	let settled = false;
	const pending = native.write(Buffer.alloc(8 * 1024 * 1024, 42));
	const cancelled = assert.rejects(pending.finally(() => { settled = true; }), /PipeCancelled:/);
	await assert.rejects(native.write(Buffer.from([1])), /PipeBusy:/);
	await delay(50);
	assert.equal(settled, false);
	native.cancelWrite();
	native.cancelWrite();
	await cancelled;
	await assert.rejects(native.write(Buffer.from([1])), /PipeCancelled:/);
	peer.write(Buffer.from("r"));
	assert.deepEqual(await native.read(1), Buffer.from("r"));
});

for (const direction of ["read", "write"]) {
	test(`close promptly cancels pending ${direction}`, { timeout: 15000 }, async (t) => {
		const { native, peer } = await duplexFixture(t);
		peer.pause();
		let settled = false;
		const pending = direction === "read" ? native.read(1024) : native.write(Buffer.alloc(8 * 1024 * 1024));
		const cancelled = assert.rejects(pending.finally(() => { settled = true; }), /PipeCancelled:/);
		await delay(50);
		assert.equal(settled, false);
		const before = performance.now();
		native.close();
		assert.ok(performance.now() - before < 500, "close must not wait for settlement");
		await cancelled;
		assert.equal(native.isAlive(), false);
	});
}
