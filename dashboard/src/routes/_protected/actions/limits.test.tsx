/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImpactLimit } from "@/lib/types";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	update: vi.fn(),
	archive: vi.fn(),
	navigate: vi.fn(),
	limits: [] as unknown[],
	permissions: [] as unknown[][],
	canManage: true,
}));

vi.mock("@/hooks/api/use-permissions", () => ({
	useCan:
		() =>
		(...args: unknown[]) => {
			mocks.permissions.push(args);
			return mocks.canManage;
		},
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: Record<string, unknown>) => options,
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/api/use-effects", () => ({
	useImpactLimits: () => ({
		data: mocks.limits,
		isLoading: false,
		isError: false,
		isFetching: false,
	}),
	useCreateImpactLimit: () => ({ mutate: mocks.create, isPending: false }),
	useUpdateImpactLimit: () => ({ mutate: mocks.update, isPending: false }),
	useArchiveImpactLimit: () => ({ mutate: mocks.archive, isPending: false }),
}));

import { formatLimitAmount, LimitsPage } from "./limits";

const Page = () => (
	<LimitsPage environmentId={undefined} onEnvironmentChange={mocks.navigate} />
);

const refundCap: ImpactLimit = {
	id: "lim_1",
	name: "Daily refund cap",
	dimension: "money",
	currency: "usd",
	unit: "usd",
	scope: {
		environmentId: "env_1",
		actionName: "refund_payment",
		resourcePrefix: null,
	},
	period: "day",
	limit: 50_000,
	currentPeriod: "2026-10-01",
	consumed: 12_000,
	reserved: 3_000,
	unknownExposure: 1_000,
	available: 35_000,
	archived: false,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};

const emailCap: ImpactLimit = {
	...refundCap,
	id: "lim_2",
	name: "Daily email cap",
	dimension: "emails",
	currency: null,
	unit: "emails",
	scope: { environmentId: "env_1", actionName: null, resourcePrefix: null },
	limit: 5_000,
	consumed: 1_200,
	reserved: 40,
	unknownExposure: 0,
	available: 3_760,
};

