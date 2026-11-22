import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useId, useMemo } from "react";
import {
	GROUPS,
	GroupExtras,
	GroupFields,
	InstanceAdminsList,
	RootKeyBackup,
	StatusText,
	useAdminNames,
	useSettingsDraft,
} from "@/components/instance/instance-settings";
import { StatusDot } from "@/components/instance/status-dot";
import {
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { SettingsSaveBar } from "@/components/settings/settings-save-bar";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type InstanceSetting,
	type InstanceSettingGroup,
	type InstanceStatus,
	isForbidden,
	useInstanceAdmins,
	useInstanceSettings,
	useInstanceStatus,
	useServerHealth,
	useUpdateInstanceSettings,
} from "@/hooks/api/use-instance";
import { useAuth } from "@/hooks/use-auth";
import {
	combineStatus,
	groupStatus,
	type StatusLine,
	shortDate,
} from "@/lib/instance-onboarding";
import { isSelfHosted } from "@/lib/runtime-config";

export const Route = createFileRoute("/_protected/settings/instance")({
	component: InstanceSettingsPage,
});

type SectionId =
	| "general"
	| "email"
	| "storage"
	| "sign-in"
	| "integrations"
	| "mcp"
	| "network"
	| "licence"
	| "telemetry"
	| "admins";

const SECTIONS: {
	id: SectionId;
	title: string;
	description: string;
	groups: InstanceSettingGroup[];
}[] = [
	{
		id: "general",
		title: "General",
		description: "This server's edition, version and root key.",
		groups: [],
	},
	{
		id: "email",
		title: "Email",
		description: GROUPS.email.description,
		groups: ["email"],
	},
	{
		id: "storage",
		title: "File storage",
		description: GROUPS.storage.description,
		groups: ["storage"],
	},
	{
		id: "sign-in",
		title: "Sign-in and sign-up",
		description: GROUPS.accounts.description,
		groups: ["accounts"],
	},
	{
		id: "integrations",
		title: "Integrations and Slack",
		description:
			"The OAuth apps people sign in to for connected accounts, and the Slack app for notifications and approvals.",
		groups: ["oauth", "slack"],
	},
	{
		id: "mcp",
		title: "MCP servers",
		description: GROUPS.mcp.description,
		groups: ["mcp"],
	},
	{
		id: "network",
		title: "Network",
		description: GROUPS.network.description,
		groups: ["network"],
	},
	{
		id: "licence",
		title: "Licence",
		description: GROUPS.license.description,
		groups: ["license"],
	},
	{
		id: "telemetry",
		title: "Telemetry",
		description: GROUPS.telemetry.description,
		groups: ["telemetry"],
	},
	{
		id: "admins",
		title: "Instance admins",
		description:
			"The people who may change these settings. Separate from workspace roles.",
		groups: [],
	},
];

const EDITION_LABEL: Record<InstanceStatus["edition"], string> = {
	community: "Community",
	team: "Team",
	enterprise: "Enterprise",
};

function generalStatus(status: InstanceStatus): StatusLine {
	const { rootKey } = status;
	const base = {
		fromEnvironment: false,
		updatedAt: null,
		updatedBy: null,
	};
	if (!rootKey.inUse)
		return { ...base, tone: "idle", label: "Master keys set one by one" };
	return rootKey.backupConfirmedAt
		? {
				...base,
				tone: "ok",
				label: "Root key copy confirmed",
				detail: shortDate(rootKey.backupConfirmedAt),
			}
		: {
				...base,
				tone: "warn",
				label: "Root key copy not confirmed",
			};
}

