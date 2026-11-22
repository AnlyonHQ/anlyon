/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	effects: [] as unknown[],
}));

const blocker = vi.hoisted(() => ({
	status: "idle" as "idle" | "blocked",
	reset: vi.fn(),
	proceed: vi.fn(),
	lastDisabled: true as boolean | undefined,
	beforeUnload: false as boolean | undefined,
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useBlocker: (opts: { disabled?: boolean; enableBeforeUnload?: boolean }) => {
		blocker.lastDisabled = opts.disabled;
		blocker.beforeUnload = opts.enableBeforeUnload;
		return blocker;
	},
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useUpdateAction: () => ({ mutate: mocks.update, isPending: false }),
}));

vi.mock("@/hooks/api/use-effects", () => ({
	useEffects: () => ({ data: { data: mocks.effects }, isLoading: false }),
}));

import {
	AdapterDeclarations,
	DeclarationsForm,
	declarationsPayload,
	declarationValues,
} from "./declarations-form";

function action(overrides: Partial<Action> = {}): Action {
	return {
		id: "act_1",
		environmentId: "env_1",
		name: "send_email",
		description: null,
		method: "POST",
		urlTemplate: "https://api.example.com/emails",
		headers: {},
		bodyTemplate: null,
		inputSchema: {},
		requiresApproval: false,
		enabled: true,
		secrets: [],
		adapter: null,
		governed: false,
		impact: null,
		verify: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

const declared = action({
	governed: true,
	impact: {
		dimension: "emails",
		unit: "emails",
		amount: "count(input.to)",
		bound: "exact",
	},
	verify: {
		url: "https://api.example.com/emails/{{response.id}}",
		status: 200,
		match: [
			{ path: "data.status", equals: "sent" },
			{ path: "data.count", equals: 2 },
			{ path: "data.code", equals: "200" },
		],
	},
});

function payloadFor(
	current: Action,
	changes: Partial<ReturnType<typeof declarationValues>>,
) {
	return declarationsPayload(current, {
		...declarationValues(current),
		...changes,
	});
}

describe("declaration payload", () => {
	it("sends nothing when nothing changed, including a round trip of the match rule", () => {
		expect(payloadFor(declared, {})).toEqual({ payload: {} });
		expect(declarationValues(declared).verifyMatch).toBe(
			'data.status = sent\ndata.count = 2\ndata.code = "200"',
		);
	});

	it("sends only the declaration that changed, and omits the one to keep", () => {
		expect(payloadFor(declared, { bound: "upper_bound" })).toEqual({
			payload: {
				impact: {
					dimension: "emails",
					unit: "emails",
					amount: "count(input.to)",
					bound: "upper_bound",
				},
			},
		});
	});

	it("sends null to remove a declaration the action had", () => {
		expect(payloadFor(declared, { impactKind: "none" })).toEqual({
			payload: { impact: null },
		});
		expect(payloadFor(declared, { verifyUrl: "", verifyMatch: "" })).toEqual({
			payload: { verify: null },
		});
	});

	it("declares money in its currency and a declared unit in its own name", () => {
		expect(
			payloadFor(action(), {
				governed: true,
				impactKind: "money",
				currency: "USD",
				amount: " input.amount ",
			}),
		).toEqual({
			payload: {
				impact: {
					dimension: "money",
					unit: "usd",
					amount: "input.amount",
					bound: "exact",
				},
			},
		});
		expect(
			payloadFor(action(), {
				governed: true,
				impactKind: "declared",
				unit: "Rows",
				amount: "1",
			}),
		).toEqual({
			payload: {
				impact: {
					dimension: "rows",
					unit: "rows",
					amount: "1",
					bound: "exact",
				},
			},
		});
	});

	it("reads match values as typed: numbers, booleans, null, text and references", () => {
		const result = payloadFor(action(), {
			governed: true,
			verifyUrl: "https://api.example.com/items/{{input.id}}",
			verifyStatus: "200",
			verifyMatch:
				'state = done\ncount = 3\nok = true\ngone = null\ncode = "200"\nid = {{response.id}}',
		});
		expect(result).toEqual({
			payload: {
				verify: {
					url: "https://api.example.com/items/{{input.id}}",
					status: 200,
					match: [
						{ path: "state", equals: "done" },
						{ path: "count", equals: 3 },
						{ path: "ok", equals: true },
						{ path: "gone", equals: null },
						{ path: "code", equals: "200" },
						{ path: "id", equals: "{{response.id}}" },
					],
				},
			},
		});
	});

	it("says governed outright when nothing is declared, and false to stop governing", () => {
		expect(payloadFor(action(), { governed: true })).toEqual({
			payload: { governed: true },
		});
		expect(payloadFor(declared, { governed: false })).toEqual({
			payload: { governed: false },
		});
		expect(payloadFor(action(), {})).toEqual({ payload: {} });
	});

	it("names what is wrong instead of sending it", () => {
		expect(
			payloadFor(action(), {
				governed: true,
				impactKind: "declared",
				unit: "Bad Unit",
				amount: "",
				verifyUrl: "https://api.example.com/x",
				verifyStatus: "ok",
				verifyMatch: "no equals sign",
			}),
		).toEqual({
			errors: {
				unit: expect.stringContaining("lowercase"),
				amount: expect.stringContaining("amount"),
				verifyStatus: expect.stringContaining("status"),
				verifyMatch: expect.stringContaining("path = value"),
			},
		});
	});
});

describe("DeclarationsForm", () => {
	afterEach(cleanup);
	beforeEach(() => {
		mocks.update.mockReset();
		mocks.effects = [];
		blocker.status = "idle";
		blocker.reset.mockReset();
		blocker.proceed.mockReset();
	});

	it("guards navigation and tab close only while a declaration has unsaved edits", () => {
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		expect(blocker.lastDisabled).toBe(true);
		expect(blocker.beforeUnload).toBe(false);
		const amount = screen.getByLabelText("Amount");
		fireEvent.change(amount, { target: { value: "1" } });
		expect(blocker.lastDisabled).toBe(false);
		expect(blocker.beforeUnload).toBe(true);
		fireEvent.change(amount, { target: { value: "count(input.to)" } });
		expect(blocker.lastDisabled).toBe(true);
	});

	it("asks before leaving with unsaved edits, and leaves or stays as chosen", () => {
		blocker.status = "blocked";
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		expect(screen.getByText("Leave without saving?")).toBeTruthy();
		expect(
			screen.getByText(/what “send_email” declares are not saved/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Stay" }));
		expect(blocker.reset).toHaveBeenCalled();
		expect(blocker.proceed).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Leave without saving" }),
		);
		expect(blocker.proceed).toHaveBeenCalled();
	});

	it("shows the preview as always on, with no control to turn it off", () => {
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		expect(screen.getByText("Always on")).toBeTruthy();
		expect(
			screen.getByText(
				/Every approval binds to a digest of the reviewed request/,
			),
		).toBeTruthy();
		expect(screen.queryByRole("checkbox", { name: /preview/i })).toBeNull();
		expect(screen.queryByRole("switch")).toBeNull();
	});

	it("saves a removed impact as null and leaves verify out", async () => {
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		fireEvent.change(screen.getByLabelText("What it counts"), {
			target: { value: "none" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save declarations" }));
		await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
		expect(mocks.update.mock.calls[0][0]).toEqual({
			ref: "send_email",
			workspaceId: "ws",
			impact: null,
		});
	});

	it("puts the error beside its field, focuses it, and sends nothing", () => {
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		const amount = screen.getByLabelText("Amount");
		fireEvent.change(amount, { target: { value: " " } });
		fireEvent.click(screen.getByRole("button", { name: "Save declarations" }));
		expect(mocks.update).not.toHaveBeenCalled();
		expect(amount.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByRole("alert").id).toBe(
			amount.getAttribute("aria-describedby"),
		);
		expect(document.activeElement).toBe(amount);
	});

	it("shows the server's refusal when changing a governed action needs actions:govern", async () => {
		const refusal =
			'Changing what a governed action declares needs the "actions:govern" scope, which is not granted by default.';
		mocks.update.mockImplementation((_input, options) =>
			options.onError(new Error(refusal)),
		);
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		fireEvent.change(screen.getByLabelText("Bound"), {
			target: { value: "upper_bound" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save declarations" }));
		expect((await screen.findByRole("alert")).textContent).toBe(refusal);
	});

	it("does not send a request when nothing changed", () => {
		render(<DeclarationsForm action={declared} workspaceId="ws" />);
		fireEvent.click(screen.getByRole("button", { name: "Save declarations" }));
		expect(mocks.update).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("Nothing changed.");
	});
});

describe("AdapterDeclarations", () => {
	afterEach(cleanup);

	it("shows the adapter's impact and offers nothing to edit", () => {
		mocks.effects = [
			{
				impact: [
					{ dimension: "money", currency: "usd", amount: 1250, bound: "exact" },
					{ dimension: "resource_mutations", amount: 1, bound: "exact" },
				],
			},
		];
		render(
			<AdapterDeclarations
				action={action({
					governed: true,
					adapter: { type: "stripe.refund", config: {} },
				})}
				workspaceId="ws"
			/>,
		);
		expect(screen.getByText("stripe.refund")).toBeTruthy();
		expect(screen.getByText("12.50 USD, 1 resource change")).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(
			screen.getByText(
				/The action config names live or test mode, and the Stripe key must match it\./,
			),
		).toBeTruthy();
	});
});
