import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, ExternalLink } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ListEmpty } from "@/components/governance/list-empty";
import { ListFrame, PageSection } from "@/components/layout/page";
import { CopyValue } from "@/components/settings/identity-shared";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	useCreateEndUserConnectLink,
	useEndUsers,
} from "@/hooks/api/use-end-users";
import { ApiError } from "@/lib/api-client";
import type {
	EndUserConnectLink,
	Environment,
	IntegrationOverview,
} from "@/lib/types";
import { CodeSample } from "./code-sample";

function connectSnippets(integration: IntegrationOverview) {
	const id = JSON.stringify(integration.id);
	const usesKey = integration.auth?.kind === "api_key";
	const what = usesKey
		? `// The user pastes their own ${integration.name} key on Anlyon's page.`
		: `// The user signs in at ${integration.name} and approves.`;
	return {
		typescript: `// 1. Your "Connect ${integration.name}" button
const { data: link } = await anlyon.endUsers.createConnectLink({
  endUserId: user.id,
  integration: ${id},
});
return redirect(link.url); ${what}

// 2. Your redirect URL, with your user signed in
const result = parseConnectRedirect(request.url);
if (result?.status === "pending_confirmation" && result.flowId) {
  await anlyon.endUsers.confirmConnection(user.id, result.flowId);
}

// 3. Act in their account
await anlyon.forUser(user.id).actions.invoke(...);`,
		python: `# 1. Your "Connect ${integration.name}" button
link = anlyon.end_users.create_connect_link(end_user_id=user.id, integration=${id}).data
return redirect(link["url"])  ${what.replace("//", "#")}

# 2. Your redirect URL, with your user signed in
result = parse_connect_redirect(request.url)
if result and result.status == "pending_confirmation" and result.flow_id:
    anlyon.end_users.confirm_connection(user.id, result.flow_id)

# 3. Act in their account
anlyon.for_user(user.id).actions.invoke(...)`,
		curl: `curl -X POST https://api.anlyon.com/api/v2/end-users/USER_ID/connect-links \\
  -H "Authorization: Bearer $ANLYON_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"integration": ${id}}'
# Send the user to data.url. Back on your redirect URL, confirm:
curl -X POST https://api.anlyon.com/api/v2/end-users/USER_ID/connections/confirm \\
  -H "Authorization: Bearer $ANLYON_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"flowId": "flw_from_the_redirect"}'`,
	};
}

function Readiness({
	ok,
	children,
	action,
}: {
	ok: boolean;
	children: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<li className="flex items-start justify-between gap-3 px-4 py-2.5">
			<span className="flex min-w-0 items-start gap-2.5 text-sm">
				{ok ? (
					<CircleCheck
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-success"
					/>
				) : (
					<CircleAlert
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-warning"
					/>
				)}
				<span className="min-w-0">{children}</span>
			</span>
			{action ? <span className="shrink-0">{action}</span> : null}
		</li>
	);
}

