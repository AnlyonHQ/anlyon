import { describe, expect, it } from "vitest";
import type {
	Environment,
	NotificationPreferences,
	WorkspaceDefaults,
} from "@/lib/types";
import {
	groupChanged,
	initialAnswers,
	RECOMMENDED_DECIDER,
	recommendedAnswers,
	saveFor,
	windowLabel,
	windowOptions,
	withActingFor,
	withDecider,
} from "./workspace-defaults";

const unanswered: WorkspaceDefaults = {
	actingFor: null,
	endUserDecider: null,
	approvalWindowHours: null,
	effective: { endUserDecider: "team", approvalWindowHours: 24 },
	recommended: {
		actingFor: "both",
		endUserDecider: "team",
		approvalWindowHours: 24,
	},
	setup: { status: null, at: null },
	updatedAt: null,
};

const preferences = {
	emailEnabled: true,
	slackEnabled: false,
	enabledTypes: ["approval_requested", "security_alert"],
} as NotificationPreferences;

const environment = {
	id: "env_1",
	name: "Production",
	isDefault: true,
	defaultRedirectUrl: null,
	allowedRedirectUrls: [],
} as unknown as Environment;

const saved = { defaults: unanswered, preferences, environment };

describe("workspace defaults answers", () => {
	it("recommends the team decides, whoever the agent acts for", () => {
		expect(RECOMMENDED_DECIDER).toBe("team");
		const start = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: true,
		});
		for (const actingFor of ["team", "users", "both"] as const)
			expect(withActingFor(start, actingFor).endUserDecider).toBe("team");
	});

	it("starts the journey on every recommendation", () => {
		const answers = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: true,
		});
		expect(answers).toMatchObject({
			actingFor: "both",
			endUserDecider: "team",
			deciderFollows: true,
			approvalWindowHours: 24,
			tellOnUnknown: true,
			tellOnBroken: true,
			tellOnExpired: true,
		});
	});

	it("shows what applies now on the settings page", () => {
		const answers = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: false,
		});
		expect(answers).toMatchObject({
			actingFor: "team",
			endUserDecider: "team",
			tellOnUnknown: false,
			tellOnExpired: false,
		});
	});

	it("keeps a chosen decider whoever the agent acts for", () => {
		const start = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: true,
		});
		const chosen = withDecider(start, "end_user");
		expect(chosen.deciderFollows).toBe(false);
		expect(withActingFor(chosen, "users").endUserDecider).toBe("end_user");
		expect(withDecider(chosen, "team").deciderFollows).toBe(true);
	});

	it("saves recommended answers as null so they keep following", () => {
		const start = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: true,
		});
		const input = saveFor(start, saved);
		expect(input.defaults).toEqual({ actingFor: "both" });
		expect(input.preferences?.enabledTypes).toEqual(
			expect.arrayContaining([
				"approval_requested",
				"security_alert",
				"outcome_unknown",
				"connection_broken",
				"approval_expired",
			]),
		);
		expect(input.redirect).toBeUndefined();
	});

	it("saves a chosen decider and window, and allows a new redirect URL", () => {
		const start = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: true,
		});
		const answers = {
			...withDecider(start, "end_user"),
			approvalWindowHours: 4,
			redirectUrl: "https://app.example.com/connected",
		};
		const input = saveFor(answers, saved);
		expect(input.defaults).toEqual({
			actingFor: "both",
			endUserDecider: "end_user",
			approvalWindowHours: 4,
		});
		expect(input.redirect).toEqual({
			environmentId: "env_1",
			defaultRedirectUrl: "https://app.example.com/connected",
			allowedRedirectUrls: ["https://app.example.com/connected"],
		});
	});

	it("saves one group without the others", () => {
		const start = initialAnswers({
			defaults: unanswered,
			preferences,
			environment,
			recommended: false,
		});
		const answers = { ...start, approvalWindowHours: 72, tellOnUnknown: true };
		expect(saveFor(answers, saved, ["decide"])).toEqual({
			defaults: { approvalWindowHours: 72 },
		});
		expect(groupChanged("decide", answers, start)).toBe(true);
		expect(groupChanged("who", answers, start)).toBe(false);
	});

	it("turns every alert on with Use recommended", () => {
		const quiet = withDecider(
			initialAnswers({
				defaults: unanswered,
				preferences,
				environment,
				recommended: false,
			}),
			"end_user",
		);
		expect(recommendedAnswers(unanswered, quiet)).toMatchObject({
			actingFor: "both",
			endUserDecider: "team",
			deciderFollows: true,
			tellOnUnknown: true,
			tellOnBroken: true,
			tellOnExpired: true,
		});
	});

	it("labels the window and keeps the instance default in the list", () => {
		expect(windowLabel(1)).toBe("1 hour");
		expect(windowLabel(24)).toBe("24 hours");
		expect(windowLabel(72)).toBe("3 days");
		expect(windowOptions(48, 24)).toEqual([1, 4, 24, 48, 72, 168]);
	});
});
