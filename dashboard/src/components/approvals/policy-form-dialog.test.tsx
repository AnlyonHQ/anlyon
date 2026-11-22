/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPolicy } from "@/lib/types";
import { PolicyFormDialog } from "./policy-form-dialog";

const createMutate = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({
		data: [
			{ id: "env_dev", name: "Development" },
			{ id: "env_stg", name: "Staging" },
		],
	}),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useEnvironmentActions: (_w?: string, environmentId?: string) => ({
		isLoading: false,
		data:
			environmentId === "env_dev"
				? [
						{ id: "a1", name: "refund_order" },
						{ id: "a2", name: "get_order" },
						{
							id: "a4",
							name: "refund_money",
							description: "Refund part or all of one order.",
							impact: {
								dimension: "money",
								unit: "usd",
								amount: "input.amount",
								bound: "exact",
							},
							inputSchema: {
								type: "object",
								properties: {
									amount: { type: "integer" },
									reason: { type: "string", enum: ["duplicate", "fraud"] },
								},
							},
						},
					]
				: [{ id: "a3", name: "staging_only" }],
	}),
}));

const assistRequests = vi.hoisted(() => [] as unknown[]);
vi.mock("@/hooks/api/use-approval-policies", () => ({
	useCreateApprovalPolicy: () => ({ mutate: createMutate, isPending: false }),
	useUpdateApprovalPolicy: () => ({ mutate: updateMutate, isPending: false }),
	useDraftCondition: () => ({ mutate: vi.fn(), isPending: false }),
	useConditionAssist: (_w: string, request: Record<string, unknown> | null) => {
		assistRequests.push(request);
		const condition = request?.condition as string | null | undefined;
		return {
			isFetching: false,
			error: null,
			data: request
				? {
						check: condition
							? condition.includes("ammount")
								? { valid: false, message: "No such key: ammount" }
								: { valid: true }
							: null,
						sample: null,
						inputFields: [
							{
								path: "input.amount",
								type: "double",
								optional: false,
								description: null,
							},
							{
								path: "input.currency",
								type: "string",
								optional: true,
								description: null,
							},
						],
						facts: [],
						legacyCondition: request.policyId
							? 'has(input.amount) && type(input.amount) == double && input.amount >= 50.01 && has(input.currency) && input.currency == "USD"'
							: null,
					}
				: undefined,
		};
	},
}));

afterEach(() => {
	cleanup();
	createMutate.mockReset();
	updateMutate.mockReset();
	assistRequests.length = 0;
});

function openSimple(initial?: { environmentId?: string; actionName?: string }) {
	render(
		<PolicyFormDialog
			initial={initial}
			trigger={<button type="button">open</button>}
			workspaceId="ws_1"
		/>,
	);
	fireEvent.click(screen.getByText("open"));
}

const openAdvanced = () =>
	fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));

function open(initial?: { environmentId?: string; actionName?: string }) {
	openSimple(initial);
	openAdvanced();
}

const createButton = () =>
	screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
const field = (label: string) =>
	screen.getByLabelText(label) as HTMLSelectElement | HTMLInputElement;