describe("Impact limits page", () => {
	afterEach(cleanup);
	beforeEach(() => {
		for (const fn of [mocks.create, mocks.update, mocks.archive])
			fn.mockReset();
		mocks.limits = [];
		mocks.canManage = true;
	});

	it("explains what a limit is when there are none", () => {
		render(<Page />);
		expect(screen.getByText("No impact limits yet")).toBeTruthy();
		expect(screen.getByRole("button", { name: "New limit" })).toBeTruthy();
	});

	it("shows availability against the cap, and what is used, held and unknown", () => {
		mocks.limits = [refundCap];
		render(<Page />);
		expect(screen.getByText("Daily refund cap")).toBeTruthy();
		expect(screen.getByText("Per day · 2026-10-01")).toBeTruthy();
		expect(screen.getByText("refund_payment")).toBeTruthy();
		expect(screen.getByText(/350\.00/)).toBeTruthy();
		expect(screen.getByText(/of .*500\.00/)).toBeTruthy();
		expect(screen.getByText(/120\.00 used · .*30\.00 held/)).toBeTruthy();
		expect(screen.getByText(/10\.00 unknown/)).toBeTruthy();
	});

	it("creates a limit from the dialog, in minor units", async () => {
		render(<Page />);
		fireEvent.click(screen.getByRole("button", { name: "New limit" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("New impact limit");

		fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Name the limit.",
		);
		expect(mocks.create).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Daily refund cap" },
		});
		fireEvent.change(screen.getByLabelText("Amount"), {
			target: { value: "500" },
		});
		fireEvent.change(screen.getByLabelText("Only this action"), {
			target: { value: "refund_payment" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create limit" }));

		await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
		expect(mocks.create.mock.calls[0][0]).toEqual({
			name: "Daily refund cap",
			dimension: "money",
			currency: "usd",
			period: "day",
			amount: 50_000,
			actionName: "refund_payment",
			resourcePrefix: null,
		});
	});

	it("shows a declared-unit limit as a count in its own unit, never as currency", () => {
		mocks.limits = [emailCap];
		render(<Page />);
		const row = screen.getByText("Daily email cap").closest("tr");
		expect(row?.textContent).toContain(`${(3_760).toLocaleString()} emails`);
		expect(row?.textContent).toContain(`of ${(5_000).toLocaleString()} emails`);
		expect(row?.textContent).toContain(
			`${(1_200).toLocaleString()} emails used · 40 emails held`,
		);
		expect(row?.textContent).not.toMatch(/37\.60|\$|USD/);
		expect(formatLimitAmount({ dimension: "rows", currency: null }, 1)).toBe(
			"1 rows",
		);
		expect(
			formatLimitAmount({ dimension: "resource_mutations", currency: null }, 1),
		).toBe("1 change");
	});

	it("edits a declared-unit limit in whole units", async () => {
		mocks.limits = [emailCap];
		render(<Page />);
		fireEvent.click(
			screen.getByRole("button", { name: "Edit Daily email cap" }),
		);
		const amount = await screen.findByLabelText("Number of emails");
		expect((amount as HTMLInputElement).value).toBe("5000");
		fireEvent.change(amount, { target: { value: "7500" } });
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
		expect(mocks.update.mock.calls[0][0]).toEqual({
			id: "lim_2",
			amount: 7_500,
		});
	});

	it("creates a limit in a declared unit, with no currency", async () => {
		render(<Page />);
		fireEvent.click(screen.getByRole("button", { name: "New limit" }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByLabelText("What the limit caps"));
		const option = await screen.findByRole("option", {
			name: "A declared unit",
		});
		option.focus();
		fireEvent.keyDown(option, { key: "Enter" });
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Daily email cap" },
		});
		fireEvent.change(await screen.findByLabelText("Unit"), {
			target: { value: "Emails " },
		});
		fireEvent.change(screen.getByLabelText("Amount"), {
			target: { value: "5000" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create limit" }));

		await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
		expect(mocks.create.mock.calls[0][0]).toEqual({
			name: "Daily email cap",
			dimension: "emails",
			period: "day",
			amount: 5_000,
			actionName: null,
			resourcePrefix: null,
		});
	});

	it("edits only what changed", async () => {
		mocks.limits = [refundCap];
		render(<Page />);
		fireEvent.click(
			screen.getByRole("button", { name: "Edit Daily refund cap" }),
		);
		const amount = await screen.findByLabelText("Amount (USD)");
		expect((amount as HTMLInputElement).value).toBe("500.00");
		fireEvent.change(amount, { target: { value: "750" } });
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
		expect(mocks.update.mock.calls[0][0]).toEqual({
			id: "lim_1",
			amount: 75_000,
		});
	});

	it("asks before archiving", async () => {
		mocks.limits = [refundCap];
		render(<Page />);
		fireEvent.click(
			screen.getByRole("button", { name: "Archive Daily refund cap" }),
		);
		expect(mocks.archive).not.toHaveBeenCalled();
		await screen.findByText("Archive Daily refund cap?");
		fireEvent.click(screen.getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith("lim_1"));
	});
});

describe("Impact limits per user", () => {
	afterEach(cleanup);
	beforeEach(() => {
		mocks.create.mockReset();
		mocks.limits = [];
	});

	it("creates a limit each user gets on their own", async () => {
		render(<Page />);
		fireEvent.click(screen.getByRole("button", { name: "New limit" }));
		expect((screen.getByLabelText("Scope") as HTMLSelectElement).value).toBe(
			"environment",
		);
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Daily refunds per user" },
		});
		fireEvent.change(screen.getByLabelText("Amount"), {
			target: { value: "50" },
		});
		fireEvent.change(screen.getByLabelText("Scope"), {
			target: { value: "end_user" },
		});
		expect(screen.getByText(/Each user gets this amount/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Create limit" }));
		await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
		expect(mocks.create.mock.calls[0][0]).toMatchObject({
			name: "Daily refunds per user",
			scope: "end_user",
		});
	});

	it("says on the row when a limit counts per user", () => {
		mocks.limits = [
			{
				...emailCap,
				scope: { ...emailCap.scope, kind: "end_user" },
			},
		];
		render(<Page />);
		const row = screen.getByText("Daily email cap").closest("tr");
		expect(row?.textContent).toContain("Each user");
	});

	it("says how each limit's allowance is shared", () => {
		mocks.limits = [
			{ ...emailCap, scope: { ...emailCap.scope, kind: "end_user" } },
			refundCap,
		];
		render(<Page />);
		expect(
			screen.getByRole("columnheader", { name: "Allowance" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("columnheader", { name: "Applies to" }),
		).toBeNull();
		const perUser = screen
			.getByText("Daily email cap")
			.closest("tr") as HTMLElement;
		expect(
			within(perUser).getByText(
				"Each user has their own; workspace calls share one",
			),
		).toBeTruthy();
		const shared = screen
			.getByText("Daily refund cap")
			.closest("tr") as HTMLElement;
		expect(
			within(shared).getByText("One allowance for every call"),
		).toBeTruthy();
		expect(within(shared).getByText("refund_payment")).toBeTruthy();
	});
});

describe("Without limits.manage", () => {
	afterEach(cleanup);
	beforeEach(() => {
		mocks.limits = [];
		mocks.permissions = [];
		mocks.canManage = false;
	});

	it("asks for limits.manage in the environment shown", () => {
		render(
			<LimitsPage environmentId="env_1" onEnvironmentChange={mocks.navigate} />,
		);
		expect(mocks.permissions).toContainEqual(["limits.manage", "env_1"]);
	});

	it("offers no new limit when there are none", () => {
		render(<Page />);
		expect(screen.getByText("No impact limits yet")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "New limit" })).toBeNull();
	});

	it("shows the limits, with no way to create, edit or archive one", () => {
		mocks.limits = [refundCap];
		render(<Page />);
		expect(screen.getByText("Daily refund cap")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "New limit" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Edit Daily refund cap/ }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Archive Daily refund cap" }),
		).toBeNull();
	});
});
