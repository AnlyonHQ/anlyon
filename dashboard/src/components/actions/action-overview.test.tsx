/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, ApprovalPolicy, ImpactLimit } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	policies: [] as unknown[],
	limits: [] as unknown[],
	calls: [] as unknown[],
	update: vi.fn(),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => () => true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useSecrets: () => ({ data: [] }),
	useInvocations: () => ({ data: { data: mocks.calls } }),
	useUpdateAction: () => ({ mutate: mocks.update, isPending: false }),
	useDeleteAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/api/use-approval-policies", () => ({
	useApprovalPolicies: () => ({ data: mocks.policies }),
}));
vi.mock("@/hooks/api/use-effects", () => ({
	useImpactLimits: () => ({ data: mocks.limits }),
}));
vi.mock("@/components/approvals/policy-form-dialog", () => ({
	PolicyFormDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));
vi.mock("@/components/actions/declarations-form", () => ({
	DeclarationsForm: () => <div>declarations form</div>,
	AdapterDeclarations: () => <div>adapter declarations</div>,
}));

import { ActionControls, ActionOverview } from "./action-overview";

const action = {
	id: "act_1",
	name: "refund-order",
	description: "Refund part or all of one order.",
	environmentId: "env_1",
	method: "POST",
	urlTemplate: "https://api.example.com/refunds",
	headers: { Authorization: "Bearer {{secret:SHOP_KEY}}" },
	bodyTemplate: { amount: "{{input.amount}}" },
	inputSchema: {
		type: "object",
		properties: { amount: { type: "integer" }, orderId: { type: "string" } },
		required: ["amount", "orderId"],
	},
	requiresApproval: false,
	enabled: true,
	secrets: ["SHOP_KEY"],
	adapter: null,
	governed: true,
	impact: {
		dimension: "money",
		unit: "usd",
		amount: "input.amount",
		bound: "exact",
	},
	verify: {
		url: "https://api.example.com/refunds/{{response.id}}",
		status: 200,
		match: [],
	},
	createdAt: "2026-10-12T00:00:00.000Z",
	updatedAt: "2026-10-12T00:00:00.000Z",
} as unknown as Action;

const policy = {
	id: "apol_1",
	environmentId: "env_1",
	name: "Approve refunds over $100",
	priority: 100,
	enabled: true,
	scope: "specific_action",
	needsScopeReview: false,
	match: {
		kind: "action",
		actionName: "refund-order",
		agentId: null,
		userId: null,
		tags: null,
		minAmount: null,
		conditions: null,
		condition: "input.amount > 10000",
	},
	effect: "require_approval",
	requiredApprovals: 1,
	version: 1,
	scopeReviewedAt: null,
	createdAt: "",
	updatedAt: "",
} as ApprovalPolicy;

const limit = {
	id: "lim_1",
	name: "Refunds per day",
	dimension: "money",
	currency: "usd",
	unit: "usd",
	scope: { environmentId: "env_1", actionName: null, resourcePrefix: null },
	period: "day",
	limit: 50000,
	currentPeriod: "day:2026-10-12",
	consumed: 2500,
	reserved: 0,
	unknownExposure: 0,
	available: 47500,
	archived: false,
	createdAt: "",
	updatedAt: "",
} as ImpactLimit;

describe("Action panel", () => {
	beforeEach(() => {
		mocks.policies = [];
		mocks.limits = [];
		mocks.calls = [];
		mocks.update.mockReset();
	});
	afterEach(cleanup);

	it("says what the action does and what keeps it safe, in words", () => {
		mocks.policies = [policy];
		mocks.limits = [limit];
		mocks.calls = [
			{
				id: "inv_1",
				status: "pending_approval",
				createdAt: "2026-10-12T21:09:00Z",
			},
		];
		render(<ActionOverview action={action} workspaceId="ws" />);

		expect(screen.getByText(/sends a POST request to/).textContent).toContain(
			"api.example.com",
		);
		expect(
			screen.getByText(
				"A person approves calls where amount is more than $100.00",
			),
		).toBeTruthy();
		expect(screen.getByText("$25.00 of $500.00 used today")).toBeTruthy();
		expect(screen.getByText("Checked after every call")).toBeTruthy();
		expect(screen.getByText("Waiting for approval")).toBeTruthy();
		expect(screen.queryByText("act_1")).toBeNull();
		expect(screen.queryByText(/"Authorization"/)).toBeNull();
	});

	it("an action with no policy says it runs without approval and offers one", () => {
		render(<ActionOverview action={action} workspaceId="ws" />);
		expect(screen.getByText("Runs without approval")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Require approval" }),
		).toBeTruthy();
		expect(screen.getByText("No limit counts these calls")).toBeTruthy();
		expect(screen.getByText(/No calls yet/)).toBeTruthy();
	});

	it("turns the action off without deleting it", () => {
		render(
			<ActionControls action={action} onDeleted={() => {}} workspaceId="ws" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
		expect(mocks.update).toHaveBeenCalledWith({
			ref: "refund-order",
			workspaceId: "ws",
			enabled: false,
		});
	});

	it("keeps the technical details one click away", async () => {
		render(<ActionOverview action={action} workspaceId="ws" />);
		fireEvent.click(screen.getByRole("button", { name: /Technical details/ }));
		expect(await screen.findByText("act_1")).toBeTruthy();
		expect(screen.getByText(/"Authorization"/)).toBeTruthy();
	});
});
