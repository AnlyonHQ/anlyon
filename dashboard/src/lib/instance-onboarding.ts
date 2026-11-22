import type {
	InstanceSetting,
	InstanceSettingGroup,
} from "@/hooks/api/use-instance";

export type Tone = "ok" | "warn" | "idle";

export interface StatusLine {
	tone: Tone;
	label: string;
	detail?: string;
	fromEnvironment: boolean;
	updatedAt: string | null;
	updatedBy: string | null;
}

const has = (settings: InstanceSetting[], key: string) =>
	settings.find((s) => s.key === key)?.set ?? false;
const valueIn = (settings: InstanceSetting[], key: string) => {
	const setting = settings.find((s) => s.key === key);
	return setting?.value ?? setting?.default ?? null;
};

function lastChange(inGroup: InstanceSetting[]) {
	let newest: InstanceSetting | null = null;
	for (const setting of inGroup) {
		if (!setting.updatedAt || setting.source !== "database") continue;
		if (!newest || setting.updatedAt > (newest.updatedAt ?? ""))
			newest = setting;
	}
	return {
		updatedAt: newest?.updatedAt ?? null,
		updatedBy: newest?.updatedBy ?? null,
	};
}

function allFromEnvironment(inGroup: InstanceSetting[]): boolean {
	const inForce = inGroup.filter(
		(s) => s.source === "environment" || s.source === "database",
	);
	return inForce.length > 0 && inForce.every((s) => s.source === "environment");
}

const OAUTH_PROVIDERS: { id: string; name: string }[] = [
	{ id: "hubspot", name: "HubSpot" },
	{ id: "slack", name: "Slack" },
	{ id: "google", name: "Google" },
	{ id: "linear", name: "Linear" },
	{ id: "salesforce", name: "Salesforce" },
];

export function configuredOAuthApps(settings: InstanceSetting[]): string[] {
	return OAUTH_PROVIDERS.filter(
		({ id }) =>
			has(settings, `oauth.${id}.client_id`) &&
			has(settings, `oauth.${id}.client_secret`),
	).map(({ name }) => name);
}

export function groupStatus(
	group: InstanceSettingGroup,
	settings: InstanceSetting[],
): StatusLine {
	const inGroup = settings.filter((s) => s.group === group);
	const base = {
		fromEnvironment: allFromEnvironment(inGroup),
		...lastChange(inGroup),
	};
	const configured = (detail?: string): StatusLine => ({
		...base,
		tone: "ok",
		label: base.fromEnvironment ? "Set by environment" : "Configured",
		detail,
	});
	const partial = (detail: string): StatusLine => ({
		...base,
		tone: "warn",
		label: "Incomplete",
		detail,
	});
	const off = (label: string, detail?: string): StatusLine => ({
		...base,
		tone: "idle",
		label,
		detail,
	});

	switch (group) {
		case "email": {
			const smtp = has(settings, "email.smtp_url");
			const from = has(settings, "email.from");
			if (smtp && from)
				return configured(`Sends as ${valueIn(settings, "email.from")}`);
			if (smtp) return partial("Needs a sender address");
			if (from) return partial("Needs an SMTP server");
			return off(
				"Not configured",
				"Invitation links are shown for you to pass on",
			);
		}
		case "storage": {
			const backend = valueIn(settings, "storage.backend") ?? "none";
			if (backend === "local") return configured("A directory on this server");
			if (backend === "s3") {
				if (!has(settings, "storage.s3_bucket"))
					return partial("Needs a bucket");
				return configured(
					`S3 bucket ${valueIn(settings, "storage.s3_bucket")}`,
				);
			}
			return off("Not configured", "Log archives are not kept");
		}
		case "accounts": {
			const mode = valueIn(settings, "accounts.signup_mode") ?? "invite";
			const label =
				mode === "open"
					? "Anyone who can reach the console"
					: mode === "closed"
						? "Nobody; accounts from the command line"
						: "Invite only";
			const isDefault = !inGroup.some(
				(s) => s.source === "database" || s.source === "environment",
			);
			return isDefault
				? off("Default", label)
				: { ...configured(label), tone: mode === "open" ? "warn" : "ok" };
		}
		case "license":
			return has(settings, "license.key")
				? configured("Licence key saved")
				: off("Not configured", "Community edition");
		case "telemetry": {
			const on = (valueIn(settings, "telemetry.enabled") ?? "true") === "true";
			const isDefault = !inGroup.some(
				(s) => s.source === "database" || s.source === "environment",
			);
			if (isDefault) return off("Default", on ? "On" : "Off");
			return { ...configured(on ? "On" : "Off"), tone: on ? "ok" : "idle" };
		}
		case "oauth": {
			const apps = configuredOAuthApps(settings);
			const started = OAUTH_PROVIDERS.some(
				({ id }) =>
					has(settings, `oauth.${id}.client_id`) !==
					has(settings, `oauth.${id}.client_secret`),
			);
			if (started) return partial("An app is missing its id or secret");
			if (apps.length === 0)
				return off(
					"Not configured",
					"Integrations that sign in are not offered",
				);
			return configured(apps.join(", "));
		}
		case "slack": {
			const keys = [
				"slack.client_id",
				"slack.client_secret",
				"slack.signing_secret",
			];
			const count = keys.filter((key) => has(settings, key)).length;
			if (count === keys.length)
				return configured("Notifications and approvals");
			if (count > 0)
				return partial(`${keys.length - count} of 3 values missing`);
			return off("Not configured");
		}
		case "network": {
			const refused =
				(valueIn(settings, "network.private_destinations") ?? "workspace") !==
				"workspace";
			const detail = refused
				? "Private network destinations off"
				: "Workspace admins decide on private destinations";
			const isDefault = !inGroup.some(
				(s) => s.source === "database" || s.source === "environment",
			);
			return isDefault ? off("Default", detail) : configured(detail);
		}
		case "mcp": {
			const hours = valueIn(settings, "mcp.tool_check_interval_hours") ?? "24";
			const detail = `Every ${hours} ${hours === "1" ? "hour" : "hours"}`;
			const isDefault = !inGroup.some(
				(s) => s.source === "database" || s.source === "environment",
			);
			return isDefault ? off("Default", detail) : configured(detail);
		}
		default:
			return off("Not configured");
	}
}

