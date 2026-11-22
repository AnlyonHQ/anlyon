/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import type { SignOffRequest } from "@/lib/sign-offs";
import { SignOffChanges, SignOffDecision } from "./sign-off-review";

const request: SignOffRequest = {
	object: "sign_off_request",
	id: "sor_1",
	status: "pending",
	operation: "impact_limit.update",
	environmentId: "env_1",
	resource: { type: "impact_limit", id: "lim_1", name: "Daily refunds" },
	summary: 'Raise impact limit "Daily refunds" from 50000 to 200000',
	changes: [
		{
			field: "amount",
			from: 50000,
			to: 200000,
			direction: "loosening",
			reason: "Raises a limit.",
		},
		{ field: "window", from: "1d", to: "12h", direction: "tightening" },
		{ field: "label", from: null, to: "refunds", direction: "neutral" },
	],
	diff: "- amount: 50000\n+ amount: 200000",
	requestedBy: { type: "api_key", id: "key_1", onBehalfOf: null },
	createdAt: "2026-10-28T10:00:00Z",
	expiresAt: "2099-10-29T10:00:00Z",
	decidedAt: null,
	decidedBy: null,
	decisionNote: null,
	result: null,
	error: null,
};

describe("SignOffChanges", () => {
	it("shows each field before and after, with which way it moves", () => {
		render(<SignOffChanges changes={request.changes} />);
		const rows = screen.getAllByTestId("sign-off-change");
		expect(rows).toHaveLength(3);

		const amount = within(rows[0]);
		expect(amount.getByText("amount")).toBeTruthy();
		expect(amount.getByText((50000).toLocaleString())).toBeTruthy();
		expect(amount.getByText((200000).toLocaleString())).toBeTruthy();
		expect(amount.getByText("loosens")).toBeTruthy();
		expect(amount.getByText("Raises a limit.")).toBeTruthy();

		expect(within(rows[1]).getByText("tightens")).toBeTruthy();

		const label = within(rows[2]);
		expect(label.queryByText("loosens")).toBeNull();
		expect(label.queryByText("tightens")).toBeNull();
		expect(label.getByText("none")).toBeTruthy();
	});
});

function renderDecision(
	overrides: Partial<Parameters<typeof SignOffDecision>[0]> = {},
) {
	const onDecide = vi.fn();
	render(
		<SignOffDecision
			canDecide
			onDecide={onDecide}
			pending={false}
			signOff={request}
			{...overrides}
		/>,
	);
	return { onDecide };
}

describe("SignOffDecision", () => {
	it("asks once more, naming the change, before it approves", () => {
		const { onDecide } = renderDecision();
		expect(
			screen.getByText(
				"Your agent asked for this. It cannot approve its own request; a person in this workspace has to.",
			),
		).toBeTruthy();

		fireEvent.change(screen.getByLabelText("Note (optional)"), {
			target: { value: "  ok for the sale  " },
		});
		fireEvent.click(screen.getByRole("button", { name: /Approve and apply/ }));
		expect(onDecide).not.toHaveBeenCalled();

		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText(request.summary)).toBeTruthy();
		expect(
			within(dialog).getByText("This loosens what the agent may do. Apply it?"),
		).toBeTruthy();

		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
		expect(onDecide).toHaveBeenCalledTimes(1);
		expect(onDecide.mock.calls[0][0]).toEqual({
			decision: "approve",
			note: "ok for the sale",
		});
	});

	it("rejects without a confirmation", () => {
		const { onDecide } = renderDecision();
		fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "reject",
			note: undefined,
		});
	});

	it("shows the server's message when the role may not decide", () => {
		renderDecision({
			error: new ApiError(
				"Your role may not decide sign-offs.",
				403,
				"FORBIDDEN",
			),
		});
		expect(screen.getByRole("alert").textContent).toBe(
			"Your role may not decide sign-offs.",
		);
	});

	it("offers no buttons to a role that cannot decide", () => {
		renderDecision({ canDecide: false });
		expect(screen.getByTestId("sign-off-not-allowed")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
	});

	it("is read-only once applied, with what was applied", () => {
		renderDecision({
			decidedByName: "Sam Rivera",
			signOff: {
				...request,
				status: "applied",
				decidedAt: "2026-10-28T11:00:00Z",
				decidedBy: { type: "user", id: "user_1", via: "console" },
				result: { id: "lim_1", amount: 200000 },
			},
		});
		expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
		const outcome = screen.getByTestId("sign-off-outcome");
		expect(within(outcome).getByText("Applied")).toBeTruthy();
		expect(within(outcome).getByText("Sam Rivera")).toBeTruthy();
		expect(screen.getByTestId("sign-off-result").textContent).toContain(
			'"amount": 200000',
		);
	});

	it("says nothing changed when applying failed", () => {
		renderDecision({
			signOff: {
				...request,
				status: "failed",
				decidedAt: "2026-10-28T11:00:00Z",
				decidedBy: { type: "user", id: "user_1", via: "email_link" },
				error: { code: "TARGET_CHANGED", message: "The limit changed since." },
			},
		});
		expect(screen.getByText("The limit changed since.")).toBeTruthy();
		expect(
			screen.getByText("Nothing changed. Your agent can ask again."),
		).toBeTruthy();
	});
});