describe("PolicyFormDialog", () => {
	it("keeps edits when dismissing is cancelled and discards them only explicitly", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(field("Name"), {
			target: { value: "Unsaved refund rule" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(
			screen.getByText("Discard your unsaved policy changes?"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
		expect(field("Name").value).toBe("Unsaved refund rule");
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByText("open"));
		openAdvanced();
		expect(field("Name").value).toBe("Approve refund_order every time");
	});

	it("searches schema fields and replaces the selected expression text at the cursor", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		const editor = screen.getByLabelText(
			"Condition (optional)",
		) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "PLACEHOLDER >= 500" } });
		editor.setSelectionRange(0, 11);
		fireEvent.change(screen.getByLabelText("Search available fields"), {
			target: { value: "amount" },
		});
		fireEvent.change(field("Name"), { target: { value: "Refund rule" } });
		fireEvent.keyDown(screen.getByLabelText("Search available fields"), {
			key: "Enter",
		});
		expect(createMutate).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /input.currency/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /input.amount/ }));
		expect(editor.value).toBe("input.amount >= 500");
	});

	it("defaults to a specific action, so a deny cannot silently apply to everything", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		await waitFor(() =>
			expect((field("Matches") as HTMLSelectElement).value).toBe(
				"specific_action",
			),
		);
		expect((field("Action") as HTMLSelectElement).value).toBe("refund_order");
	});

	it("shows the confirmation sentence built from the choices", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		await waitFor(() => screen.getByTestId("policy-intent"));
		fireEvent.change(field("What happens"), { target: { value: "auto_deny" } });
		expect(screen.getByTestId("policy-intent").textContent).toBe(
			"Deny refund_order requests in Development.",
		);
	});

	it("submits matchKind action and the exact action name", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		await waitFor(() => screen.getByLabelText("Name"));
		fireEvent.change(field("Name"), {
			target: { value: "refund_order_denied" },
		});
		fireEvent.change(field("What happens"), { target: { value: "auto_deny" } });
		fireEvent.click(createButton());
		expect(createMutate).toHaveBeenCalledTimes(1);
		expect(createMutate.mock.calls[0][0]).toMatchObject({
			name: "refund_order_denied",
			environmentId: "env_dev",
			matchKind: "action",
			matchActionName: "refund_order",
			effect: "auto_deny",
		});
		expect(createMutate.mock.calls[0][0]).not.toHaveProperty(
			"acknowledgeBroadScope",
		);
	});

	it("clears the action when the environment changes", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		await waitFor(() => screen.getByLabelText("Environment"));
		fireEvent.change(field("Environment"), { target: { value: "env_stg" } });
		expect((field("Action") as HTMLSelectElement).value).toBe("");
		fireEvent.change(field("Name"), { target: { value: "p" } });
		fireEvent.click(createButton());
		expect(createMutate).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toMatch(/Choose the action/);
	});

	it("requires explicit confirmation before a broad auto-deny", async () => {
		open({ environmentId: "env_dev" });
		await waitFor(() => screen.getByLabelText("Name"));
		fireEvent.change(field("Name"), { target: { value: "deny_all" } });
		fireEvent.change(field("What happens"), { target: { value: "auto_deny" } });
		fireEvent.change(field("Matches"), {
			target: { value: "all_requests" },
		});
		fireEvent.click(createButton());
		expect(createMutate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("checkbox"));
		const create = createButton();
		expect(create.disabled).toBe(false);
		fireEvent.click(create);
		expect(createMutate.mock.calls[0][0]).toMatchObject({
			matchKind: "any",
			acknowledgeBroadScope: true,
		});
	});

	it("stays open and shows the server's message when saving fails, and closes only on success", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		await waitFor(() => screen.getByLabelText("Name"));
		fireEvent.change(field("Name"), { target: { value: "p" } });
		fireEvent.click(createButton());

		const { onError, onSuccess } = createMutate.mock.calls[0][1];
		onError(
			new Error('A policy named "p" already exists in this environment.'),
		);
		await waitFor(() => screen.getByRole("alert"));
		expect(screen.getByRole("alert").textContent).toMatch(/already exists/);
		expect(screen.queryByText("Create approval policy")).not.toBeNull();

		onSuccess();
		await waitFor(() =>
			expect(screen.queryByText("Create approval policy")).toBeNull(),
		);
	});
});