export function combineStatus(a: StatusLine, b: StatusLine): StatusLine {
	const rank: Record<Tone, number> = { warn: 0, ok: 1, idle: 2 };
	const [first, second] = rank[a.tone] <= rank[b.tone] ? [a, b] : [b, a];
	const newest = (a.updatedAt ?? "") > (b.updatedAt ?? "") ? a : b;
	return {
		...first,
		detail:
			first.tone === "ok" && second.tone === "ok"
				? [first.detail, second.detail].filter(Boolean).join(" · ")
				: first.detail,
		fromEnvironment: a.fromEnvironment && b.fromEnvironment,
		updatedAt: newest.updatedAt,
		updatedBy: newest.updatedBy,
	};
}

export interface Health {
	api?: boolean;
	database?: boolean;
	redis?: boolean;
}

export interface SystemCheck {
	id: "api" | "database" | "redis" | "email" | "storage";
	label: string;
	tone: Tone;
	detail: string;
}

export function systemChecks(
	health: Health,
	settings: InstanceSetting[] | undefined,
): SystemCheck[] {
	const service = (
		id: "api" | "database" | "redis",
		label: string,
		up: boolean | undefined,
	): SystemCheck => ({
		id,
		label,
		tone: up === undefined ? "idle" : up ? "ok" : "warn",
		detail: up === undefined ? "Checking" : up ? "Up" : "Not reachable",
	});
	const fromSettings = (
		id: "email" | "storage",
		label: string,
	): SystemCheck => {
		if (!settings) return { id, label, tone: "idle", detail: "After sign-in" };
		const status = groupStatus(id, settings);
		return {
			id,
			label,
			tone: status.tone,
			detail:
				status.tone === "ok"
					? "Configured"
					: status.tone === "warn"
						? "Incomplete"
						: "Off",
		};
	};
	const apiDown = health.api === false;
	return [
		service("api", "API", health.api),
		service("database", "Database", apiDown ? false : health.database),
		service("redis", "Redis", apiDown ? false : health.redis),
		fromSettings("email", "Email"),
		fromSettings("storage", "Storage"),
	];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkSettingValue(key: string, value: string): string | null {
	const v = value.trim();
	if (!v) return null;
	switch (key) {
		case "email.smtp_url":
			if (!/^smtps?:\/\/[^\s]+$/.test(v))
				return "Starts with smtp:// or smtps://";
			return null;
		case "email.from":
			return EMAIL.test(v) ? null : "Not an email address";
		case "storage.s3_endpoint":
			try {
				new URL(v);
				return null;
			} catch {
				return "Not a URL, such as https://minio.example.com";
			}
		case "mcp.tool_check_interval_hours":
			return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 168
				? null
				: "A whole number of hours, from 1 to 168";
		default:
			return null;
	}
}

export interface OwnerFields {
	name: string;
	email: string;
	password: string;
	confirm: string;
}

export function ownerProblems(
	fields: OwnerFields,
): Partial<Record<keyof OwnerFields, string>> {
	const problems: Partial<Record<keyof OwnerFields, string>> = {};
	if (!fields.name.trim()) problems.name = "Enter your name";
	if (!fields.email.trim()) problems.email = "Enter your email address";
	else if (!EMAIL.test(fields.email.trim()))
		problems.email = "Not an email address";
	if (fields.password.length < 12)
		problems.password =
			fields.password.length === 0
				? "Choose a password"
				: `${12 - fields.password.length} more ${12 - fields.password.length === 1 ? "character" : "characters"}`;
	if (fields.confirm !== fields.password)
		problems.confirm = fields.confirm
			? "Does not match"
			: "Repeat the password";
	return problems;
}

export function shortDate(iso: string | null, locale?: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	return date.toLocaleString(locale, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}
