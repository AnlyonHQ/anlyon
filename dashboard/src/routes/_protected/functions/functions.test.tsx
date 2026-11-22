/* @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionRun, HostedFunction } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	functions: [] as unknown[],
	permissions: new Set<string>(["actions.manage", "actions.invoke"]),
	run: undefined as unknown,
	version: undefined as unknown,
	versions: [] as unknown[],
	runs: [] as unknown[],
	startRun: vi.fn(),
	deleteFunction: vi.fn(),
	navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => options,
	useNavigate: () => mocks.navigate,
	Link: ({
		to,
		params,
		search,
		children,
		...rest
	}: {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, string | undefined>;
		children: React.ReactNode;
	}) => {
		const path = to.replace(
			/\$(\w+)/g,
			(_, key: string) => params?.[key] ?? "",
		);
		const query = new URLSearchParams(
			Object.entries(search ?? {}).flatMap(([k, v]) =>
				v === undefined ? [] : [[k, v]],
			),
		).toString();
		return (
			<a href={query ? `${path}?${query}` : path} {...rest}>
				{children}
			</a>
		);
	},
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan: () => (permission: string) => mocks.permissions.has(permission),
}));

vi.mock("@/hooks/api/use-functions", () => ({
	useFunctions: () => ({
		data: mocks.functions,
		isLoading: false,
		isError: false,
	}),
	useCreateFunction: () => ({ mutate: vi.fn(), isPending: false }),
	useDeleteFunction: () => ({
		mutate: mocks.deleteFunction,
		isPending: false,
	}),
	useAnalyzeFunctionSource: () => ({ mutate: vi.fn(), isPending: false }),
	usePublishFunctionVersion: () => ({ mutate: vi.fn(), isPending: false }),
	useFunctionRun: () => ({
		data: mocks.run,
		isLoading: false,
		error: null,
	}),
	useStartFunctionRun: () => ({ mutate: mocks.startRun, isPending: false }),
	useFunctionVersion: () => ({
		data: mocks.version,
		isLoading: false,
		isError: false,
	}),
	useFunctionVersions: () => ({
		data: mocks.versions,
		isLoading: false,
		isError: false,
	}),
	useFunctionRuns: () => ({
		data: mocks.runs,
		isLoading: false,
		isError: false,
	}),
}));

vi.mock("@/hooks/api/use-actions", () => ({
	useActions: () => ({
		data: [
			{ name: "lookup-order", method: "GET", description: null, enabled: true },
			{ name: "refund", method: "POST", description: null, enabled: true },
		],
	}),
}));

import { FunctionRunDetail } from "@/components/functions/run-detail";
import { FunctionPage } from "./$name";
import { FunctionsPage } from "./index";
import { FunctionRunPage } from "./runs/$runId";

const refundFn: HostedFunction = {
	id: "fn_1",
	name: "refund-with-checks",
	description: "Refund an order after checking it was paid.",
	environmentId: "env_1",
	currentVersion: {
		id: "fnv_1",
		version: 2,
		language: "javascript",
		digest: "sha256:abc",
		allowedActions: ["lookup-order", "refund"],
		inputSchema: {},
		budgets: {
			maxActionCalls: 50,
			maxCpuMs: 1000,
			maxSubrequests: 100,
			timeoutMs: 30000,
		},
		straightThrough: null,
		review: {
			ast: {
				language: "javascript",
				parsed: true,
				parseError: null,
				calls: [{ kind: "invoke", action: "refund", line: 4 }],
				proposedAllowedActions: ["refund"],
				computedActionNames: [],
				risky: [],
				writesInLoop: [],
			},
			ai: null,
		},
		createdAt: "2026-10-24T10:00:00.000Z",
	},
	createdAt: "2026-10-24T09:00:00.000Z",
	updatedAt: "2026-10-24T10:00:00.000Z",
};

const SOURCE = `export default async function run(input, anlyon) {
  return anlyon.invoke("refund", input);
}`;

const currentDetail = () => ({
	...(refundFn.currentVersion as NonNullable<HostedFunction["currentVersion"]>),
	current: true,
	source: SOURCE,
});

const run = (patch: Partial<FunctionRun> = {}): FunctionRun => ({
	id: "frn_plan",
	functionId: "fn_1",
	functionName: "refund-with-checks",
	functionVersionId: "fnv_1",
	mode: "plan",
	status: "awaiting_approval",
	endUserId: null,
	input: { order: "ord_1" },
	inputDigest: "sha256:in",
	output: null,
	error: null,
	logs: [],
	budget: null,
	actionCalls: 1,
	calls: [
		{
			sequence: 1,
			action: "lookup-order",
			kind: "read",
			state: "dispatched",
			invocationId: "inv_1",
			refusal: null,
			plannedSequence: null,
		},
		{
			sequence: 2,
			action: "refund",
			kind: "write",
			state: "intent",
			invocationId: null,
			refusal: null,
			plannedSequence: null,
		},
		{
			sequence: 3,
			action: "send-email",
			kind: "write",
			state: "intent",
			invocationId: null,
			refusal: null,
			plannedSequence: null,
		},
	],
	plan: {
		digest: "sha256:plan",
		writes: [
			{ sequence: 2, action: "refund", input: { order: "ord_1" } },
			{ sequence: 3, action: "send-email", input: { to: "a@example.com" } },
		],
		approval: { id: "apr_1", status: "approved", decider: "team" },
		appliedByRunId: null,
	},
	planRunId: null,
	planDigest: null,
	approvalId: null,
	receipt: null,
	durationMs: 12,
	createdAt: "2026-10-24T10:00:00.000Z",
	finishedAt: "2026-10-24T10:00:01.000Z",
	...patch,
});

beforeEach(() => {
	mocks.functions = [];
	mocks.permissions = new Set(["actions.manage", "actions.invoke"]);
	mocks.run = undefined;
	mocks.version = currentDetail();
	mocks.versions = [];
	mocks.runs = [];
	mocks.startRun.mockReset();
	localStorage.clear();
});

afterEach(() => vi.clearAllMocks());

describe("Functions page", () => {
	it("says what it is for", () => {
		render(<FunctionsPage />);
		expect(screen.getByRole("heading", { name: "Functions" })).toBeTruthy();
		expect(screen.getByText(/run with the network off/)).toBeTruthy();
	});

	it("offers one action when there are no functions: create one", () => {
		render(<FunctionsPage />);
		expect(screen.getByText("No functions yet")).toBeTruthy();
		expect(
			screen.getAllByRole("button", { name: "New function" }),
		).toHaveLength(1);
	});

	it("offers no create button to a member who cannot manage actions", () => {
		mocks.permissions = new Set(["actions.invoke"]);
		render(<FunctionsPage />);
		expect(screen.getByText("No functions yet")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "New function" })).toBeNull();
	});

	it("lists functions with their current version", () => {
		mocks.functions = [
			refundFn,
			{ ...refundFn, id: "fn_2", name: "draft", currentVersion: null },
		];
		render(<FunctionsPage />);
		expect(screen.queryByText("No functions yet")).toBeNull();
		const link = screen.getByRole("link", { name: "refund-with-checks" });
		expect(link.getAttribute("href")).toBe("/functions/refund-with-checks");
		expect(screen.getByText("v2")).toBeTruthy();
		expect(screen.getByText("Not published")).toBeTruthy();
	});
});

describe("Function page", () => {
	it("opens on the code: the published source, publish and a plan run", () => {
		mocks.functions = [refundFn];
		render(<FunctionPage name="refund-with-checks" />);
		expect(
			screen.getByRole("heading", { name: "refund-with-checks" }),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Code" }).getAttribute("aria-current"),
		).toBe("page");
		expect(screen.getByText("function.js")).toBeTruthy();
		expect(screen.getByText("v2 is current")).toBeTruthy();
		const publish = screen.getByRole("button", { name: /Publish version/ });
		expect((publish as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("button", { name: "Start plan run" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Use in code" })).toBeTruthy();
	});

	it("deletes the function after a confirm, then goes back to the list", () => {
		mocks.functions = [refundFn];
		render(<FunctionPage name="refund-with-checks" />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Delete function refund-with-checks",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Delete function" }));
		expect(mocks.deleteFunction).toHaveBeenCalledWith(
			"refund-with-checks",
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		);
		mocks.deleteFunction.mock.calls[0][1].onSuccess();
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/functions" });
	});

	it("hides publishing and runs from a member without the permissions", () => {
		mocks.functions = [refundFn];
		mocks.permissions = new Set();
		render(<FunctionPage name="refund-with-checks" />);
		expect(
			screen.queryByRole("button", { name: /Publish version/ }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Start plan run" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Delete function/ }),
		).toBeNull();
		expect(screen.getByText(/needs permission to manage actions/)).toBeTruthy();
		expect(screen.getByText(/needs permission to invoke actions/)).toBeTruthy();
	});

	it("starts a plan run with the typed input and shows it in the test panel", () => {
		mocks.functions = [refundFn];
		mocks.startRun.mockImplementation(
			(
				_request: unknown,
				options?: { onSuccess?: (result: FunctionRun) => void },
			) => options?.onSuccess?.(run()),
		);
		render(<FunctionPage name="refund-with-checks" />);
		fireEvent.change(screen.getByLabelText("Input (JSON)"), {
			target: { value: '{"order":"ord_9"}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Start plan run" }));
		expect(mocks.startRun).toHaveBeenCalledWith(
			{ name: "refund-with-checks", mode: "plan", input: { order: "ord_9" } },
			expect.anything(),
		);
		const last = screen.getByRole("region", { name: "Last run" });
		expect(
			within(last).getByRole("link", { name: "Open run" }).getAttribute("href"),
		).toBe("/functions/runs/frn_plan");
		expect(
			within(last)
				.getByRole("link", { name: "Open the approval" })
				.getAttribute("href"),
		).toBe("/approvals?id=apr_1");
	});

	it("refuses input that is not a JSON object before starting a run", () => {
		mocks.functions = [refundFn];
		render(<FunctionPage name="refund-with-checks" />);
		fireEvent.change(screen.getByLabelText("Input (JSON)"), {
			target: { value: "[1]" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Start plan run" }));
		expect(mocks.startRun).not.toHaveBeenCalled();
		expect(screen.getByText("The input must be a JSON object.")).toBeTruthy();
	});

	it("restores an unpublished draft from this browser", () => {
		mocks.functions = [refundFn];
		localStorage.setItem(
			"anlyon.function-draft.workspace-1.refund-with-checks",
			JSON.stringify({
				language: "javascript",
				source: `${SOURCE}\n// edited`,
				baseVersion: 2,
			}),
		);
		render(<FunctionPage name="refund-with-checks" />);
		expect(
			screen.getByText(/draft was restored from this browser/),
		).toBeTruthy();
		expect(screen.getByText("Unpublished changes")).toBeTruthy();
		const publish = screen.getByRole("button", { name: /Publish version/ });
		expect((publish as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByText(/Runs v2, the published version/)).toBeTruthy();
	});

	it("starts an unpublished function from a template", () => {
		mocks.functions = [{ ...refundFn, currentVersion: null }];
		mocks.version = undefined;
		render(<FunctionPage name="refund-with-checks" />);
		expect(screen.getByText("Not published")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Templates" })).toBeTruthy();
		expect(
			screen.getByText("Publish a version before starting a run."),
		).toBeTruthy();
		const start = screen.getByRole("button", { name: "Start plan run" });
		expect((start as HTMLButtonElement).disabled).toBe(true);
	});

	it("lists the function's runs on the Runs tab", () => {
		mocks.functions = [refundFn];
		mocks.runs = [
			{
				id: "frn_1",
				functionVersionId: "fnv_1",
				version: 2,
				mode: "plan",
				status: "awaiting_approval",
				endUserId: "user_7",
				actionCalls: 3,
				budget: null,
				error: null,
				approvalId: "apr_1",
				durationMs: 40,
				createdAt: "2026-10-24T10:00:00.000Z",
				finishedAt: "2026-10-24T10:00:01.000Z",
			},
		];
		render(<FunctionPage name="refund-with-checks" tab="runs" />);
		expect(
			screen.getByRole("link", { name: "Runs" }).getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen.getByRole("link", { name: "frn_1" }).getAttribute("href"),
		).toBe("/functions/runs/frn_1");
		expect(
			screen.getByRole("link", { name: "user_7" }).getAttribute("href"),
		).toBe("/users/user_7");
		expect(screen.getByText("1 run")).toBeTruthy();
		expect(screen.getByLabelText("Open a run by id")).toBeTruthy();
	});

	it("shows the version history, the chosen version's settings and its review", () => {
		mocks.functions = [refundFn];
		mocks.versions = [
			currentDetail(),
			{ ...currentDetail(), id: "fnv_0", version: 1, current: false },
		];
		render(<FunctionPage name="refund-with-checks" tab="versions" />);
		expect(screen.getByText("Current")).toBeTruthy();
		expect(screen.getByText("Version 2")).toBeTruthy();
		expect(screen.getByText(/No AI review for this version yet/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Open in editor" })).toBeTruthy();
	});
});

describe("A run", () => {
	it("shows the plan's writes in order, its approval, and offers apply once approved", () => {
		render(<FunctionRunDetail canInvoke onApply={vi.fn()} run={run()} />);
		const writes = within(screen.getByRole("list", { name: "Planned writes" }))
			.getAllByRole("listitem")
			.map((item) => item.textContent ?? "");
		expect(writes[0]).toContain("refund");
		expect(writes[1]).toContain("send-email");
		expect(screen.getByText("Approved")).toBeTruthy();
		expect(screen.getByText(/Decided by Your team/)).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: "Open the approval" })
				.getAttribute("href"),
		).toBe("/approvals?id=apr_1");
		expect(screen.getByRole("button", { name: "Apply plan" })).toBeTruthy();
	});

	it("does not offer apply while the approval is pending", () => {
		const pending = run();
		if (pending.plan?.approval) pending.plan.approval.status = "pending";
		render(<FunctionRunDetail canInvoke onApply={vi.fn()} run={pending} />);
		expect(screen.queryByRole("button", { name: "Apply plan" })).toBeNull();
		expect(
			screen.getByText("Apply opens once the plan is approved."),
		).toBeTruthy();
	});

	it("applies an approved plan from the run page", () => {
		mocks.run = run();
		render(<FunctionRunPage onApplied={vi.fn()} runId="frn_plan" />);
		fireEvent.click(screen.getByRole("button", { name: "Apply plan" }));
		expect(mocks.startRun).toHaveBeenCalledWith(
			{ name: "refund-with-checks", mode: "apply", planRunId: "frn_plan" },
			expect.anything(),
		);
	});

	it("shows a diverged apply run, the refused call and its receipt", () => {
		const diverged = run({
			id: "frn_apply",
			mode: "apply",
			status: "diverged",
			plan: null,
			planRunId: "frn_plan",
			calls: [
				{
					sequence: 1,
					action: "refund",
					kind: "write",
					state: "dispatched",
					invocationId: "inv_2",
					refusal: null,
					plannedSequence: 2,
				},
				{
					sequence: 2,
					action: "cancel-order",
					kind: "write",
					state: "refused",
					invocationId: null,
					refusal: "RUN_DIVERGED",
					plannedSequence: null,
				},
			],
			receipt: {
				functionId: "fn_1",
				functionVersionId: "fnv_1",
				digest: "sha256:abc",
				inputDigest: "sha256:in",
				mode: "apply",
				planDigest: "sha256:plan",
				approvalId: "apr_1",
				planRunId: "frn_plan",
				calls: [],
				outcome: "diverged",
				budget: null,
				finishedAt: "2026-10-24T10:01:00.000Z",
			},
		});
		render(<FunctionRunDetail canInvoke run={diverged} />);
		expect(screen.getAllByText("Diverged").length).toBeGreaterThan(0);
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.getByText("RUN_DIVERGED")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "inv_2" }).getAttribute("href"),
		).toBe("/actions/invocations?invocation=inv_2");
		expect(
			screen.getByRole("link", { name: "frn_plan" }).getAttribute("href"),
		).toBe("/functions/runs/frn_plan");
		expect(screen.getByText("Receipt")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Apply plan" })).toBeNull();
	});
});