describe("policy condition", () => {
	const legacyPolicy: ApprovalPolicy = {
		id: "apol_refund",
		environmentId: "env_dev",
		name: "refunds",
		priority: 100,
		enabled: true,
		scope: "specific_action",
		needsScopeReview: false,
		match: {
			kind: "action",
			actionName: "refund_order",
			minAmount: 50.01,
			agentId: "agent_support",
			userId: null,
			tags: null,
			conditions: { currency: "USD" },
			condition: null,
		},
		effect: "require_approval",
		requiredApprovals: 1,
		version: 2,
		scopeReviewedAt: null,
		createdAt: "",
		updatedAt: "",
	};
	const conditionField = () =>
		screen.getByLabelText("Condition (optional)") as HTMLTextAreaElement;
	const openEdit = (policy: ApprovalPolicy) => {
		render(
			<PolicyFormDialog
				policy={policy}
				trigger={<button type="button">open</button>}
				workspaceId="ws_1"
			/>,
		);
		fireEvent.click(screen.getByText("open"));
		openAdvanced();
	};
	const save = () =>
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

	it("no longer offers a payments-only minimum amount field", () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		expect(screen.queryByLabelText(/Minimum amount/)).toBeNull();
		expect(conditionField()).toBeTruthy();
	});

	it("creates a policy with a trimmed CEL condition and shows it in the summary", () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(field("Name"), { target: { value: "big refunds" } });
		fireEvent.change(conditionField(), {
			target: { value: '  input.amount >= 500 && input.currency == "USD"  ' },
		});
		fireEvent.click(createButton());
		expect(createMutate.mock.calls[0][0].condition).toBe(
			'input.amount >= 500 && input.currency == "USD"',
		);
		expect(screen.getByTestId("policy-intent").textContent).toContain(
			'Only when: input.amount >= 500 && input.currency == "USD".',
		);
	});

	it("omits the condition on create when it is empty", () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(field("Name"), { target: { value: "all refunds" } });
		fireEvent.click(createButton());
		expect(createMutate.mock.calls[0][0]).not.toHaveProperty("condition");
	});

	it("inserts an action field at the cursor from its chip", () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.click(screen.getByRole("button", { name: /input\.currency/ }));
		expect(conditionField().value).toBe("input.currency");
	});

	it("adds a template without discarding what was written", () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(conditionField(), {
			target: { value: "input.amount > 1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "One of" }));
		expect(conditionField().value).toBe(
			'(input.amount > 1) && has(input.currency) && input.currency in ["prod", "staging"]',
		);
	});

	it("keeps legacy restrictions untouched on an edit that does not convert them", () => {
		openEdit(legacyPolicy);
		expect(
			screen.getByText(
				/older fields: amount ≥ 50\.01; payload\["currency"\] equals "USD"/,
			),
		).toBeTruthy();
		save();
		const patch = updateMutate.mock.calls[0][0];
		expect(patch.condition).toBeNull();
		for (const key of [
			"minAmount",
			"conditions",
			"matchAgentId",
			"matchUserId",
			"matchTags",
		]) {
			expect(patch).not.toHaveProperty(key);
		}
	});

	it("converts legacy fields into one condition and clears them in the same save", () => {
		openEdit(legacyPolicy);
		fireEvent.click(
			screen.getByRole("button", { name: "Convert to a condition" }),
		);
		expect(conditionField().value).toContain("input.amount >= 50.01");
		save();
		expect(updateMutate.mock.calls[0][0]).toMatchObject({
			condition: expect.stringContaining('input.currency == "USD"'),
			minAmount: null,
			conditions: null,
		});
		expect(updateMutate.mock.calls[0][0]).not.toHaveProperty("matchAgentId");
	});

	it("checks the target action's schema through the server and reports its message", async () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(conditionField(), {
			target: { value: "input.ammount > 5" },
		});
		await waitFor(() =>
			expect(screen.getByText("No such key: ammount")).toBeTruthy(),
		);
		expect(assistRequests.at(-1)).toMatchObject({
			environmentId: "env_dev",
			matchKind: "action",
			matchActionName: "refund_order",
			condition: "input.ammount > 5",
		});
	});
});

