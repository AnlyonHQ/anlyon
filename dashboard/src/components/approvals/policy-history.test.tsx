/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { ApiError } from "@/lib/api-client";
import type { ApprovalPolicyVersion } from "@/lib/types";
import { PolicyHistory } from "./policy-history";

const versionsQuery = vi.hoisted(() => vi.fn());
const versionQuery = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/api/use-actor-names", async () => {
	const { describeActor } = await import("@/lib/actor-label");
	return {
		useActorNames: () => (actor: Parameters<typeof describeActor>[0]) =>
			describeActor(actor),
	};
});

vi.mock("@/hooks/api/use-approval-policies", () => ({
	useApprovalPolicyVersions: versionsQuery,
	useApprovalPolicyVersion: versionQuery,
}));

const pages = (
	list: ApprovalPolicyVersion[][],
	earliestVersion: number,
	extra: Record<string, unknown> = {},
) => ({
	data: {
		pages: list.map((data, i) => ({
			data,
			pagination: {
				limit: 50,
				nextBefore:
					i === list.length - 1 && !extra.hasNextPage
						? null
						: data.at(-1)?.version,
				earliestVersion,
				latestVersion: list[0][0]?.version ?? 1,
			},
		})),
	},
	hasNextPage: false,
	isFetchingNextPage: false,
	fetchNextPage: vi.fn(),
	...extra,
});

const entry = (
	version: number,
	operation: ApprovalPolicyVersion["operation"],
	overrides: Partial<ApprovalPolicyVersion> = {},
): ApprovalPolicyVersion => ({
	policyId: "apol_refund",
	version,
	operation,
	snapshot: {
		name: "refunds",
		effect: "require_approval",
		match_kind: "action",
		match_action_name: "refund_order",
		min_amount: version * 100,
		required_approvals: 1,
	},
	contentHash: `hash_${version}`,
	actor: null,
	changeNote: null,
	createdAt: "2026-09-27T00:00:00Z",
	...overrides,
});

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
	versionQuery.mockReturnValue({});
});
afterEach(() => {
	cleanup();
	versionsQuery.mockReset();
	versionQuery.mockReset();
});

const items = () =>
	within(screen.getByRole("list", { name: "Policy versions" })).getAllByRole(
		"listitem",
	);

describe("PolicyHistory", () => {
	it("lists retained versions newest first with actor, note and stored rule", () => {
		versionsQuery.mockReturnValue(
			pages(
				[
					[
						entry(5, "deleted", { actor: { type: "api_key", id: "key_ci" } }),
						entry(4, "updated", {
							actor: { type: "user", id: "usr_ops" },
							changeNote: "FIN-42",
						}),
						entry(3, "baseline"),
					],
				],
				3,
			),
		);
		render(<PolicyHistory policyId="apol_refund" workspaceId="ws_1" />);
		const [deleted, updated, baseline] = items();
		expect(deleted.textContent).toContain("v5");
		expect(deleted.textContent).toContain("By API key key_ci");
		expect(updated.textContent).toContain("By User usr_ops");
		expect(updated.textContent).toContain("“FIN-42”");
		expect(updated.textContent).toContain(
			"Action: refund_order · amount ≥ 400",
		);
		expect(baseline.textContent).toContain("By Not recorded");
		expect(baseline.textContent).toContain(
			"Earlier versions were not recorded",
		);
		expect(
			screen.queryByRole("button", { name: "Show older versions" }),
		).toBeNull();
	});

	it("loads older pages on request", () => {
		const fetchNextPage = vi.fn();
		versionsQuery.mockReturnValue(
			pages([[entry(90, "updated"), entry(89, "updated")]], 1, {
				hasNextPage: true,
				fetchNextPage,
			}),
		);
		render(<PolicyHistory policyId="apol_refund" workspaceId="ws_1" />);
		screen.getByRole("button", { name: "Show older versions" }).click();
		expect(fetchNextPage).toHaveBeenCalledTimes(1);
	});

	it("marks the version a decision used when it is on a loaded page", () => {
		versionsQuery.mockReturnValue(
			pages([[entry(2, "updated"), entry(1, "created")]], 1),
		);
		render(
			<PolicyHistory
				highlightVersion={1}
				policyId="apol_refund"
				workspaceId="ws_1"
			/>,
		);
		const current = items().filter((item) => item.getAttribute("aria-current"));
		expect(current).toHaveLength(1);
		expect(current[0].textContent).toContain("Used by this decision");
		expect(current[0].textContent).toContain("v1");
		expect(versionQuery).toHaveBeenLastCalledWith(
			"ws_1",
			"apol_refund",
			undefined,
		);
	});

	it("fetches and pins a decision's version that is not on a loaded page", () => {
		versionsQuery.mockReturnValue(
			pages([[entry(90, "updated"), entry(89, "updated")]], 1, {
				hasNextPage: true,
			}),
		);
		versionQuery.mockReturnValue({ data: entry(12, "updated") });
		render(
			<PolicyHistory
				highlightVersion={12}
				policyId="apol_refund"
				workspaceId="ws_1"
			/>,
		);
		expect(versionQuery).toHaveBeenLastCalledWith("ws_1", "apol_refund", 12);
		const pinned = within(
			screen.getByRole("list", { name: "Version used by the decision" }),
		).getByRole("listitem");
		expect(pinned.textContent).toContain("v12");
		expect(pinned.textContent).toContain("Used by this decision");
	});

	it("says when the decision's version predates retained history, without fetching it", () => {
		versionsQuery.mockReturnValue(pages([[entry(3, "baseline")]], 3));
		render(
			<PolicyHistory
				highlightVersion={2}
				policyId="apol_refund"
				workspaceId="ws_1"
			/>,
		);
		expect(screen.getByText(/predates retained history/)).toBeTruthy();
		expect(versionQuery).toHaveBeenLastCalledWith(
			"ws_1",
			"apol_refund",
			undefined,
		);
	});

	it("says when a retained-range version is missing", () => {
		versionsQuery.mockReturnValue(
			pages([[entry(9, "updated")]], 1, { hasNextPage: true }),
		);
		versionQuery.mockReturnValue({ error: new ApiError("Not found", 404) });
		render(
			<PolicyHistory
				highlightVersion={5}
				policyId="apol_refund"
				workspaceId="ws_1"
			/>,
		);
		expect(
			screen.getByText(/v5 is not in this policy's retained history/),
		).toBeTruthy();
	});

	it("distinguishes no retained history from a failed load", () => {
		versionsQuery.mockReturnValue({ error: new ApiError("Not found", 404) });
		render(<PolicyHistory policyId="apol_gone" workspaceId="ws_1" />);
		expect(
			screen.getByText("No history is retained for this policy."),
		).toBeTruthy();
		cleanup();
		versionsQuery.mockReturnValue({ error: new ApiError("Server error", 500) });
		render(<PolicyHistory policyId="apol_gone" workspaceId="ws_1" />);
		expect(screen.getByRole("alert").textContent).toContain("Server error");
	});
});
