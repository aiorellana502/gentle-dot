import type { ClientMessage } from "@gentle-dot/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AskCard } from "../src/components/AskCard.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { MessageList } from "../src/components/MessageList.tsx";
import { type DotState, initialState } from "../src/store.ts";

function state(overrides: Partial<DotState> = {}): DotState {
	return { ...initialState, connection: "open", agentState: "idle", ...overrides };
}

describe("Composer", () => {
	it("sends on Enter and keeps a new line on Shift+Enter", async () => {
		const send = vi.fn<(message: ClientMessage) => void>();
		render(<Composer busy={false} disabled={false} send={send} />);
		const box = screen.getByRole("textbox", { name: "Message" });
		await userEvent.type(box, "first line{Shift>}{Enter}{/Shift}second{Enter}");
		expect(send).toHaveBeenCalledTimes(1);
		const sent = send.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ type: "send", text: "first line\nsecond" });
		expect(sent && "requestId" in sent && sent.requestId).toBeTruthy();
		expect(box).toHaveValue("");
	});

	it("does not send blank text", async () => {
		const send = vi.fn();
		render(<Composer busy={false} disabled={false} send={send} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "   {Enter}");
		expect(send).not.toHaveBeenCalled();
	});

	it("offers Stop while the assistant works", async () => {
		const send = vi.fn();
		render(<Composer busy disabled={false} send={send} />);
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(send).toHaveBeenCalledWith({ type: "abort" });
	});
});

describe("AskCard", () => {
	it("answers a select with the chosen option", async () => {
		const send = vi.fn();
		render(
			<AskCard
				ask={{ requestId: "q1", method: "select", title: "Pick a color", options: ["Red", "Blue"] }}
				send={send}
			/>,
		);
		expect(screen.getByText("Pick a color")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Blue" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "q1", value: "Blue" });
	});

	it("answers a confirm with yes or no", async () => {
		const send = vi.fn();
		render(
			<AskCard
				ask={{ requestId: "q2", method: "confirm", title: "Proceed?", message: "It is safe" }}
				send={send}
			/>,
		);
		expect(screen.getByText("It is safe")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "No" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "q2", confirmed: false });
	});

	it("shows a long approval preview in full, in its own scrollable block (A3)", () => {
		const message = `The assistant wants to create pages in Notion.\n\nbody: ${"z".repeat(7900)}`;
		render(
			<AskCard
				ask={{ requestId: "q4", method: "confirm", title: "Allow Notion to create pages?", message }}
				send={vi.fn()}
			/>,
		);
		const preview = screen.getByRole("region", { name: "Details" });
		expect(preview).toHaveClass("ask-message");
		expect(preview.textContent).toBe(message);
		// Keyboard users can scroll it too.
		expect(preview).toHaveAttribute("tabindex", "0");
	});

	it("answers an input with typed text and can be dismissed", async () => {
		const send = vi.fn();
		render(
			<AskCard
				ask={{ requestId: "q3", method: "input", title: "Your name", placeholder: "Name" }}
				send={send}
			/>,
		);
		await userEvent.type(screen.getByPlaceholderText("Name"), "Ada");
		await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "q3", value: "Ada" });
		await userEvent.click(screen.getByRole("button", { name: "Skip" }));
		expect(send).toHaveBeenLastCalledWith({ type: "ui_response", requestId: "q3", cancelled: true });
	});
});

