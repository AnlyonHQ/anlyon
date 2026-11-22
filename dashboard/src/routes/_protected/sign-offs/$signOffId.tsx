"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { Page, PageHeader, PageSection } from "@/components/layout/page";
import {
	SignOffChanges,
	SignOffDecision,
	SignOffPlainDiff,
	SignOffStatusBadge,
} from "@/components/sign-offs/sign-off-review";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import { useActorNames } from "@/hooks/api/use-actor-names";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useWorkspacePermissions } from "@/hooks/api/use-permissions";
import { useDecideSignOff, useSignOffLookup } from "@/hooks/api/use-sign-offs";
import { describeRequester, type SignOffRequest } from "@/lib/sign-offs";

export const Route = createFileRoute("/_protected/sign-offs/$signOffId")({
	component: SignOffRoute,
});

function SignOffRoute() {
	const { signOffId } = Route.useParams();
	return <SignOffPage signOffId={signOffId} />;
}

export function SignOffPage({ signOffId }: { signOffId: string }) {
	const { currentWorkspace, workspaces, switchWorkspace } = useWorkspace();
	const currentId = currentWorkspace?.id;
	const order = useMemo(
		() =>
			currentId
				? [
						currentId,
						...workspaces.map((w) => w.id).filter((id) => id !== currentId),
					]
				: [],
		[currentId, workspaces],
	);
	const lookup = useSignOffLookup(signOffId, order);
	const found = lookup.data;
	const elsewhere =
		found && currentId && found.workspaceId !== currentId
			? workspaces.find((w) => w.id === found.workspaceId)
			: undefined;

	const elsewhereId = elsewhere?.id;
	const tried = useRef<string | null>(null);
	useEffect(() => {
		if (!elsewhereId || tried.current === elsewhereId) return;
		tried.current = elsewhereId;
		switchWorkspace(elsewhereId);
	}, [elsewhereId, switchWorkspace]);

	if (!currentId || lookup.isLoading) {
		return (
			<Page aria-busy="true" width="narrow">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-7 w-3/4" />
				<Skeleton className="h-40 w-full rounded-lg" />
			</Page>
		);
	}

	if (lookup.isError) {
		return (
			<SignOffMissing
				description={(lookup.error as Error).message}
				title="This sign-off request could not be loaded"
			/>
		);
	}

	if (!found) {
		return (
			<SignOffMissing
				description="No workspace you belong to has a sign-off request with this id. Check the link, or ask the person who sent it which workspace it is in."
				title="Not found in your workspaces"
			/>
		);
	}

	if (elsewhere) {
		return (
			<Page width="narrow">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<output className="text-muted-foreground">
						This request is in {elsewhere.name}.
					</output>
					<Button
						onClick={() => switchWorkspace(elsewhere.id)}
						size="xs"
						variant="outline"
					>
						Open {elsewhere.name}
					</Button>
				</div>
			</Page>
		);
	}

	return (
		<SignOffReview signOff={found.signOff} workspaceId={found.workspaceId} />
	);
}

function SignOffMissing({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Empty className="py-16">
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button render={<Link to="/sign-offs" />} size="sm" variant="outline">
					View sign-offs
				</Button>
			</EmptyContent>
		</Empty>
	);
}

export function SignOffReview({
	signOff,
	workspaceId,
}: {
	signOff: SignOffRequest;
	workspaceId: string;
}) {
	const nameOf = useActorNames(workspaceId);
	const environments = useEnvironments(workspaceId).data;
	const permissions = useWorkspacePermissions(workspaceId).data;
	const decide = useDecideSignOff();

	const canDecide =
		!permissions ||
		permissions.role === "admin" ||
		(permissions.permissions as string[]).includes("governance.sign_off");

	const environment = signOff.environmentId
		? environments?.find((env) => env.id === signOff.environmentId)
		: undefined;
	const requester = describeRequester(signOff.requestedBy, nameOf);
	const decidedBy = signOff.decidedBy
		? nameOf({ type: "user", id: signOff.decidedBy.id }).text
		: undefined;

	return (
		<Page width="narrow">
			<PageHeader
				actions={
					<Button render={<Link to="/sign-offs" />} size="sm" variant="outline">
						All sign-offs
					</Button>
				}
				eyebrow="Sign-off request"
				meta={<SignOffStatusBadge status={signOff.status} />}
				title={
					<span className="whitespace-normal text-balance">
						{signOff.summary}
					</span>
				}
			/>

			<dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-[13px] sm:grid-cols-3">
				<div className="min-w-0">
					<dt className="text-muted-foreground text-xs">Asked by</dt>
					<dd className="mt-0.5 break-words" title={requester.title}>
						{requester.text}
					</dd>
				</div>
				<div className="min-w-0">
					<dt className="text-muted-foreground text-xs">Environment</dt>
					<dd className="mt-0.5 break-words">
						{environment?.name ??
							(signOff.environmentId ? (
								<span className="font-mono text-xs" translate="no">
									{signOff.environmentId}
								</span>
							) : (
								"The whole workspace"
							))}
					</dd>
				</div>
				<div className="min-w-0">
					<dt className="text-muted-foreground text-xs">Asked</dt>
					<dd className="mt-0.5">
						<RelativeTime value={signOff.createdAt} />
					</dd>
				</div>
			</dl>

			<PageSection
				description={
					<>
						<span className="font-mono text-xs" translate="no">
							{signOff.operation}
						</span>
						{signOff.resource ? (
							<>
								{" on "}
								{signOff.resource.name ? (
									<span className="text-foreground">
										{signOff.resource.name}
									</span>
								) : (
									<span className="font-mono text-xs" translate="no">
										{signOff.resource.id}
									</span>
								)}
							</>
						) : null}
					</>
				}
				title="What changes"
			>
				<SignOffChanges changes={signOff.changes} />
				<SignOffPlainDiff diff={signOff.diff} />
			</PageSection>

			<SignOffDecision
				canDecide={canDecide}
				decidedByName={decidedBy}
				error={decide.error}
				onDecide={(input, options) =>
					decide.mutate(
						{ workspaceId, signOffId: signOff.id, ...input },
						options,
					)
				}
				pending={decide.isPending}
				signOff={signOff}
			/>

			<p
				className="font-mono text-[11px] text-muted-foreground/70"
				translate="no"
			>
				{signOff.id}
			</p>
		</Page>
	);
}
