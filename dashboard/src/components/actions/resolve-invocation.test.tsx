/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResolveInvocation } from "./resolve-invocation";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api/use-actions", () => ({
	useResolveInvocation: () => ({ mutate, isPending: false }),
}));

afterEach(() => {
	cleanup();
	mutate.mockReset();
});

const open = () =>
	render(<ResolveInvocation invocationId="inv_1" workspaceId="ws_1" />);
const outcome = () =>
	screen.getByLabelText("What does the destination show?") as HTMLSelectElement;
const evidence = () => screen.getByLabelText("What you checked");
const record = () =>
	fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));

describe("ResolveInvocation", () => {
	it("has no default outcome and refuses to record without one", () => {
		open();
		expect(outcome().value).toBe("");
		fireEvent.change(evidence(), {
			target: { value: "Checked the provider dashboard." },
		});
		record();
		expect(mutate).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toMatch(/Choose what/);
	});

	it("requires real evidence", () => {
		open();
		fireEvent.change(outcome(), { target: { value: "failed" } });
		fireEvent.change(evidence(), { target: { value: "  checked  " } });
		record();
		expect(mutate).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toMatch(/at least 10/);
	});

	it("records the confirmed outcome with trimmed evidence and reference", () => {
		open();
		fireEvent.change(outcome(), { target: { value: "failed" } });
		fireEvent.change(evidence(), {
			target: { value: "  Stripe shows no charge for order 4417.  " },
		});
		fireEvent.change(
			screen.getByLabelText("Reference at the destination (optional)"),
			{ target: { value: " order_4417 " } },
		);
		record();
		expect(mutate.mock.calls[0][0]).toEqual({
			invocationId: "inv_1",
			outcome: "failed",
			evidence: "Stripe shows no charge for order 4417.",
			externalReference: "order_4417",
		});
	});

	it("shows the server's refusal, for example a non-admin or an already resolved call", () => {
		mutate.mockImplementation((_input, { onError }) =>
			onError(new Error("Only a workspace admin can perform this action")),
		);
		open();
		fireEvent.change(outcome(), { target: { value: "succeeded" } });
		fireEvent.change(evidence(), {
			target: { value: "Provider shows charge ch_42 captured." },
		});
		record();
		expect(screen.getByRole("alert").textContent).toBe(
			"Only a workspace admin can perform this action",
		);
	});

	it("clears a validation message as soon as the missing input is provided", () => {
		open();
		record();
		expect(screen.getByRole("alert").textContent).toMatch(/Choose what/);
		fireEvent.change(outcome(), { target: { value: "failed" } });
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
