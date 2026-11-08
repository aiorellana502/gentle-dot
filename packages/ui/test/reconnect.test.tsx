import { listen } from "@tauri-apps/api/event";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import type { ConnectionInfo } from "../src/client.ts";
import { type DotState, initialState } from "../src/store.ts";

/**
 * A window the app refused recovers without a reopen (S35.2): once the app reports its assistant
 * ready (`dot://assistant-ready`, after Restart assistant or a slow start), the panel and the Dot
 * ask again and connect. Through the mocked Tauri commands and desktop events.
 */
const h = vi.hoisted(() => ({
	connection: undefined as unknown as () => Promise<unknown>,
	invoke: vi.fn(),
	listeners: new Map<string, () => void>(),
	infos: [] as (ConnectionInfo | undefined)[],
	state: undefined as unknown as DotState,
	registration: undefined as Promise<void> | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => true,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

// Initialize the event mock during collection, before panel/computer effects can
// concurrently import it. A real listen would call Tauri's absent transformCallback.
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
}));

vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async (name: string, handler: () => void) => {
		if (name === "dot://assistant-ready") await h.registration;
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: (info: ConnectionInfo | undefined) => {
		h.infos.push(info);
		return { state: h.state, send: () => {}, dismiss: () => {}, dispatch: () => {} };
	},
}));

const REFUSAL =
	"Another Gentle Dot assistant is already running on port 4317. Stop it, then choose Restart assistant.";
const INFO: ConnectionInfo = { url: "ws://127.0.0.1:4317/ws", token: "abc" };

// Cold App dependency loading belongs to collection, not the first render's
// five-second behavioral test. A timed-out late import can otherwise render after cleanup.
async function renderApp(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	return render(<App />);
}

const READY = "dot://assistant-ready";

async function reportReady() {
	await waitFor(() => expect(h.listeners.has(READY)).toBe(true));
	await act(async () => h.listeners.get(READY)?.());
}

beforeEach(() => {
	expect(vi.isMockFunction(listen)).toBe(true);
	h.listeners.clear();
	h.registration = undefined;
	h.infos = [];
	h.state = { ...initialState, connection: "closed", agentState: "idle" };
	h.connection = async () => {
		throw REFUSAL;
	};
	h.invoke = vi.fn(async (command: string) => {
		if (command === "connection_info") return h.connection();
		if (command === "computer_status") return { active: false };
		return null;
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("after the app refused its assistant (S35.2)", () => {
	it("keeps legacy no-argument callers compatible", async () => {
		const { connectionInfo } = await import("../src/desktop.ts");
		h.connection = async () => INFO;
		expect(await connectionInfo()).toEqual(INFO);
		expect(h.invoke).toHaveBeenCalledWith("connection_info", undefined);
	});

	it("labels initial, post-listener, and received-ready attempts in source order", async () => {
		let registered!: () => void;
		h.registration = new Promise<void>((resolve) => { registered = resolve; });
		await renderApp("?surface=panel");
		await screen.findByText(REFUSAL);
		const args = () => h.invoke.mock.calls.filter(([c]) => c === "connection_info").map(([, a]) => a);
		expect(args()).toEqual([{ source: "initial" }]);
		await act(async () => registered());
		await waitFor(() => expect(args()).toEqual([{ source: "initial" }, { source: "listener_recheck" }]));
		await reportReady();
		expect(args()).toEqual([{ source: "initial" }, { source: "listener_recheck" }, { source: "assistant_ready" }]);
		expect(h.infos.every((info) => info === undefined)).toBe(true);
		expect(screen.getByText(REFUSAL)).toHaveAttribute("role", "status");
	});
	it("keeps the opaque panel fallback on native startup failure", async () => {
		const timeout = "the assistant did not answer on port 4417";
		h.connection = async () => { throw timeout; };
		await renderApp("?surface=panel&effects=none");
		expect(await screen.findByText(timeout)).toHaveAttribute("role", "status");
		expect(screen.getByRole("status").closest(".chat")).toHaveClass("chat-panel");
		expect(document.documentElement.dataset.effects).toBe("none");
	}, 15_000);

	it("preserves the web error surface", async () => {
		await renderApp("");
		expect((await screen.findByText(REFUSAL)).closest(".chat")).toHaveClass("chat-web");
	});
	it("recovers a timed-out panel when readiness preceded asynchronous listener registration", async () => {
		let registered!: () => void;
		h.registration = new Promise<void>((resolve) => { registered = resolve; });
		const timeout = "the assistant did not answer on port 4317";
		h.connection = async () => { throw timeout; };
		await renderApp("?surface=panel");
		expect(await screen.findByText(timeout)).toHaveAttribute("role", "status");
		expect(h.infos.at(-1)).toBeUndefined();
		// The owned native starter succeeded, but the ready event had no listener yet.
		h.connection = async () => INFO;
		await act(async () => registered());
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		expect(screen.queryByText(timeout)).toBeNull();
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	}, 15_000);

	it("never adopts connection data while the native authenticated readiness gate refuses it", async () => {
		await renderApp("?surface=panel");
		expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
		await reportReady();
		expect(screen.getByText(REFUSAL)).toBeInTheDocument();
		expect(h.infos.every((info) => info === undefined)).toBe(true);
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("the panel connects once the app reports the assistant ready", async () => {
		await renderApp("?surface=panel");
		expect(await screen.findByText(REFUSAL)).toHaveAttribute("role", "status");
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		expect(screen.queryByText(REFUSAL)).toBeNull();
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("the Dot connects once the app reports the assistant ready", async () => {
		await renderApp("?surface=dot");
		await waitFor(() => expect(h.invoke.mock.calls.some(([c]) => c === "connection_info")).toBe(true));
		expect(h.infos.at(-1)).toBeUndefined();
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
	});

	it("a panel already connected keeps its connection when the app reports ready again", async () => {
		h.connection = async () => ({ ...INFO });
		await renderApp("?surface=panel");
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		const first = h.infos.at(-1);
		const calls = h.invoke.mock.calls.filter(([c]) => c === "connection_info").length;
		await reportReady();
		await waitFor(() => expect(h.invoke.mock.calls.filter(([c]) => c === "connection_info")).toHaveLength(calls + 1));
		expect(h.infos.at(-1)).toBe(first);
	});
});