function InstanceSettingsPage() {
	const status = useInstanceStatus();
	const settings = useInstanceSettings();

	if (!isSelfHosted()) {
		return (
			<SettingsPage
				description="Settings for a self-hosted install."
				title="Instance"
			>
				<SettingsSection title="Not available">
					<p className="text-sm text-muted-foreground">
						This page configures a self-hosted install. Anlyon's hosted service
						is configured by its operators.
					</p>
				</SettingsSection>
			</SettingsPage>
		);
	}

	return (
		<SettingsPage
			description="This server's own settings. Changes apply at once, without a restart. A value set in the server's environment wins and is shown read-only."
			title="Instance"
		>
			{isForbidden(status.error) || isForbidden(settings.error) ? (
				<SettingsSection title="Instance admins only">
					<p className="text-sm text-muted-foreground">
						Only an instance admin can view or change this server's settings.
						The person who set up the server is one, and can make others.
					</p>
				</SettingsSection>
			) : !status.data || !settings.data ? (
				<div className="flex flex-col gap-4">
					<Skeleton className="h-28 w-full" />
					<Skeleton className="h-64 w-full" />
				</div>
			) : (
				<InstanceSettingsForm settings={settings.data} status={status.data} />
			)}
		</SettingsPage>
	);
}

function InstanceSettingsForm({
	settings,
	status,
}: {
	settings: InstanceSetting[];
	status: InstanceStatus;
}) {
	const { user } = useAuth();
	const nameOf = useAdminNames();
	const admins = useInstanceAdmins();
	const health = useServerHealth(30_000);
	const { draft, set, reset, errors, changed } = useSettingsDraft(settings);
	const update = useUpdateInstanceSettings();
	const groupOf = useMemo(
		() => new Map(settings.map((s) => [s.key, s.group])),
		[settings],
	);
	const dirtyGroups = new Set(changed.map((key) => groupOf.get(key)));
	const present = new Set(settings.map((s) => s.group));
	const shown = SECTIONS.filter(
		(s) => s.groups.length === 0 || s.groups.some((g) => present.has(g)),
	);

	const statusOf = (id: SectionId): StatusLine => {
		const section = SECTIONS.find((s) => s.id === id)!;
		if (id === "general") return generalStatus(status);
		if (id === "admins") {
			const count = admins.data?.length ?? 0;
			return {
				tone: count > 0 ? "ok" : "idle",
				label: admins.data
					? `${count} ${count === 1 ? "admin" : "admins"}`
					: "Loading",
				fromEnvironment: false,
				updatedAt: null,
				updatedBy: null,
			};
		}
		const [first, second] = section.groups.map((g) => groupStatus(g, settings));
		return second ? combineStatus(first!, second) : first!;
	};

	const save = () => {
		if (changed.length === 0 || Object.keys(errors).length > 0) return;
		update.mutate(draft, { onSuccess: () => reset() });
	};

	return (
		<>
			<Overview sections={shown} statusOf={statusOf} />

			<Section id="general" status={statusOf("general")}>
				<dl className="mb-6 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-[13rem_minmax(0,1fr)]">
					<dt className="text-muted-foreground">Edition</dt>
					<dd>{EDITION_LABEL[status.edition]}</dd>
					<dt className="text-muted-foreground">Build</dt>
					<dd className="font-mono text-[12.5px]">
						{health.data?.commit ?? "Not reported"}
					</dd>
					{status.setupCompletedAt ? (
						<>
							<dt className="text-muted-foreground">Set up</dt>
							<dd>{shortDate(status.setupCompletedAt)}</dd>
						</>
					) : null}
				</dl>
				<RootKeyBackup nameOf={nameOf} status={status} />
			</Section>

			{shown
				.filter((s) => s.groups.length > 0)
				.map((section) => (
					<Section
						id={section.id}
						key={section.id}
						nameOf={nameOf}
						status={statusOf(section.id)}
					>
						<div className="flex flex-col gap-8">
							{section.groups.map((group) => (
								<div className="flex flex-col gap-5" key={group}>
									{section.groups.length > 1 ? (
										<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-2">
											<h3 className="font-medium text-[14px]">
												{GROUPS[group].title}
											</h3>
											<StatusText
												nameOf={nameOf}
												status={groupStatus(group, settings)}
											/>
										</div>
									) : null}
									<GroupFields
										draft={draft}
										errors={errors}
										group={group}
										onChange={set}
										settings={settings}
									/>
									<GroupExtras
										email={user?.email}
										group={group}
										unsaved={dirtyGroups.has(group)}
									/>
								</div>
							))}
							{section.id === "sign-in" ? (
								<p className="border-t pt-4 text-[12px] text-muted-foreground">
									Single sign-on is set per workspace, in{" "}
									<Link
										className="text-foreground underline underline-offset-4"
										to="/settings/sso"
									>
										Settings, Single sign-on
									</Link>
									.
								</p>
							) : null}
						</div>
					</Section>
				))}

			<Section id="admins" status={statusOf("admins")}>
				<InstanceAdminsList currentUserId={user?.id} />
			</Section>

			<SettingsSaveBar
				dirty={changed.length > 0}
				disabled={Object.keys(errors).length > 0}
				message={saveMessage({
					changed,
					errorCount: Object.keys(errors).length,
					failure: update.error?.message ?? null,
					groups: [...dirtyGroups].filter((g): g is InstanceSettingGroup =>
						Boolean(g),
					),
				})}
				onDiscard={() => {
					reset();
					update.reset();
				}}
				onSave={save}
				saving={update.isPending}
			/>
		</>
	);
}