describe("policy change note", () => {
	const note = () => field("Change note (optional)");
	const policy: ApprovalPolicy = {
		id: "apol_refund",
		environmentId: "env_dev",
		name: "refunds",
		priority: 100,
		enabled: true,
		scope: "specific_action",
		needsScopeReview: false,
		match: {
			kind: "action",
			actionName: "refund_order",
			minAmount: null,
			agentId: null,
			userId: null,
			tags: null,
			conditions: null,
		},
		effect: "require_approval",
		requiredApprovals: 1,
		version: 3,
		scopeReviewedAt: null,
		createdAt: "",
		updatedAt: "",
	};

	it("records a trimmed note with a new policy", () => {
		open({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(field("Name"), { target: { value: "refunds" } });
		fireEvent.change(note(), { target: { value: "  FIN-42 threshold  " } });
		fireEvent.click(createButton());
		expect(createMutate.mock.calls[0][0].changeNote).toBe("FIN-42 threshold");
	});

	it("records a note with an edit and omits a blank one", () => {
		render(
			<PolicyFormDialog
				policy={policy}
				trigger={<button type="button">open</button>}
				workspaceId="ws_1"
			/>,
		);
		fireEvent.click(screen.getByText("open"));
		openAdvanced();
		const save = () =>
			fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		fireEvent.change(note(), { target: { value: "   " } });
		save();
		expect(updateMutate.mock.calls[0][0]).not.toHaveProperty("changeNote");
		fireEvent.change(note(), { target: { value: "Raise after review" } });
		save();
		expect(updateMutate.mock.calls[1][0].changeNote).toBe("Raise after review");
	});
});

describe("policy form, simple path", () => {
	it("needs only an action and a comparison: environment and name are filled in", async () => {
		openSimple();
		await waitFor(() =>
			expect(screen.getByText(/In/).textContent).toContain("Development"),
		);
		fireEvent.change(field("Action"), { target: { value: "refund_money" } });
		expect(screen.getByText("Refund part or all of one order.")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Only when"));
		expect(field("Field").value).toBe("amount");
		fireEvent.change(field("Comparison"), { target: { value: ">" } });
		fireEvent.change(field("Value"), { target: { value: "100" } });
		expect(screen.getByTestId("policy-intent").textContent).toBe(
			"Require approval for refund_money requests in Development. Only when amount is more than $100.00.",
		);
		fireEvent.click(createButton());
		expect(createMutate.mock.calls[0][0]).toMatchObject({
			name: "Approve refund_money when amount is more than $100.00",
			environmentId: "env_dev",
			effect: "require_approval",
			matchKind: "action",
			matchActionName: "refund_money",
			condition: "input.amount > 10000",
		});
	});

	it("will not save Only when without a value", () => {
		openSimple({ environmentId: "env_dev", actionName: "refund_money" });
		fireEvent.click(screen.getByLabelText("Only when"));
		fireEvent.click(createButton());
		expect(screen.getByRole("alert").textContent).toMatch(
			/Enter a value for the condition/,
		);
		expect(createMutate).not.toHaveBeenCalled();
	});

	it("offers a choice field's values, and Every call removes the condition", () => {
		openSimple({ environmentId: "env_dev", actionName: "refund_money" });
		fireEvent.click(screen.getByLabelText("Only when"));
		fireEvent.change(field("Field"), { target: { value: "reason" } });
		fireEvent.change(field("Value"), { target: { value: "fraud" } });
		expect(screen.getByTestId("policy-intent").textContent).toContain(
			"Only when reason is “fraud”.",
		);
		fireEvent.click(screen.getByLabelText("Every call"));
		fireEvent.click(createButton());
		expect(createMutate.mock.calls[0][0]).not.toHaveProperty("condition");
	});

	it("reads an existing simple condition back into the builder when editing", async () => {
		render(
			<PolicyFormDialog
				policy={{
					id: "apol_big",
					environmentId: "env_dev",
					name: "Big refunds",
					priority: 100,
					enabled: true,
					scope: "specific_action",
					needsScopeReview: false,
					match: {
						kind: "action",
						actionName: "refund_money",
						minAmount: null,
						agentId: null,
						userId: null,
						tags: null,
						conditions: null,
						condition: "input.amount > 10000",
					},
					effect: "require_approval",
					requiredApprovals: 1,
					version: 1,
					scopeReviewedAt: null,
					createdAt: "",
					updatedAt: "",
				}}
				trigger={<button type="button">open</button>}
				workspaceId="ws_1"
			/>,
		);
		fireEvent.click(screen.getByText("open"));
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Only when") as HTMLInputElement).checked,
			).toBe(true),
		);
		expect(field("Value").value).toBe("100.00");
	});

	it("shows a hand-written condition it cannot read, and keeps it", () => {
		openSimple({ environmentId: "env_dev", actionName: "refund_money" });
		openAdvanced();
		fireEvent.change(
			screen.getByLabelText("Condition (optional)") as HTMLTextAreaElement,
			{ target: { value: "input.amount > 1 && input.reason == 'fraud'" } },
		);
		expect(
			screen.getByText("A condition written by hand applies:"),
		).toBeTruthy();
		fireEvent.click(createButton());
		expect(createMutate.mock.calls[0][0].condition).toBe(
			"input.amount > 1 && input.reason == 'fraud'",
		);
	});
});

describe("Who decides", () => {
	it("defaults to the team and sends nothing extra for a new policy", async () => {
		openSimple({ environmentId: "env_dev", actionName: "refund_order" });
		expect(field("Decided by").value).toBe("team");
		fireEvent.click(createButton());
		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate.mock.calls[0][0]).not.toHaveProperty("decidedBy");
	});

	it("lets the end user decide a held call", async () => {
		openSimple({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(field("Decided by"), { target: { value: "end_user" } });
		expect(screen.getByText(/decides in your app/)).toBeTruthy();
		fireEvent.click(createButton());
		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
		expect(createMutate.mock.calls[0][0]).toMatchObject({
			effect: "require_approval",
			decidedBy: "end_user",
		});
	});

	it("is not asked when nobody is asked", () => {
		openSimple({ environmentId: "env_dev", actionName: "refund_order" });
		fireEvent.change(field("What happens"), { target: { value: "auto_deny" } });
		expect(screen.queryByLabelText("Decided by")).toBeNull();
	});
});
