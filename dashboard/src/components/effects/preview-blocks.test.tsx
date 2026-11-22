/* @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionPreview } from "@/lib/types";
import {
	formatQuantity,
	PreviewBlocks,
	splitLimitation,
} from "./preview-blocks";

afterEach(cleanup);

function preview(overrides: Partial<ActionPreview> = {}): ActionPreview {
	return {
		id: "prv_1",
		action: { id: "act_1", name: "update-fixture", versionId: "acv_1" },
		adapter: { type: "github.file_update", version: "1" },
		environment: { id: "env_1", name: "Production", kind: "production" },
		target: { resourceKey: "github:acme/fixtures@anlyon-test:data/a.txt" },
		request: {},
		impact: [{ dimension: "resource_mutations", amount: 1, bound: "exact" }],
		blocks: [
			{
				type: "fields",
				title: "Execution target",
				fields: [{ label: "Target account", value: "acme/fixtures" }],
			},
			{
				type: "text_diff",
				title: "Content change",
				path: "data/a.txt",
				before: "<script>alert(1)</script>",
				after: "green\n",
				truncated: false,
			},
			{
				type: "impact",
				title: "Expected impact",
				quantities: [
					{ dimension: "resource_mutations", amount: 1, bound: "exact" },
				],
			},
			{
				type: "limitations",
				title: "What is supported and what is not",
				items: [
					{
						kind: "guarantee",
						text: "Stale-state protection: the reviewed blob SHA is enforced.",
					},
					{
						kind: "freshness",
						text: "No atomic stale-state protection: account checked before dispatch.",
					},
					{ kind: "unsupported", text: "Not supported: binary files" },
					{ kind: "irreversible", text: "Refunds are irreversible." },
				],
			},
		],
		preconditions: { blobSha: "abc" },
		allowances: [
			{
				limitId: "lim_1",
				name: "File changes",
				requested: 1,
				available: 3,
				sufficient: true,
			},
		],
		evidenceObservedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		expired: false,
		bindingDigest: "f".repeat(64),
		supersedes: null,
		effectId: null,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("PreviewBlocks", () => {
	it("names the execution environment in words, first", () => {
		render(<PreviewBlocks preview={preview()} />);
		const banner = screen.getByTestId("preview-environment");
		expect(banner.textContent).toMatch(
			/Executes in Production \(production, a production environment\)/,
		);
		expect(screen.getByTestId("effect-preview").firstElementChild).toBe(banner);
	});

	it("labels every guarantee and limitation in text, not only colour", () => {
		render(<PreviewBlocks preview={preview()} />);
		const section = screen.getByRole("region", {
			name: "What is supported and what is not",
		});
		for (const label of [
			"Supported",
			"Not protected",
			"Not supported",
			"Irreversible",
		]) {
			expect(within(section).getByText(label)).toBeTruthy();
		}
	});

	it("renders provider text as text and keeps diffs reachable by keyboard", () => {
		const { container } = render(<PreviewBlocks preview={preview()} />);
		expect(container.querySelector("script")).toBeNull();
		const before = screen.getByLabelText("Current content of data/a.txt");
		expect(before.textContent).toBe("<script>alert(1)</script>");
		expect(before.getAttribute("tabindex")).toBe("0");
		expect(
			screen
				.getByLabelText("New content of data/a.txt")
				.getAttribute("tabindex"),
		).toBe("0");
	});

	it("says when a preview has expired and can no longer execute", () => {
		render(
			<PreviewBlocks
				preview={preview({
					expiresAt: new Date(Date.now() - 1000).toISOString(),
				})}
			/>,
		);
		expect(screen.getByRole("status").textContent).toMatch(
			/can no longer execute/,
		);
	});

	it("formats integer minor units and bounds", () => {
		expect(
			formatQuantity({
				dimension: "money",
				currency: "usd",
				amount: 1250,
				bound: "exact",
			}),
		).toBe("12.50 USD");
		expect(
			formatQuantity({
				dimension: "resource_mutations",
				amount: 3,
				bound: "upper_bound",
			}),
		).toBe("up to 3 resource changes");
	});

	it("formats a declared unit as a count in its own name, never as currency", () => {
		expect(
			formatQuantity({ dimension: "emails", amount: 40, bound: "upper_bound" }),
		).toBe("up to 40 emails");
	});
});

describe("guarantees and limitations", () => {
	it("splits a headline from its detail, and drops a repeated label", () => {
		expect(
			splitLimitation(
				"guarantee",
				"Idempotency: every write sends the effect's Idempotency-Key.",
			),
		).toEqual({
			title: "Idempotency",
			detail: "Every write sends the effect's Idempotency-Key.",
		});
		expect(splitLimitation("unsupported", "Not supported: Live mode")).toEqual({
			title: "Live mode",
			detail: null,
		});
		expect(
			splitLimitation("irreversible", "Refunds are irreversible."),
		).toEqual({ title: "Refunds are irreversible.", detail: null });
	});

	it("keeps the badge and headline visible and folds the detail away", () => {
		render(<PreviewBlocks preview={preview()} />);
		const section = screen.getByRole("region", {
			name: "What is supported and what is not",
		});
		const trigger = within(section).getByRole("button", {
			name: /Stale-state protection/,
		});
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(
			within(section).getByText("The reviewed blob SHA is enforced."),
		).toBeTruthy();
		expect(
			within(section).getByText("binary files").closest("button"),
		).toBeNull();
	});
});
