/* @vitest-environment jsdom */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionDraft } from "@/hooks/api/use-approval-policies";
import { ConditionDraftPanel } from "./condition-draft-panel";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api/use-approval-policies", () => ({
	useDraftCondition: () => ({ mutate, isPending: false }),
}));

afterEach(() => {
	cleanup();
	mutate.mockReset();
});

const onUse = vi.fn();
const open = () =>
	render(
		<ConditionDraftPanel
			environmentId="env_dev"
			matchActionName="refund_order"
			matchKind="action"
			onUse={onUse}
			workspaceId="ws_1"
		/>,
	);
const describeIt = (text: string) =>
	fireEvent.change(screen.getByLabelText("Describe it"), {
		target: { value: text },
	});
const respond = (draft: ConditionDraft) =>
	mutate.mockImplementation((_request, { onSuccess }) => onSuccess(draft));

describe("ConditionDraftPanel", () => {
	it("ignores an old draft when the description changes during the request", () => {
		open();
		describeIt("refunds above 500");
		fireEvent.click(screen.getByRole("button", { name: "Draft condition" }));
		const callbacks = mutate.mock.calls[0][1];
		describeIt("refunds above 900");
		act(() =>
			callbacks.onSuccess({
				condition: "input.amount > 500",
				check: { valid: true },
				usage: { used: 1, limit: 50 },
			}),
		);
		expect(screen.queryByTestId("condition-draft")).toBeNull();
	});

	it("drafts from the sentence for the chosen action and only uses it on request", () => {
		respond({
			condition: 'input.amount >= 50000 && input.currency == "USD"',
			check: { valid: true },
			usage: { used: 3, limit: 125 },
		});
		open();
		describeIt("  refunds over 500 dollars in USD ");
		fireEvent.click(screen.getByRole("button", { name: "Draft condition" }));
		expect(mutate.mock.calls[0][0]).toEqual({
			environmentId: "env_dev",
			matchKind: "action",
			matchActionName: "refund_order",
			request: "refunds over 500 dollars in USD",
		});
		expect(screen.getByTestId("condition-draft").textContent).toContain(
			"3 of 125 drafts used this month.",
		);
		expect(onUse).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Use this condition" }));
		expect(onUse).toHaveBeenCalledWith(
			'input.amount >= 50000 && input.currency == "USD"',
		);
	});

	it("drafts on Enter without submitting the surrounding policy form", () => {
		respond({
			condition: "true",
			check: { valid: true },
			usage: { used: 1, limit: 50 },
		});
		const formSubmit = vi.fn();
		render(
			// biome-ignore lint/a11y/noStaticElementInteractions: stands in for the dialog panel's Enter handler
			<div onKeyDown={(e) => e.key === "Enter" && formSubmit()}>
				<ConditionDraftPanel
					environmentId="env_dev"
					matchActionName="refund_order"
					matchKind="action"
					onUse={onUse}
					workspaceId="ws_1"
				/>
			</div>,
		);
		describeIt("everything");
		fireEvent.keyDown(screen.getByLabelText("Describe it"), { key: "Enter" });
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(formSubmit).not.toHaveBeenCalled();
	});

	it("shows a draft that fails the check with the reason, and a sentence that cannot be a condition", () => {
		respond({
			condition: "input.nope > 5",
			check: { valid: false, message: "No such key: nope" },
			usage: { used: 2, limit: 50 },
		});
		open();
		describeIt("anything over five");
		fireEvent.click(screen.getByRole("button", { name: "Draft condition" }));
		expect(
			screen.getByText(/does not pass the check: No such key: nope/),
		).toBeTruthy();

		respond({ condition: null, check: null, usage: { used: 3, limit: 50 } });
		fireEvent.click(screen.getByRole("button", { name: "Draft condition" }));
		expect(screen.getByText(/can't be written as a condition/)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Use this condition" }),
		).toBeNull();
	});

	it("shows the allowance or availability message from the server", () => {
		mutate.mockImplementation((_request, { onError }) =>
			onError(
				new Error(
					"This plan includes 50 policy drafts a month, and they are used up. You can still write conditions yourself.",
				),
			),
		);
		open();
		describeIt("anything over five");
		fireEvent.click(screen.getByRole("button", { name: "Draft condition" }));
		expect(screen.getByRole("alert").textContent).toMatch(
			/50 policy drafts a month/,
		);
	});

	it("asks for a real sentence before drafting", () => {
		open();
		describeIt("hi");
		fireEvent.click(screen.getByRole("button", { name: "Draft condition" }));
		expect(mutate).not.toHaveBeenCalled();
	});
});
