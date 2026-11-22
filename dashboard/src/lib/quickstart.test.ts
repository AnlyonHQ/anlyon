import { describe, expect, it } from "vitest";
import { packActionKind } from "../../../sdks/typescript/sdk/src/resources/packs-core.ts";
import { cataloguePack } from "./packs";
import {
	callLabel,
	connectedAccount,
	fillPrompt,
	journeyCalls,
	quickstartStep,
	RECIPES,
	recipeFor,
	waitedWriteDecided,
} from "./quickstart";
import type { Invocation } from "./types";

const invocation = (over: Partial<Invocation> = {}): Invocation => ({
	id: "inv_1",
	actionName: "github-close-issue",
	status: "succeeded",
	responseStatus: 200,
	body: null,
	error: null,
	durationMs: 120,
	approvalId: null,
	createdAt: "2026-10-16T10:00:00.000Z",
	completedAt: "2026-10-16T10:00:01.000Z",
	...over,
});

describe("recipes", () => {
	it("covers the ten integrations that connect with a key, once each", () => {
		expect(RECIPES.map((r) => r.integration).sort()).toEqual([
			"asana",
			"attio",
			"discord",
			"github",
			"intercom",
			"notion",
			"pagerduty",
			"resend",
			"sentry",
			"stripe",
		]);
	});

	for (const recipe of RECIPES) {
		describe(recipe.integration, () => {
			const pack = cataloguePack(`anlyon/${recipe.integration}`);
			const action = (name: string) =>
				pack?.actions.find((a) => a.name === name);
			const gated = (name: string) =>
				(pack?.policies ?? []).some(
					(p) => p.matchActionName === name && p.effect === "require_approval",
				);

			it("names two writes in its pack: one that runs, one that waits", () => {
				expect(pack).toBeDefined();
				const runs = action(recipe.runs);
				const waits = action(recipe.waits);
				expect(runs && packActionKind(runs)).toBe("write");
				expect(waits && packActionKind(waits)).toBe("write");
				expect(gated(recipe.runs)).toBe(false);
				expect(gated(recipe.waits)).toBe(true);
			});

			it("declares every blank its prompt uses, and uses every field it declares", () => {
				const used = new Set(
					[...recipe.prompt.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]),
				);
				expect([...used].sort()).toEqual(
					[...new Set(recipe.fields.map((f) => f.key))].sort(),
				);
			});
		});
	}
});

describe("fillPrompt", () => {
	const github = recipeFor("github");
	if (!github) throw new Error("github recipe missing");

	it("puts the developer's values in", () => {
		expect(fillPrompt(github, { repo: "acme/api" })).toContain(
			"open issues in acme/api.",
		);
	});

	it("keeps the placeholder for a blank, so the prompt still reads", () => {
		expect(fillPrompt(github, { repo: "  " })).toContain(
			"open issues in owner/repo.",
		);
	});
});

describe("connectedAccount", () => {
	it("picks the newest account connected for the integration, either way it was connected", () => {
		const accounts = [
			{
				name: "GITHUB",
				integrationId: "github",
				connection: null,
				createdAt: "2026-10-01T00:00:00Z",
			},
			{
				name: "GITHUB_WORK",
				integrationId: null,
				connection: { integrationId: "github", status: "active" as const },
				createdAt: "2026-10-02T00:00:00Z",
			},
			{
				name: "STRIPE",
				integrationId: "stripe",
				connection: null,
				createdAt: "2026-10-03T00:00:00Z",
			},
		];
		expect(connectedAccount(accounts, "github")).toEqual({
			name: "GITHUB_WORK",
		});
		expect(connectedAccount(accounts, "notion")).toBeNull();
		expect(connectedAccount(accounts, null)).toBeNull();
	});
});

describe("journeyCalls and waitedWriteDecided", () => {
	const calls = [
		invocation({ id: "a", actionName: "github-list-issues" }),
		invocation({
			id: "b",
			actionName: "github-close-issue",
			status: "pending_approval",
			approvalId: "apr_1",
			createdAt: "2026-10-16T10:01:00.000Z",
		}),
		invocation({
			id: "old",
			actionName: "github-list-issues",
			createdAt: "2026-10-15T10:00:00.000Z",
		}),
		invocation({ id: "other", actionName: "stripe-get-balance" }),
	];

	it("keeps this integration's calls since the journey began, newest first", () => {
		expect(
			journeyCalls(calls, "github-", "2026-10-16T00:00:00.000Z").map(
				(c) => c.id,
			),
		).toEqual(["b", "a"]);
	});

	it("is not done while the waiting write is still waiting", () => {
		expect(waitedWriteDecided(calls, "github-close-issue")).toBeNull();
	});

	it("is done once the waiting write was approved or denied", () => {
		const approved = calls.map((c) =>
			c.id === "b" ? { ...c, status: "succeeded" as const } : c,
		);
		expect(waitedWriteDecided(approved, "github-close-issue")?.id).toBe("b");
		const denied = calls.map((c) =>
			c.id === "b" ? { ...c, status: "failed" as const } : c,
		);
		expect(waitedWriteDecided(denied, "github-close-issue")?.id).toBe("b");
	});
});

describe("quickstartStep", () => {
	it("walks pick, connect, tools, agent, done", () => {
		const base = {
			integrationId: null,
			account: null,
			toolsReady: false,
			decided: null,
		};
		expect(quickstartStep(base)).toBe("pick");
		expect(quickstartStep({ ...base, integrationId: "github" })).toBe(
			"connect",
		);
		expect(
			quickstartStep({
				...base,
				integrationId: "github",
				account: { name: "GITHUB" },
			}),
		).toBe("tools");
		expect(
			quickstartStep({
				...base,
				integrationId: "github",
				account: { name: "GITHUB" },
				toolsReady: true,
			}),
		).toBe("agent");
		expect(
			quickstartStep({
				integrationId: "github",
				account: { name: "GITHUB" },
				toolsReady: true,
				decided: invocation(),
			}),
		).toBe("done");
	});
});

describe("callLabel", () => {
	it("says what happened in the developer's words", () => {
		expect(
			callLabel({ status: "pending_approval", approvalId: "a" }).text,
		).toBe("Waiting for you");
		expect(callLabel({ status: "succeeded", approvalId: null }).text).toBe(
			"Ran",
		);
		expect(callLabel({ status: "succeeded", approvalId: "a" }).text).toBe(
			"Approved, ran",
		);
		expect(callLabel({ status: "failed", approvalId: "a" }).text).toBe(
			"Not run",
		);
	});
});
