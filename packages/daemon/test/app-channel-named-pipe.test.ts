import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AppChannel, NamedPipeDuplex, openNamedPipeChannel } from "../src/app-channel.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const pending = deferred<Buffer | null>();
	const server = {
		read: vi.fn(() => pending.promise),
		write: vi.fn(async (_data: Buffer) => {}),
		close: vi.fn(),
	};
	return { pending, server, stream: new NamedPipeDuplex(server) };
}

describe("verified named-pipe channel", () => {
	it("rejects non-Windows before loading the native addon", async () => {
		await expect(
			openNamedPipeChannel({
				platform: "linux",
				pipeName: "unused",
				expectedServerPid: 1,
				expectedServerCreatedAt: 1n,
				timeoutMs: 5000,
			}),
		).rejects.toThrow("only supported on Windows");
	});
	it("frames requests and responses through the duplex", async () => {
		const { pending, server, stream } = fixture();
		const channel = new AppChannel(stream);
		const answer = channel.request("example", {}, 1000);
		await Promise.resolve();
		expect(server.write).toHaveBeenCalledWith(
			Buffer.from('{"kind":"request","id":1,"method":"example","params":{}}\n'),
		);
		pending.resolve(Buffer.from('{"kind":"response","id":1,"result":{"ok":true}}\n'));
		expect(await answer).toEqual({ ok: true });
		channel.close();
		expect(server.close).toHaveBeenCalledTimes(1);
	});
	it("dispatches peer requests and writes framed responses", async () => {
		const { server, stream } = fixture();
		server.read.mockResolvedValueOnce(
			Buffer.from('{"kind":"request","id":7,"method":"echo","params":{"ok":true}}\n'),
		);
		const channel = new AppChannel(stream);
		channel.handler = (_method, params) => params;
		try {
			await vi.waitFor(() =>
				expect(server.write).toHaveBeenCalledWith(
					Buffer.from('{"kind":"response","id":7,"result":{"ok":true}}\n'),
				),
			);
		} finally {
			channel.close();
		}
	});
	it("does not submit overlapping reads and closes promptly with pending IO", async () => {
		const { server, stream } = fixture();
		stream._read(1);
		stream._read(1);
		await Promise.resolve();
		expect(server.read).toHaveBeenCalledTimes(1);
		expect(server.read).toHaveBeenCalledWith(64 * 1024);
		const closed = once(stream, "close");
		stream.destroy();
		await closed;
		expect(server.close).toHaveBeenCalledTimes(1);
	});
	it("ends cleanly on EOF", async () => {
		const { pending, server, stream } = fixture();
		const ended = once(stream, "end");
		const closed = once(stream, "close");
		stream.resume();
		pending.resolve(null);
		await ended;
		await closed;
		expect(server.close).toHaveBeenCalledTimes(1);
	});
	it.each(["read", "write"] as const)("destroys on rejected %s", async (direction) => {
		const { pending, server, stream } = fixture();
		const error = new Error("native failure");
		const failed = once(stream, "error");
		if (direction === "read") {
			stream.resume();
			pending.reject(error);
		} else {
			server.write.mockRejectedValueOnce(error);
			stream.write("test");
		}
		expect((await failed)[0]).toBe(error);
		expect(stream.destroyed).toBe(true);
		expect(server.close).toHaveBeenCalledTimes(1);
	});
	it("serializes writes", async () => {
		const { server, stream } = fixture();
		const first = deferred<void>();
		server.write.mockImplementationOnce(() => first.promise);
		stream.write("one");
		const completed = new Promise<void>((resolve, reject) =>
			stream.write("two", (error) => (error ? reject(error) : resolve())),
		);
		await Promise.resolve();
		expect(server.write).toHaveBeenCalledTimes(1);
		first.resolve();
		await completed;
		expect(server.write.mock.calls.map(([data]) => data.toString())).toEqual(["one", "two"]);
		stream.destroy();
	});
	it.skipIf(process.platform !== "win32")(
		"uses the real verified native pipe for framed exchange",
		async () => {
			const ticks = BigInt(
				execFileSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`,
					],
					{ encoding: "utf8" },
				).trim(),
			);
			const name = `\\\\.\\pipe\\gentle-dot-channel-${process.pid}-${Date.now()}`;
			const listener = createServer();
			let peer: Socket | undefined;
			let channel: AppChannel | undefined;
			try {
				listener.listen(name);
				await once(listener, "listening");
				const connection = once(listener, "connection");
				channel = await openNamedPipeChannel({
					pipeName: name,
					expectedServerPid: process.pid,
					expectedServerCreatedAt: ticks,
					timeoutMs: 5000,
				});
				[peer] = (await connection) as [Socket];
				peer.on("error", () => {});
				peer.on("data", (bytes) => {
					const frame = JSON.parse(bytes.toString());
					peer?.write(`${JSON.stringify({ kind: "response", id: frame.id, result: { ok: true } })}\n`);
				});
				expect(await channel.request("example", {}, 5000)).toEqual({ ok: true });
			} finally {
				channel?.close();
				peer?.destroy();
				if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
			}
		},
		15000,
	);
});