describe("MessageList", () => {
	it("shows safe relative file targets but rejects malformed display metadata", async () => {
		const targets = ["src/app.ts", undefined, "/CANARY", "C:\\CANARY", "../CANARY", "//CANARY/share", "src/CANARY?x", "src/CANARY#x", "src/../CANARY", "src\\CANARY", "src/\nCANARY", ".", "C:CANARY"];
		const activities = targets.map((target, i) => ({
			id: String(i), kind: "read" as const, tool: "read" as const,
			title: "CANARY raw title", target, status: "done" as const,
		}));
		activities.push({ ...activities[0]!, id: "unknown", tool: "connector_CANARY" as "read", target: "CANARY" });
		const { container } = render(<MessageList messages={[
			{ id: "m", role: "assistant", text: "A", streaming: false, activities },
		]} />);
		await userEvent.click(screen.getByRole("button", { name: /Read 14 files/ }));
		expect(screen.getByText("read · src/app.ts · Completed")).toBeInTheDocument();
		expect(screen.getAllByText("read · Completed")).toHaveLength(12);
		expect(screen.getByText("Tool · Completed")).toBeInTheDocument();
		expect(container.innerHTML).not.toContain("CANARY");
	});

	it("shows safe identity and textual outcomes without legacy title leakage", async () => {
		const activities = [
			{ id: "a", kind: "read" as const, title: "CANARY/path", tool: "read" as const, status: "running" as const },
			{ id: "b", kind: "run" as const, title: "CANARY command", tool: "bash" as const, status: "done" as const },
			{ id: "c", kind: "other" as const, title: "CANARY error", status: "failed" as const },
		];
		const { container, rerender } = render(<MessageList messages={[
			{ id: "m", role: "assistant", text: "Answer", streaming: false, activities },
		]} />);
		const summary = screen.getByRole("button", { name: "Running" });
		expect(summary).toHaveAttribute("aria-expanded", "false");
		expect(container.innerHTML).not.toContain("CANARY");
		summary.focus();
		await userEvent.keyboard("{Enter}");
		expect(summary).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("read · Running")).toBeInTheDocument();
		expect(screen.getByText("bash · Completed")).toBeInTheDocument();
		expect(screen.getByText("Tool · Failed")).toBeInTheDocument();
		rerender(<MessageList messages={[
			{ id: "m", role: "assistant", text: "Answer", streaming: false,
				activities: activities.map((a) => ({ ...a, status: "done" })) },
		]} />);
		expect(screen.getByRole("button", { name: "Read 1 file · Ran 1 command · Did 1 step" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		expect(container.innerHTML).not.toContain("CANARY");
	});
	it("renders Markdown and summarizes activities", async () => {
		render(
			<MessageList
				messages={[
					{ id: "u1", role: "user", text: "check it", streaming: false, activities: [] },
					{
						id: "m1",
						role: "assistant",
						text: "All **good**",
						streaming: false,
						activities: [
							{ id: "a", kind: "read", title: "Read a.md", status: "done" },
							{ id: "b", kind: "read", title: "Read b.md", status: "done" },
							{ id: "c", kind: "run", title: "A command failed", status: "failed" },
						],
					},
				]}
			/>,
		);
		expect(screen.getByText("good").tagName).toBe("STRONG");
		const summary = screen.getByRole("button", { name: /Read 2 files · Ran 1 command/ });
		await userEvent.click(summary);
		expect(screen.getAllByText("Tool · Completed")).toHaveLength(2);
		expect(screen.getByText("Tool · Failed")).toBeInTheDocument();
		expect(screen.queryByText("Read b.md")).not.toBeInTheDocument();
	});

	it("never renders arbitrary tool identities from old or malicious payloads", async () => {
		const activities = ["connector_CANARY", "__proto__", "constructor", "READ"].map((tool, i) => ({
			id: String(i), kind: "other" as const, title: "CANARY", status: "done" as const,
			tool: tool as unknown as "read",
		}));
		const { container } = render(<MessageList messages={[
			{ id: "m", role: "assistant", text: "A", streaming: false, activities },
		]} />);
		await userEvent.click(screen.getByRole("button", { name: "Did 4 steps" }));
		expect(screen.getAllByText("Tool · Completed")).toHaveLength(4);
		expect(container.innerHTML).not.toContain("CANARY");
	});
});

describe("MessageList user text", () => {
	it("keeps the user's line breaks as typed", () => {
		const { container } = render(
			<MessageList
				messages={[{ id: "u1", role: "user", text: "first line\nsecond", streaming: false, activities: [] }]}
			/>,
		);
		const bubble = container.querySelector(".message-user .message-body");
		expect(bubble?.textContent).toBe("first line\nsecond");
		expect(bubble?.querySelector("p")).toBeNull();
		expect(bubble).toHaveClass("message-plain");
	});
});

describe("ChatSurface", () => {
	it("shows the interruption prompt and continues", async () => {
		const send = vi.fn();
		render(<ChatSurface variant="web" state={state({ interrupted: true })} send={send} dismiss={vi.fn()} />);
		expect(screen.getByText("I was interrupted. Continue?")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "send", text: "Continue where you left off." }),
		);
	});

	it("starts a new conversation and opens an earlier one", async () => {
		const send = vi.fn();
		render(
			<ChatSurface
				variant="web"
				state={state({
					features: { conversations: true },
					conversationId: "b.jsonl",
					conversations: [
						{ id: "b.jsonl", title: "Current", updatedAt: "2026-10-08T10:00:00.000Z" },
						{ id: "a.jsonl", title: "Trip plan", updatedAt: "2026-10-07T10:00:00.000Z" },
					],
				})}
				send={send}
				dismiss={vi.fn()}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Current" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
		expect(send).toHaveBeenCalledWith({ type: "new_conversation" });
		await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
		await userEvent.click(screen.getByRole("button", { name: /Trip plan/ }));
		expect(send).toHaveBeenCalledWith({ type: "open_conversation", conversationId: "a.jsonl" });
	});

	it("explains a lost connection and a rejected token", () => {
		const { rerender } = render(
			<ChatSurface variant="web" state={state({ connection: "closed" })} send={vi.fn()} dismiss={vi.fn()} />,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
		rerender(
			<ChatSurface
				variant="web"
				state={state({ connection: "unauthorized" })}
				send={vi.fn()}
				dismiss={vi.fn()}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Open the page again from the Gentle Dot menu");
	});

	it("shows notices that can be dismissed", () => {
		const dismiss = vi.fn();
		render(
			<ChatSurface
				variant="web"
				state={state({ notices: [{ id: 7, level: "error", message: "That did not work." }] })}
				send={vi.fn()}
				dismiss={dismiss}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(dismiss).toHaveBeenCalledWith(7);
	});
});