export function UsersPanel({
	integration,
	environment,
	workspaceId,
	canManage,
	onOpenSignIn,
}: {
	integration: IntegrationOverview;
	environment?: Environment;
	workspaceId?: string;
	canManage: boolean;
	onOpenSignIn?: () => void;
}) {
	const environmentId = environment?.id;
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const users = useEndUsers(
		workspaceId,
		environmentId,
		cursor,
		undefined,
		integration.id,
	);
	const rows = users.data?.data ?? [];
	const nextCursor = users.data?.pagination.nextCursor ?? null;
	const usesKey = integration.auth?.kind === "api_key";
	const appReady =
		usesKey ||
		integration.signIn?.app === "anlyon" ||
		integration.signIn?.app === "own";
	const confirmationOff = environment?.connectConfirmation === "off";
	const returnReady =
		Boolean(environment?.defaultRedirectUrl) || confirmationOff;

	return (
		<>
			<PageSection
				description={
					usesKey
						? `Each user connects their own ${integration.name} account with their own key. They paste it on Anlyon's page; it is checked with ${integration.name}, stored encrypted, and never shown to you or your agent.`
						: `Each user signs in to their own ${integration.name} account. Your agent then acts in that account only, under your limits and approvals.`
				}
				title="Ready for your users"
			>
				<ListFrame>
					<ul className="divide-y">
						<Readiness
							action={
								!appReady && onOpenSignIn ? (
									<Button onClick={onOpenSignIn} size="xs" variant="outline">
										Add your app
									</Button>
								) : undefined
							}
							ok={appReady}
						>
							{usesKey
								? "No OAuth app needed: users bring their own key."
								: integration.signIn?.app === "own"
									? "Users sign in with your own app."
									: integration.signIn?.app === "anlyon"
										? "Users sign in with Anlyon's app. Nothing to set up."
										: `Add your own ${integration.name} OAuth app first.`}
						</Readiness>
						<Readiness
							action={
								returnReady ? undefined : (
									<Button
										render={
											<Link
												search={{ environmentId }}
												to="/integrations/settings"
											/>
										}
										size="xs"
										variant="outline"
									>
										Set it
									</Button>
								)
							}
							ok={returnReady}
						>
							{environment?.defaultRedirectUrl ? (
								<>
									Users come back to{" "}
									<code className="font-mono text-xs" translate="no">
										{environment.defaultRedirectUrl}
									</code>
									, where your server confirms the connection.
								</>
							) : confirmationOff ? (
								"Confirmation is off here: users land on Anlyon's page and the account is theirs at once."
							) : (
								"Set a redirect URL: where users come back so your server can confirm who connected."
							)}
						</Readiness>
					</ul>
				</ListFrame>
			</PageSection>

			<PageSection
				description="Your server makes a connect link for the signed-in user and sends them to it. Back on your redirect URL it confirms the connection, so a link opened by someone else can never connect their account to your user."
				title="Connect a user from your app"
			>
				<CodeSample snippets={connectSnippets(integration)} />
			</PageSection>

			{canManage && appReady && returnReady && integration.connectable ? (
				<TryLink
					environmentId={environmentId}
					integration={integration}
					workspaceId={workspaceId}
				/>
			) : null}

			<PageSection
				title={
					<span className="flex items-baseline gap-2">
						Connected users
						{integration.endUsers.connected > 0 ? (
							<span className="font-normal text-muted-foreground text-sm tabular-nums">
								{integration.endUsers.connected}
							</span>
						) : null}
					</span>
				}
			>
				{users.isLoading ? (
					<Skeleton className="h-24 w-full rounded-lg" />
				) : rows.length === 0 && !cursor ? (
					<ListFrame>
						<ListEmpty
							description={`A user appears here once they connect ${integration.name} through a connect link, or once your server stores their key.`}
							title="No user has connected yet"
						/>
					</ListFrame>
				) : (
					<ListFrame
						footer={
							cursor || nextCursor ? (
								<nav aria-label="User pages" className="ms-auto flex gap-2">
									{cursor ? (
										<Button
											onClick={() => setCursor(undefined)}
											size="xs"
											variant="outline"
										>
											Back to the start
										</Button>
									) : null}
									{nextCursor ? (
										<Button
											disabled={users.isFetching}
											onClick={() => setCursor(nextCursor)}
											size="xs"
											variant="outline"
										>
											Next page
										</Button>
									) : null}
								</nav>
							) : undefined
						}
					>
						<Table aria-busy={users.isFetching}>
							<TableHeader>
								<TableRow>
									<TableHead>User</TableHead>
									<TableHead className="hidden w-28 text-right sm:table-cell">
										Invocations
									</TableHead>
									<TableHead className="hidden w-40 text-right sm:table-cell">
										Pending approvals
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((endUser) => (
									<TableRow
										className="group/row relative"
										key={endUser.endUserId}
									>
										<TableCell className="max-w-0 py-2.5">
											<Link
												className="block truncate rounded-sm font-medium font-mono text-[13px] outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:underline group-hover/row:underline-offset-2"
												params={{ endUserId: endUser.endUserId }}
												search={{ environmentId }}
												to="/users/$endUserId"
												translate="no"
											>
												{endUser.endUserId}
											</Link>
										</TableCell>
										<TableCell className="hidden py-2.5 text-right tabular-nums sm:table-cell">
											{endUser.invocations}
										</TableCell>
										<TableCell className="hidden py-2.5 text-right tabular-nums sm:table-cell">
											{endUser.pendingApprovals > 0 ? (
												<Link
													aria-label={`${endUser.pendingApprovals} pending for ${endUser.endUserId}`}
													className="relative z-[1] inline-flex items-center gap-1.5 rounded-sm font-medium outline-none hover:underline hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
													hash="approvals"
													params={{ endUserId: endUser.endUserId }}
													search={{ environmentId }}
													to="/users/$endUserId"
												>
													<span
														aria-hidden="true"
														className="size-1.5 rounded-full bg-warning"
													/>
													{endUser.pendingApprovals}
												</Link>
											) : (
												<span className="text-muted-foreground">0</span>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</ListFrame>
				)}
			</PageSection>
		</>
	);
}

function TryLink({
	integration,
	environmentId,
	workspaceId,
}: {
	integration: IntegrationOverview;
	environmentId?: string;
	workspaceId?: string;
}) {
	const id = useId();
	const create = useCreateEndUserConnectLink(workspaceId, environmentId);
	const [endUserId, setEndUserId] = useState("");
	const [link, setLink] = useState<EndUserConnectLink | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const value = endUserId.trim();
		if (!value) return setProblem("Enter the user's id in your app.");
		setProblem(null);
		setLink(null);
		create.mutate(
			{ endUserId: value, integration: integration.id },
			{
				onSuccess: setLink,
				onError: (error: Error) =>
					setProblem(
						error instanceof ApiError && error.code
							? `${error.message} (${error.code})`
							: error.message,
					),
			},
		);
	};

	return (
		<PageSection
			description="Make a link for one of your users to try the flow. It works once, for 10 minutes, and comes back to your redirect URL like any other."
			title="Try a connect link"
		>
			<form
				className="flex flex-col gap-3 rounded-lg border bg-card p-4"
				noValidate
				onSubmit={submit}
			>
				<Field>
					<FieldLabel htmlFor={`${id}-user`}>User id in your app</FieldLabel>
					<div className="flex flex-wrap gap-2">
						<Input
							autoComplete="off"
							className="max-w-sm flex-1 font-mono"
							id={`${id}-user`}
							onChange={(event) => setEndUserId(event.target.value)}
							placeholder="user_123"
							spellCheck={false}
							translate="no"
							value={endUserId}
						/>
						<Button loading={create.isPending} type="submit" variant="outline">
							Create link
						</Button>
					</div>
					<FieldDescription>
						The id your app already uses for the person: Anlyon stores it as
						given.
					</FieldDescription>
				</Field>
				{problem ? (
					<p className="text-destructive text-sm" role="alert">
						{problem}
					</p>
				) : null}
				{link ? (
					<div className="flex flex-col gap-2">
						<CopyValue label="Connect link" value={link.url} />
						<a
							className="inline-flex w-fit items-center gap-1 text-sm underline underline-offset-2"
							href={link.url}
							rel="noreferrer noopener"
							target="_blank"
						>
							Open it
							<ExternalLink aria-hidden="true" className="size-3.5" />
						</a>
					</div>
				) : null}
			</form>
		</PageSection>
	);
}
