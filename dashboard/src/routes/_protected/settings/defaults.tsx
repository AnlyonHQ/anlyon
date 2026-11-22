import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	ActingForQuestion,
	AlwaysOnList,
	ChannelsQuestion,
	DeciderQuestion,
	RedirectQuestion,
	SomethingWrongQuestions,
	WindowQuestion,
} from "@/components/defaults/questions";
import { useDefaultsSources } from "@/components/defaults/use-defaults-sources";
import {
	LearnMore,
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import { useSaveWorkspaceDefaults } from "@/hooks/api/use-workspace-defaults";
import { redirectUrlProblem } from "@/lib/end-users";
import { formatRelative } from "@/lib/time";
import type { WorkspaceDefaults } from "@/lib/types";
import {
	actsForUsers,
	changesAnything,
	type DefaultsAnswers,
	type DefaultsGroup,
	groupChanged,
	initialAnswers,
	saveFor,
} from "@/lib/workspace-defaults";

export const Route = createFileRoute("/_protected/settings/defaults")({
	component: DefaultsSettingsPage,
});

const DEFAULTS_SECTIONS = {
	who: "who-your-agent-acts-for",
	decide: "who-decides",
	wrong: "when-something-goes-wrong",
} as const;

export function DefaultsSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const sources = useDefaultsSources(workspaceId);
	const { defaults, preferences, environment } = sources;

	if (sources.isLoading || !defaults || !workspaceId) {
		return (
			<SettingsPage
				description="What happens when nothing more specific decides."
				title="Defaults"
			>
				{sources.isError ? (
					<p className="text-muted-foreground text-sm">
						Your defaults could not be loaded. Reload the page to try again.
					</p>
				) : (
					<>
						<Skeleton className="h-48 w-full rounded-lg" />
						<Skeleton className="h-64 w-full rounded-lg" />
					</>
				)}
			</SettingsPage>
		);
	}

	return (
		<DefaultsForm
			key={`${defaults.updatedAt}-${preferences?.updatedAt}-${environment?.defaultRedirectUrl}`}
			defaults={defaults}
			sources={sources}
			workspaceId={workspaceId}
		/>
	);
}