function Overview({
	sections,
	statusOf,
}: {
	sections: typeof SECTIONS;
	statusOf: (id: SectionId) => StatusLine;
}) {
	return (
		<nav
			aria-label="Instance settings"
			className="overflow-hidden rounded-lg border bg-card"
		>
			<ul className="grid sm:grid-cols-2">
				{sections.map((section, index) => {
					const status = statusOf(section.id);
					return (
						<li
							className={
								index > 0
									? index === 1
										? "border-t sm:border-t-0 sm:border-l"
										: index % 2 === 1
											? "border-t sm:border-l"
											: "border-t"
									: undefined
							}
							key={section.id}
						>
							<a
								className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] outline-none transition-colors duration-150 ease-out hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
								href={`#${section.id}`}
							>
								<span className="flex min-w-0 items-center gap-2">
									<StatusDot tone={status.tone} />
									<span className="truncate font-medium">{section.title}</span>
								</span>
								<span className="truncate text-[12px] text-muted-foreground">
									{status.label}
								</span>
							</a>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

function Section({
	id,
	status,
	nameOf,
	children,
}: {
	id: SectionId;
	status: StatusLine;
	nameOf?: (userId: string | null) => string | null;
	children: ReactNode;
}) {
	const section = SECTIONS.find((s) => s.id === id)!;
	const titleId = useId();
	return (
		<section
			aria-labelledby={titleId}
			className="flex min-w-0 scroll-mt-20 flex-col gap-5 [[data-settings-section]+&]:border-t [[data-settings-section]+&]:pt-8"
			data-settings-section={section.title}
			id={id}
		>
			<header className="flex flex-col gap-0.5">
				<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
					<h3
						className="font-semibold text-[15px] text-foreground leading-6 tracking-tight"
						id={titleId}
					>
						{section.title}
					</h3>
					{section.groups.length === 1 || section.groups.length === 0 ? (
						<StatusText nameOf={nameOf} status={status} />
					) : null}
				</div>
				<p className="max-w-xl text-pretty text-muted-foreground text-sm leading-relaxed">
					{section.description}
				</p>
			</header>
			<div className="min-w-0">{children}</div>
		</section>
	);
}

function saveMessage({
	changed,
	groups,
	errorCount,
	failure,
}: {
	changed: string[];
	groups: InstanceSettingGroup[];
	errorCount: number;
	failure: string | null;
}): ReactNode {
	if (failure)
		return <span className="text-destructive-foreground">{failure}</span>;
	if (errorCount > 0)
		return (
			<span className="text-destructive-foreground">
				{errorCount === 1
					? "One value needs fixing before saving."
					: `${errorCount} values need fixing before saving.`}
			</span>
		);
	return (
		<>
			<span className="font-medium">
				{changed.length} unsaved {changed.length === 1 ? "change" : "changes"}
			</span>
			<span className="text-muted-foreground">
				{" "}
				in {groups.map((g) => GROUPS[g].title).join(", ")}
			</span>
		</>
	);
}
