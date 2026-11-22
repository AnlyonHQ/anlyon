import type { SaveDefaultsInput } from "@/hooks/api/use-workspace-defaults";
import { isAllowedRedirect, normalizeRedirectUrl } from "@/lib/end-users";
import type {
	ActingFor,
	ApprovalDecider,
	Environment,
	NotificationPreferences,
	NotificationType,
	WorkspaceDefaults,
} from "@/lib/types";

export interface DefaultsAnswers {
	actingFor: ActingFor;
	redirectUrl: string;
	endUserDecider: ApprovalDecider;
	deciderFollows: boolean;
	approvalWindowHours: number;
	emailAlerts: boolean;
	slackAlerts: boolean;
	tellOnUnknown: boolean;
	tellOnBroken: boolean;
	tellOnExpired: boolean;
}

export const RECOMMENDED_DECIDER: ApprovalDecider = "team";

export function actsForUsers(actingFor: ActingFor): boolean {
	return actingFor === "users" || actingFor === "both";
}

export function actsForTeam(actingFor: ActingFor): boolean {
	return actingFor === "team" || actingFor === "both";
}

export const ALERT_FOR = {
	tellOnUnknown: "outcome_unknown",
	tellOnBroken: "connection_broken",
	tellOnExpired: "approval_expired",
} as const satisfies Record<string, NotificationType>;

type AlertAnswer = keyof typeof ALERT_FOR;
const ALERT_ANSWERS = Object.keys(ALERT_FOR) as AlertAnswer[];

const WINDOW_HOURS = [1, 4, 24, 72, 168];

export function windowOptions(...extra: number[]): number[] {
	return [...new Set([...WINDOW_HOURS, ...extra])].sort((a, b) => a - b);
}