function DefaultsForm({
	workspaceId,
	defaults,
	sources,
}: {
	workspaceId: string;
	defaults: WorkspaceDefaults;
	sources: ReturnType<typeof useDefaultsSources>;
}) {
	const { preferences, environment, canEdit, roleKnown } = sources;
	const saved = { defaults, preferences, environment };
	const [initial] = useState(() =>
		initialAnswers({ defaults, preferences, environment, recommended: false }),
	);
	const [drafts, setDrafts] = useState<Record<DefaultsGroup, DefaultsAnswers>>({
		who: initial,
		decide: initial,
		wrong: initial,
	});
	const [redirectProblem, setRedirectProblem] = useState<string | null>(null);
	const save = useSaveWorkspaceDefaults(workspaceId, {
		source: "defaults_page",
	});
	const [saving, setSaving] = useState<DefaultsGroup | null>(null);

	useScrollToHash();

	const setDraft = (group: DefaultsGroup) => (answers: DefaultsAnswers) => {
		if (group === "who" && answers.redirectUrl !== drafts.who.redirectUrl)
			setRedirectProblem(null);
		setDrafts((current) => ({ ...current, [group]: answers }));
	};
	const pending = (group: DefaultsGroup) =>
		saveFor(drafts[group], saved, [group]);
	const dirty = (group: DefaultsGroup) =>
		groupChanged(group, drafts[group], initial) &&
		changesAnything(pending(group));

	const submit = (group: DefaultsGroup) => {
		if (group === "who" && actsForUsers(drafts.who.actingFor)) {
			const typed = drafts.who.redirectUrl.trim();
			const problem = typed ? redirectUrlProblem(typed) : null;
			if (problem) {
				setRedirectProblem(problem);
				return;
			}
		}
		setSaving(group);
		save.mutate(pending(group), { onSettled: () => setSaving(null) });
	};

	const footer = (group: DefaultsGroup) =>
		canEdit ? (
			<>
				{dirty(group) ? (
					<Button
						disabled={save.isPending}
						onClick={() =>
							setDrafts((current) => ({ ...current, [group]: initial }))
						}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
				) : null}
				<Button
					disabled={!dirty(group) || save.isPending}
					loading={saving === group}
					onClick={() => submit(group)}
					size="sm"
				>
					Save
				</Button>
			</>
		) : undefined;

	const disabled = !canEdit || save.isPending;
	const whoFor = (group: DefaultsGroup): DefaultsAnswers => ({
		...drafts[group],
		actingFor: group === "who" ? drafts.who.actingFor : initial.actingFor,
	});

	return (
		<SettingsPage
			description={
				<>
					What happens when nothing more specific decides. These apply to every
					environment.
					{roleKnown && !canEdit ? " An admin changes these." : ""}{" "}
					<LearnMore href="https://docs.anlyon.com/trust-control/workspace-defaults" />
				</>
			}
			title="Defaults"
		>
			{defaults.actingFor === null ? (
				<p className="-mt-4 text-[13px] text-muted-foreground">
					Nothing has been chosen yet, so each question shows what applies now.
				</p>
			) : null}

			<SettingsSection
				description="Whose accounts your agent works in."
				flush
				footer={footer("who")}
				id={DEFAULTS_SECTIONS.who}
				title="Who your agent acts for"
			>
				<Stack>
					<ActingForQuestion
						answers={drafts.who}
						disabled={disabled}
						onChange={setDraft("who")}
						recommended={defaults.recommended.actingFor}
						variant="flush"
					/>
					{sources.asksRedirect && actsForUsers(drafts.who.actingFor) ? (
						<RedirectQuestion
							answers={drafts.who}
							disabled={disabled}
							environment={environment}
							onChange={setDraft("who")}
							problem={redirectProblem}
							variant="flush"
						/>
					) : null}
				</Stack>
			</SettingsSection>

			<SettingsSection
				description="When a call needs a yes before it runs."
				flush
				footer={footer("decide")}
				id={DEFAULTS_SECTIONS.decide}
				title="Who decides"
			>
				<Stack>
					{actsForUsers(initial.actingFor) ? (
						<DeciderQuestion
							answers={whoFor("decide")}
							disabled={disabled}
							onChange={setDraft("decide")}
							variant="flush"
						/>
					) : null}
					<WindowQuestion
						answers={drafts.decide}
						disabled={disabled}
						onChange={setDraft("decide")}
						recommendedHours={defaults.recommended.approvalWindowHours}
						variant="flush"
					/>
					<ChannelsQuestion
						answers={drafts.decide}
						disabled={disabled}
						onChange={setDraft("decide")}
						preferences={preferences}
						slack={sources.slack}
						variant="flush"
					/>
				</Stack>
			</SettingsSection>

			<SettingsSection
				description="What happens, and who hears about it."
				flush
				footer={footer("wrong")}
				id={DEFAULTS_SECTIONS.wrong}
				title="When something goes wrong"
			>
				<Stack>
					<SomethingWrongQuestions
						answers={whoFor("wrong")}
						disabled={disabled}
						hasRedirect={Boolean(environment?.defaultRedirectUrl)}
						onChange={setDraft("wrong")}
						variant="flush"
					/>
				</Stack>
			</SettingsSection>

			<SettingsSection
				description="These hold whatever you choose above."
				flush
				title="Always on"
			>
				<AlwaysOnList variant="flush" />
			</SettingsSection>

			{defaults.updatedAt ? (
				<p className="text-[12px] text-muted-foreground">
					Last changed {formatRelative(defaults.updatedAt)}.
				</p>
			) : null}
		</SettingsPage>
	);
}

function Stack({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-border [&>*:not(:first-child)]:pt-1">
			{children}
		</div>
	);
}

function useScrollToHash() {
	useEffect(() => {
		const id = window.location.hash.replace(/^#/, "");
		if (!id) return;
		const target = document.getElementById(id);
		if (!target) return;
		const reduce = window.matchMedia?.(
			"(prefers-reduced-motion: reduce)",
		).matches;
		target.scrollIntoView({
			behavior: reduce ? "auto" : "smooth",
			block: "start",
		});
	}, []);
}
