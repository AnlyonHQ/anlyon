/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApprovalInbox } from "./approval-inbox";

const useApprovals = vi.hoisted(() => vi.fn());
const decideMutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api/use-actor-names", async () => {
	const { describeActor } = await import("@/lib/actor-label");
	return {
		useActorNames: () => (actor: Parameters<typeof describeActor>[0]) =>
			describeActor(actor),
	};
});

vi.mock("@/hooks/api/use-approvals", () => ({
	useApprovals,
	useApprovalDetail: () => ({
		data: undefined,
		isLoading: false,
		isError: false,
	}),
	useDecideApproval: () => ({ mutate: decideMutate, isPending: false }),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		search,
		children,
		...rest
	}: {
		to: string;
		search: Record<string, string | number | undefined>;
		children: React.ReactNode;
	}) => (
		<a
			href={`${to}?${new URLSearchParams(
				Object.entries(search).flatMap(([k, v]) =>
					v === undefined ? [] : [[k, String(v)]],
				),
			)}`}
			{...rest}
		>
			{children}
		</a>
	),
}));

const previewRead = vi.hoisted(() => ({
	calls: [] as Array<
		[string | undefined, string | undefined, string | undefined]
	>,
	data: undefined as unknown,
	isError: false,
	error: undefined as unknown,
}));
vi.mock("@/hooks/api/use-effects", () => ({
	usePreview: (
		workspaceId?: string,
		environmentId?: string,
		previewId?: string,
	) => {
		previewRead.calls.push([workspaceId, environmentId, previewId]);
		return {
			data: previewId ? previewRead.data : undefined,
			isError: previewRead.isError,
			error: previewRead.error,
		};
	},
}));

const permission = vi.hoisted(() => ({
	allowed: ((_p: string, _env?: string | null) => true) as (
		permission: string,
		environmentId?: string | null,
	) => boolean,
	calls: [] as Array<[string, string | null | undefined]>,
}));
vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => (p: string, env?: string | null) => {
		permission.calls.push([p, env]);
		return permission.allowed(p, env);
	},
}));

const auditRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/hooks/api/use-assistant", () => ({
	useAuditQueue: () => ({
		data: auditRows.rows,
		isLoading: false,
		isError: false,
		isFetching: false,
	}),
	useAuditAdvice: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeAll(() => {
	window.matchMedia = ((query: string) => ({
		matches: true,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	cleanup();
	useApprovals.mockReset();
	auditRows.rows = [];
	previewRead.calls = [];
	previewRead.data = undefined;
	previewRead.isError = false;
	previewRead.error = undefined;
	decideMutate.mockReset();
	permission.allowed = () => true;
	permission.calls = [];
});

function respond(
	byParams: (p: Record<string, unknown>) => { total: number; rows?: unknown[] },
) {
	useApprovals.mockImplementation(
		(_w: string, params: Record<string, unknown>) => {
			const { total, rows } = byParams(params);
			return {
				data: { data: rows ?? [], pagination: { total, hasMore: false } },
				isLoading: false,
				isError: false,
				isFetching: false,
			};
		},
	);
}

describe("ApprovalInbox views and counts", () => {
	it("opens on pending human work only", () => {
		respond(() => ({ total: 0 }));
		render(<ApprovalInbox workspaceId="ws_1" />);
		const main = useApprovals.mock.calls.find(([, p]) => p.limit === 50);
		expect(main?.[1]).toMatchObject({ status: "pending" });
		expect(main?.[1]).not.toHaveProperty("decisionOrigin");
		expect(screen.getByText("No approvals waiting")).toBeTruthy();
	});

	it("counts approver rejections and policy denials separately", () => {
		respond((p) => ({
			total:
				p.decisionOrigin === "policy"
					? 100
					: p.decisionOrigin === "human"
						? 3
						: 0,
		}));
		render(<ApprovalInbox workspaceId="ws_1" />);
		expect(screen.getByTestId("denial-counts").textContent).toBe(
			"Approver rejections: 3 · Policy denials: 100",
		);
	});

	it("automated decisions are their own view, not part of the pending inbox", () => {
		respond(() => ({ total: 0 }));
		render(<ApprovalInbox workspaceId="ws_1" />);
		fireEvent.click(screen.getByRole("tab", { name: "Automated decisions" }));
		const asked = useApprovals.mock.calls.map(([, p]) => p);
		expect(
			asked.some((p) => p.decisionOrigin === "automated" && p.limit === 50),
		).toBe(true);
		fireEvent.click(screen.getByRole("tab", { name: "Approver history" }));
		expect(
			useApprovals.mock.calls
				.map(([, p]) => p)
				.some((p) => p.decisionOrigin === "human" && p.limit === 50),
		).toBe(true);
	});
	it("hides the audit tab until there is something to audit", () => {
		respond(() => ({ total: 0 }));
		render(<ApprovalInbox workspaceId="ws_1" />);
		expect(screen.queryByRole("tab", { name: /To audit/ })).toBeNull();
	});

	it("lists assistant decisions waiting for a person's check", () => {
		respond(() => ({ total: 0 }));
		auditRows.rows = [
			{
				id: "apr_1",
				workspaceId: "ws_1",
				kind: "action",
				status: "approved",
				decisionOrigin: "assistant",
				actionName: "refund_order",
				title: "Refund order 4417",
				createdAt: "2026-09-24T10:00:00Z",
				expiresAt: "2026-09-25T10:00:00Z",
				decidedAt: "2026-09-24T10:01:00Z",
			},
		];
		render(<ApprovalInbox workspaceId="ws_1" />);
		fireEvent.click(screen.getByRole("tab", { name: /To audit/ }));
		expect(screen.getAllByText("Refund order 4417").length).toBeGreaterThan(0);
	});
});

describe("decision policy evidence", () => {
	const row = (overrides: Record<string, unknown>) => ({
		id: "apr_1",
		workspaceId: "ws_1",
		kind: "action",
		status: "pending",
		actionName: "refund_order",
		title: "Refund order 4417",
		payload: {},
		requiredApprovals: 1,
		approvedCount: 0,
		createdAt: "2026-09-24T10:00:00Z",
		expiresAt: "2099-09-25T10:00:00Z",
		matchedPolicyId: "apol_refund",
		matchedPolicyVersion: 4,
		...overrides,
	});

	it("links the decision to the exact policy version that governed it", () => {
		respond((p) =>
			p.limit === 50 ? { total: 1, rows: [row({})] } : { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		const link = screen.getByRole("link", { name: "policy apol_refund v4" });
		expect(link.getAttribute("href")).toBe(
			"/approval-policies?policy=apol_refund&version=4",
		);
	});

	it("links without a version rather than printing one that was not recorded", () => {
		respond((p) =>
			p.limit === 50
				? { total: 1, rows: [row({ matchedPolicyVersion: null })] }
				: { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		const link = screen.getByRole("link", { name: "policy apol_refund" });
		expect(link.getAttribute("href")).toBe(
			"/approval-policies?policy=apol_refund",
		);
	});
});

describe("governed-effect approvals", () => {
	it("shows the bound preview, read from the approval's own environment", () => {
		previewRead.data = {
			id: "prv_1",
			environment: { id: "env_prod", name: "Production", kind: "production" },
			blocks: [
				{
					type: "fields",
					title: "Refund",
					fields: [{ label: "Refund amount", value: "12.50 USD" }],
				},
			],
			allowances: [],
			expiresAt: "2099-01-01T00:00:00Z",
			bindingDigest: "a".repeat(64),
		};
		respond((p) =>
			p.limit === 50
				? {
						total: 1,
						rows: [
							{
								id: "apr_2",
								workspaceId: "ws_1",
								kind: "action",
								status: "pending",
								title: 'Run action "refund"',
								payload: {
									previewId: "prv_1",
									environmentId: "env_prod",
									effectId: "eff_1",
								},
								requiredApprovals: 1,
								approvedCount: 0,
								createdAt: "2026-09-24T10:00:00Z",
								expiresAt: "2099-09-25T10:00:00Z",
							},
						],
					}
				: { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		expect(
			screen.getByRole("region", { name: "What you are approving" }),
		).toBeTruthy();
		expect(screen.getByTestId("preview-environment").textContent).toMatch(
			/Executes in Production/,
		);
		expect(screen.getByText("12.50 USD")).toBeTruthy();
		expect(previewRead.calls).toContainEqual(["ws_1", "env_prod", "prv_1"]);
	});

	it("a role that cannot decide in the approval's environment sees no decision buttons", () => {
		permission.allowed = (p) => p !== "approvals.decide";
		respond((p) =>
			p.limit === 50
				? {
						total: 1,
						rows: [
							{
								id: "apr_9",
								workspaceId: "ws_1",
								kind: "action",
								status: "pending",
								title: 'Run action "refund"',
								payload: { environmentId: "env_prod" },
								requiredApprovals: 1,
								approvedCount: 0,
								createdAt: "2026-09-24T10:00:00Z",
								expiresAt: "2099-09-25T10:00:00Z",
							},
						],
					}
				: { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
		expect(screen.getByTestId("decide-not-allowed")).toBeTruthy();
		expect(permission.calls).toContainEqual(["approvals.decide", "env_prod"]);
		fireEvent.keyDown(window, { key: "d" });
		expect(decideMutate).not.toHaveBeenCalled();
	});

	describe("approving waits for the bound preview; denying never does", () => {
		const PREVIEW = {
			id: "prv_1",
			environment: { id: "env_prod", name: "Production", kind: "production" },
			blocks: [],
			allowances: [],
			expiresAt: "2099-01-01T00:00:00Z",
			bindingDigest: "a".repeat(64),
		};
		function renderGoverned() {
			respond((p) =>
				p.limit === 50
					? {
							total: 1,
							rows: [
								{
									id: "apr_3",
									workspaceId: "ws_1",
									kind: "action",
									status: "pending",
									title: 'Run action "refund"',
									payload: {
										previewId: "prv_1",
										environmentId: "env_prod",
										effectId: "eff_1",
										bindingDigest: "a".repeat(64),
									},
									requiredApprovals: 1,
									approvedCount: 0,
									createdAt: "2026-09-24T10:00:00Z",
									expiresAt: "2099-09-25T10:00:00Z",
								},
							],
						}
					: { total: 0 },
			);
			render(<ApprovalInbox workspaceId="ws_1" />);
			return screen.getByRole("button", {
				name: "Approve",
			}) as HTMLButtonElement;
		}
		const decisions = () =>
			decideMutate.mock.calls.map(([input]) => input.decision);

		for (const [state, setup, reason] of [
			["still loading", () => {}, /Loading the preview/],
			[
				"failed to load",
				() => {
					previewRead.isError = true;
					previewRead.error = new Error("HTTP 503");
				},
				/could not be loaded \(HTTP 503\)/,
			],
			[
				"a different preview",
				() => {
					previewRead.data = { ...PREVIEW, bindingDigest: "b".repeat(64) };
				},
				/not the one this approval is bound to/,
			],
			[
				"expired",
				() => {
					previewRead.data = { ...PREVIEW, expiresAt: "2020-01-01T00:00:00Z" };
				},
				/has expired/,
			],
		] as const) {
			it(`blocks approve when the preview is ${state}, by button and by shortcut`, () => {
				setup();
				const approve = renderGoverned();
				expect(approve.disabled).toBe(true);
				expect(screen.getByTestId("approve-blocked").textContent).toMatch(
					reason,
				);
				fireEvent.keyDown(window, { key: "a" });
				fireEvent.keyDown(window, { key: "a" });
				expect(decisions()).toEqual([]);
				fireEvent.keyDown(window, { key: "d" });
				expect(decisions()).toEqual(["deny"]);
			});
		}

		it("allows approve once the bound, current preview is on screen", () => {
			previewRead.data = PREVIEW;
			const approve = renderGoverned();
			expect(approve.disabled).toBe(false);
			fireEvent.keyDown(window, { key: "a" });
			expect(decisions()).toEqual(["approve"]);
		});
	});
});

describe("users in the inbox", () => {
	const pending = {
		id: "apr_9",
		workspaceId: "ws_1",
		kind: "action",
		status: "pending",
		actionName: "send-email",
		title: "Send an email",
		payload: {},
		requiredApprovals: 1,
		approvedCount: 0,
		createdAt: "2026-09-24T10:00:00Z",
		expiresAt: "2099-09-25T10:00:00Z",
		endUserId: "user_42",
	};

	it("names the user a request acts for, on the row and in the detail", () => {
		respond((p) =>
			p.limit === 50 ? { total: 1, rows: [pending] } : { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		expect(screen.getAllByText("user_42").length).toBe(2);
	});

	it("says Workspace on a request with the workspace's own accounts", () => {
		respond((p) =>
			p.limit === 50
				? { total: 1, rows: [{ ...pending, endUserId: null }] }
				: { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		expect(screen.getAllByText("Workspace").length).toBe(2);
	});

	it("narrows every list and count to one side", () => {
		respond(() => ({ total: 0 }));
		render(<ApprovalInbox actingFor="end_users" workspaceId="ws_1" />);
		expect(useApprovals.mock.calls.length).toBeGreaterThan(0);
		for (const [, params] of useApprovals.mock.calls) {
			expect(params).toMatchObject({ actingFor: "end_users" });
		}
	});

	it("filters every list and count by the user", () => {
		respond(() => ({ total: 0 }));
		const onEndUserChange = vi.fn();
		render(
			<ApprovalInbox
				endUserId="user_42"
				onEndUserChange={onEndUserChange}
				workspaceId="ws_1"
			/>,
		);
		for (const [, params] of useApprovals.mock.calls) {
			expect(params).toMatchObject({ endUserId: "user_42" });
		}
		const input = screen.getByLabelText("User") as HTMLInputElement;
		expect(input.value).toBe("user_42");
		fireEvent.change(input, { target: { value: "user 7" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		expect(screen.getByRole("alert").textContent).toBe("Not a user id.");
		expect(onEndUserChange).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "user_7" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		expect(onEndUserChange).toHaveBeenCalledWith("user_7");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Clear the user filter (user_42)",
			}),
		);
		expect(onEndUserChange).toHaveBeenLastCalledWith(undefined);
	});
});

describe("a function plan in the inbox", () => {
	it("lists the plan's writes in order, with the review's summary", () => {
		const plan = {
			id: "apr_fn",
			workspaceId: "ws_1",
			kind: "function_plan",
			status: "pending",
			actionName: null,
			title: 'Run function "refund-with-checks"',
			payload: {
				functionName: "refund-with-checks",
				planRunId: "frn_1",
				writes: [
					{ sequence: 2, action: "refund", input: { order: "ord_1" } },
					{ sequence: 3, action: "send-email", input: { to: "a@example.com" } },
				],
				review: {
					summary: "Refunds one paid order, then emails the customer.",
				},
			},
			requiredApprovals: 1,
			approvedCount: 0,
			createdAt: "2026-09-24T10:00:00Z",
			expiresAt: "2099-09-25T10:00:00Z",
		};
		respond((p) =>
			p.limit === 50 ? { total: 1, rows: [plan] } : { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		const writes = within(
			screen.getByRole("list", { name: "Writes, in this order" }),
		).getAllByRole("listitem");
		expect(writes.map((item) => item.textContent)).toEqual([
			expect.stringContaining("refund"),
			expect.stringContaining("send-email"),
		]);
		expect(writes[0].textContent).toMatch(/^1\./);
		expect(
			screen.getByText("Refunds one paid order, then emails the customer."),
		).toBeTruthy();
	});

	it("says what approving lets the run do, with the review's risk and findings", () => {
		const plan = {
			id: "apr_fn2",
			workspaceId: "ws_1",
			kind: "function_plan",
			status: "pending",
			actionName: null,
			title: 'Run function "bulk-refund"',
			description: "2 writes: refund. Approving lets one run …",
			payload: {
				functionName: "bulk-refund",
				planRunId: "frn_9",
				planDigest: "sha256:abc",
				writes: [
					{ sequence: 1, action: "refund", input: { order: "ord_1" } },
					{ sequence: 2, action: "refund", input: { order: "ord_2" } },
				],
				review: {
					summary: null,
					suggestedRiskTier: "high",
					riskyPatterns: ["Refunds every order it finds"],
					computedActionNames: 0,
					writesInLoop: 1,
					riskyApis: [],
				},
			},
			requiredApprovals: 1,
			approvedCount: 0,
			createdAt: "2026-09-24T10:00:00Z",
			expiresAt: "2099-09-25T10:00:00Z",
		};
		respond((p) =>
			p.limit === 50 ? { total: 1, rows: [plan] } : { total: 0 },
		);
		render(<ApprovalInbox workspaceId="ws_1" />);
		const consequence = screen.getByRole("region", {
			name: "What approving does",
		});
		expect(consequence.textContent).toContain(
			"Approving lets one run of “bulk-refund”, with this input, make exactly the 2 writes below, in this order.",
		);
		expect(screen.queryByText(/Approving lets one run …/)).toBeNull();
		expect(screen.getByText("High risk")).toBeTruthy();
		expect(screen.getByText("Refunds every order it finds")).toBeTruthy();
		expect(screen.getByText(/Writes inside a loop in 1 place/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "bulk-refund" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "frn_9" })).toBeTruthy();
		const second = screen.getByRole("button", { name: /^2\.refund/ });
		expect(second.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(second);
		expect(second.getAttribute("aria-expanded")).toBe("true");
	});
});