export function windowLabel(hours: number): string {
	if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
	return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function initialAnswers({
	defaults,
	preferences,
	environment,
	recommended,
}: {
	defaults: WorkspaceDefaults;
	preferences: NotificationPreferences | undefined;
	environment: Environment | undefined;
	recommended: boolean;
}): DefaultsAnswers {
	const actingFor = recommended
		? (defaults.actingFor ?? defaults.recommended.actingFor)
		: (defaults.actingFor ?? "team");
	const deciderFollows = recommended || defaults.endUserDecider === null;
	const enabled = new Set(preferences?.enabledTypes ?? []);
	const alertOn = (type: NotificationType) => recommended || enabled.has(type);
	return {
		actingFor,
		redirectUrl: environment?.defaultRedirectUrl ?? "",
		endUserDecider: deciderFollows
			? RECOMMENDED_DECIDER
			: (defaults.endUserDecider ?? RECOMMENDED_DECIDER),
		deciderFollows,
		approvalWindowHours:
			recommended && defaults.approvalWindowHours === null
				? defaults.recommended.approvalWindowHours
				: defaults.effective.approvalWindowHours,
		emailAlerts: preferences?.emailEnabled ?? true,
		slackAlerts: preferences?.slackEnabled ?? false,
		tellOnUnknown: alertOn(ALERT_FOR.tellOnUnknown),
		tellOnBroken: alertOn(ALERT_FOR.tellOnBroken),
		tellOnExpired: alertOn(ALERT_FOR.tellOnExpired),
	};
}

export function recommendedAnswers(
	defaults: WorkspaceDefaults,
	current: DefaultsAnswers,
): DefaultsAnswers {
	const actingFor = defaults.recommended.actingFor;
	return {
		...current,
		actingFor,
		endUserDecider: RECOMMENDED_DECIDER,
		deciderFollows: true,
		approvalWindowHours: defaults.recommended.approvalWindowHours,
		tellOnUnknown: true,
		tellOnBroken: true,
		tellOnExpired: true,
	};
}

export function withActingFor(
	answers: DefaultsAnswers,
	actingFor: ActingFor,
): DefaultsAnswers {
	return { ...answers, actingFor };
}

export function withDecider(
	answers: DefaultsAnswers,
	endUserDecider: ApprovalDecider,
): DefaultsAnswers {
	return {
		...answers,
		endUserDecider,
		deciderFollows: endUserDecider === RECOMMENDED_DECIDER,
	};
}

export type DefaultsGroup = "who" | "decide" | "wrong";

export function saveFor(
	answers: DefaultsAnswers,
	saved: {
		defaults: WorkspaceDefaults;
		preferences: NotificationPreferences | undefined;
		environment: Environment | undefined;
	},
	groups: DefaultsGroup[] = ["who", "decide", "wrong"],
): SaveDefaultsInput {
	const input: SaveDefaultsInput = {};
	const defaults: NonNullable<SaveDefaultsInput["defaults"]> = {};
	const preferences: NonNullable<SaveDefaultsInput["preferences"]> = {};
	const { environment } = saved;

	if (groups.includes("who")) {
		if (answers.actingFor !== saved.defaults.actingFor)
			defaults.actingFor = answers.actingFor;
		const typed = answers.redirectUrl.trim();
		const current = environment?.defaultRedirectUrl ?? "";
		if (environment && actsForUsers(answers.actingFor) && typed !== current) {
			if (!typed) {
				input.redirect = {
					environmentId: environment.id,
					defaultRedirectUrl: null,
				};
			} else {
				const url = normalizeRedirectUrl(typed);
				const allowed = environment.allowedRedirectUrls ?? [];
				input.redirect = {
					environmentId: environment.id,
					defaultRedirectUrl: url,
					...(isAllowedRedirect(url, allowed)
						? {}
						: { allowedRedirectUrls: [...allowed, url] }),
				};
			}
		}
	}

	if (groups.includes("decide")) {
		const decider = answers.deciderFollows ? null : answers.endUserDecider;
		if (decider !== saved.defaults.endUserDecider)
			defaults.endUserDecider = decider;
	}

	if (groups.includes("decide")) {
		const window =
			answers.approvalWindowHours ===
			saved.defaults.recommended.approvalWindowHours
				? null
				: answers.approvalWindowHours;
		if (window !== saved.defaults.approvalWindowHours)
			defaults.approvalWindowHours = window;
		if (answers.emailAlerts !== (saved.preferences?.emailEnabled ?? true))
			preferences.emailEnabled = answers.emailAlerts;
		if (answers.slackAlerts !== (saved.preferences?.slackEnabled ?? false))
			preferences.slackEnabled = answers.slackAlerts;
	}

	if (groups.includes("wrong") && saved.preferences) {
		const enabled = new Set(saved.preferences.enabledTypes);
		const next = new Set(enabled);
		for (const answer of ALERT_ANSWERS) {
			if (answers[answer]) next.add(ALERT_FOR[answer]);
			else next.delete(ALERT_FOR[answer]);
		}
		if (
			next.size !== enabled.size ||
			[...next].some((type) => !enabled.has(type))
		)
			preferences.enabledTypes = [...next];
	}

	if (Object.keys(defaults).length > 0) input.defaults = defaults;
	if (Object.keys(preferences).length > 0) input.preferences = preferences;
	return input;
}

export function changesAnything(input: SaveDefaultsInput): boolean {
	return Boolean(input.defaults || input.preferences || input.redirect);
}

const GROUP_FIELDS: Record<DefaultsGroup, (keyof DefaultsAnswers)[]> = {
	who: ["actingFor", "redirectUrl"],
	decide: [
		"endUserDecider",
		"approvalWindowHours",
		"emailAlerts",
		"slackAlerts",
	],
	wrong: ["tellOnUnknown", "tellOnBroken", "tellOnExpired"],
};

export function groupChanged(
	group: DefaultsGroup,
	answers: DefaultsAnswers,
	shown: DefaultsAnswers,
): boolean {
	return GROUP_FIELDS[group].some((field) =>
		field === "redirectUrl"
			? answers.redirectUrl.trim() !== shown.redirectUrl.trim()
			: answers[field] !== shown[field],
	);
}
