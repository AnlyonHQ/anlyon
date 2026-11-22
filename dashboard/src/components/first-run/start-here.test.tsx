/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartHereInput } from "@/lib/start-here";

const state = vi.hoisted(() => ({
	facts: {} as StartHereInput & { available: boolean; error: unknown },
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		...rest
	}: {
		children?: React.ReactNode;
		to: string;
		className?: string;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
}));
vi.mock("@/hooks/api/use-start-here", () => ({
	useStartHere: () => state.facts,
}));

import { StartHere } from "./start-here";

const facts = (input: StartHereInput) => {
	state.facts = { available: true, error: null, ...input };
};

const step = (id: string) =>
	document.querySelector(`[data-step="${id}"]`) as HTMLElement;

describe("StartHere", () => {
	beforeEach(() => {
		window.localStorage.clear();
		facts({});
	});

	it("says what Anlyon is for, then opens on the key in a new workspace", () => {
		facts({
			apiKeys: 0,
			connectedUsers: 0,
			usersWithCalls: 0,
			redirectUrlSet: false,
			actions: 0,
		});
		render(<StartHere workspaceId="ws_1" />);
		expect(screen.getByRole("heading", { name: "Start here" })).toBeTruthy();
		expect(
			screen.getByText(
				"Let your AI agent act in your users' own accounts, safely.",
			),
		).toBeTruthy();
		expect(screen.getByText("0 of 3")).toBeTruthy();
		expect(step("key").getAttribute("data-state")).toBe("next");
		expect(step("connect").getAttribute("data-state")).toBe("todo");
		const create = within(step("key")).getByRole("link", {
			name: /Create an API key/,
		});
		expect(create.getAttribute("href")).toBe("/settings/api-keys");
		expect(within(step("key")).getByText(/ANLYON_API_KEY/)).toBeTruthy();
		expect(within(step("connect")).queryByRole("link")).toBeNull();
		expect(
			screen
				.getByRole("link", { name: "Try the guided start" })
				.getAttribute("href"),
		).toBe("/get-started");
	});

	it("asks for the redirect URL before a user can connect", () => {
		facts({
			apiKeys: 1,
			connectedUsers: 0,
			usersWithCalls: 0,
			redirectUrlSet: false,
			actions: 0,
		});
		render(<StartHere workspaceId="ws_1" />);
		expect(step("key").getAttribute("data-state")).toBe("done");
		expect(within(step("key")).getByText("1 active key")).toBeTruthy();
		const connect = step("connect");
		expect(connect.getAttribute("data-state")).toBe("next");
		expect(
			within(connect)
				.getByRole("link", { name: /Set a redirect URL/ })
				.getAttribute("href"),
		).toBe("/integrations/settings");
		expect(
			within(connect).getByText(/No default redirect URL yet/),
		).toBeTruthy();
		expect(within(connect).getByText(/createConnectLink/)).toBeTruthy();
	});

	it("moves to the call once a user is connected, with a real action in the code", () => {
		facts({
			apiKeys: 1,
			connectedUsers: 2,
			usersWithCalls: 0,
			redirectUrlSet: true,
			actions: 3,
			exampleAction: "hubspot-update-deal",
		});
		render(<StartHere workspaceId="ws_1" />);
		expect(screen.getByText("2 of 3")).toBeTruthy();
		expect(within(step("connect")).getByText("2 users connected")).toBeTruthy();
		const call = step("call");
		expect(call.getAttribute("data-state")).toBe("next");
		expect(within(call).getByText("3 actions ready")).toBeTruthy();
		expect(
			within(call).getByText(/invoke\('hubspot-update-deal', input\)/),
		).toBeTruthy();
		expect(
			within(call)
				.getByRole("link", { name: /Open Invocations/ })
				.getAttribute("href"),
		).toBe("/actions/invocations");
	});

	it("sends the call step to Integrations when there is nothing to call", () => {
		facts({
			apiKeys: 1,
			connectedUsers: 1,
			usersWithCalls: 0,
			redirectUrlSet: true,
			actions: 0,
		});
		render(<StartHere workspaceId="ws_1" />);
		expect(
			within(step("call"))
				.getByRole("link", { name: /Add an integration/ })
				.getAttribute("href"),
		).toBe("/integrations");
	});

	it("shrinks to one line when all three are done, and hides for good", () => {
		facts({ apiKeys: 1, connectedUsers: 1, usersWithCalls: 1 });
		const { unmount } = render(<StartHere workspaceId="ws_1" />);
		expect(
			screen.getByRole("heading", { name: "You are set up" }),
		).toBeTruthy();
		expect(screen.queryByRole("list")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		expect(
			screen.queryByRole("heading", { name: "You are set up" }),
		).toBeNull();
		unmount();
		render(<StartHere workspaceId="ws_1" />);
		expect(document.querySelector('[data-slot="start-here"]')).toBeNull();
	});

	it("can be hidden before it is done", () => {
		facts({ apiKeys: 0, connectedUsers: 0, usersWithCalls: 0 });
		render(<StartHere workspaceId="ws_1" />);
		fireEvent.click(screen.getByRole("button", { name: "Hide Start here" }));
		expect(document.querySelector('[data-slot="start-here"]')).toBeNull();
		expect(window.localStorage.getItem("anlyon.start-here.hidden.ws_1")).toBe(
			"1",
		);
	});

	it("is absent on a build without users", () => {
		state.facts = { available: false, error: null };
		render(<StartHere workspaceId="ws_1" />);
		expect(document.querySelector('[data-slot="start-here"]')).toBeNull();
	});
});
