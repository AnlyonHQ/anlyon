import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
import { EnvironmentSelect } from "@/components/effects/environment-select";
import { ListEmpty } from "@/components/governance/list-empty";
import {
	ListFrame,
	Page,
	PageHeader,
	PageSection,
} from "@/components/layout/page";
import { LearnMore } from "@/components/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import { useSaveConnectSettings } from "@/hooks/api/use-end-users";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useCan } from "@/hooks/api/use-permissions";
import {
	isAllowedRedirect,
	normalizeRedirectUrl,
	redirectUrlProblem,
} from "@/lib/end-users";
import { requireFeature } from "@/lib/feature-flags";
import type { ConnectConfirmation, Environment } from "@/lib/types";

type ConnectSettingsSearch = { environmentId?: string };

export const Route = createFileRoute("/_protected/integrations/settings")({
	beforeLoad: () => requireFeature("connected-accounts"),
	validateSearch: (search: Record<string, unknown>): ConnectSettingsSearch => ({
		environmentId:
			typeof search.environmentId === "string"
				? search.environmentId
				: undefined,
	}),
	component: ConnectSettingsRoute,
});

function ConnectSettingsRoute() {
	const navigate = Route.useNavigate();
	const { environmentId } = Route.useSearch();
	return (
		<ConnectSettingsPage
			environmentId={environmentId}
			onEnvironmentChange={(next) =>
				navigate({
					to: "/integrations/settings",
					search: { environmentId: next },
				})
			}
		/>
	);
}

const MAX_REDIRECT_URLS = 20;

function confirmationMayBeOff(environment: Environment): boolean {
	return !environment.isProtected && environment.kind === "development";
}

export function ConnectSettingsPage({
	environmentId,
	onEnvironmentChange,
}: {
	environmentId: string | undefined;
	onEnvironmentChange: (environmentId: string | undefined) => void;
}) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const environmentsQuery = useEnvironments(workspaceId);
	const environments = environmentsQuery.data ?? [];
	const environment =
		environments.find((env) => env.id === environmentId) ??
		environments.find((env) => env.isDefault);
	const canManage = useCan(workspaceId)("connections.manage", environment?.id);

	return (
		<Page width="narrow">
			<PageHeader
				actions={
					<EnvironmentSelect
						onChange={onEnvironmentChange}
						value={environmentId}
						workspaceId={workspaceId}
					/>
				}
				description={
					<>
						How your users connect their own accounts
						{environment ? ` in ${environment.name}` : ""}: where they come back
						to, and whether your server confirms who connected.{" "}
						<LearnMore href="https://docs.anlyon.com/execution/end-user-connections" />
					</>
				}
				title="Connect settings"
			/>
			{environmentsQuery.isLoading || !environment ? (
				<div aria-busy="true" className="flex flex-col gap-8 pt-2">
					<Skeleton className="h-24 w-full rounded-lg" />
					<Skeleton className="h-40 w-full rounded-lg" />
				</div>
			) : (
				<>
					<DefaultRedirectSection
						canManage={canManage}
						environment={environment}
						key={`default-${environment.id}`}
						workspaceId={workspaceId}
					/>
					<AllowedRedirectsSection
						canManage={canManage}
						environment={environment}
						key={`allowed-${environment.id}`}
						workspaceId={workspaceId}
					/>
					<ConfirmationSection
						canManage={canManage}
						environment={environment}
						workspaceId={workspaceId}
					/>
					<p className="text-muted-foreground text-sm">
						Your own OAuth apps are on each integration's page, under{" "}
						<Link
							className="text-foreground underline underline-offset-2"
							to="/integrations"
						>
							Integrations
						</Link>
						, Sign-in.
					</p>
				</>
			)}
		</Page>
	);
}

function DefaultRedirectSection({
	environment,
	workspaceId,
	canManage,
}: {
	environment: Environment;
	workspaceId?: string;
	canManage: boolean;
}) {
	const id = useId();
	const save = useSaveConnectSettings(workspaceId);
	const saved = environment.defaultRedirectUrl ?? "";
	const allowed = environment.allowedRedirectUrls ?? [];
	const [value, setValue] = useState(saved);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => setValue(saved), [saved]);

	const trimmed = value.trim();
	const candidate =
		trimmed && !redirectUrlProblem(trimmed)
			? normalizeRedirectUrl(trimmed)
			: null;
	const addsAllowed =
		candidate !== null && !isAllowedRedirect(candidate, allowed);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!trimmed) {
			save.mutate(
				{ environmentId: environment.id, defaultRedirectUrl: null },
				{ onError: (error: Error) => setProblem(error.message) },
			);
			return;
		}
		const found = redirectUrlProblem(trimmed);
		if (found || !candidate) {
			setProblem(found ?? "Enter a URL.");
			return;
		}
		setProblem(null);
		save.mutate(
			{
				environmentId: environment.id,
				defaultRedirectUrl: candidate,
				...(addsAllowed
					? { allowedRedirectUrls: [...allowed, candidate] }
					: {}),
			},
			{ onError: (error: Error) => setProblem(error.message) },
		);
	};

	return (
		<PageSection
			description="Where a connect link sends your user back when your server does not pass its own URL."
			title="Default redirect URL"
		>
			<form className="space-y-3" noValidate onSubmit={submit}>
				{!saved ? (
					<Alert variant="warning">
						<AlertTitle>No default redirect URL</AlertTitle>
						<AlertDescription>
							Connect links are refused until you set one, or your server passes
							a redirect URL with each link. The link in an
							END_USER_NOT_CONNECTED answer always uses this one.
						</AlertDescription>
					</Alert>
				) : null}
				<Field className="gap-2">
					<FieldLabel className="sr-only" htmlFor={id}>
						URL
					</FieldLabel>
					<div className="flex w-full flex-wrap gap-2">
						<Input
							aria-describedby={problem ? `${id}-problem` : undefined}
							aria-invalid={problem ? true : undefined}
							autoComplete="off"
							className="min-w-0 flex-1 basis-64 font-mono"
							disabled={!canManage}
							id={id}
							inputMode="url"
							onChange={(event) => {
								setValue(event.target.value);
								setProblem(null);
							}}
							placeholder="https://app.example.com/settings/connections"
							spellCheck={false}
							translate="no"
							value={value}
						/>
						{canManage ? (
							<Button
								disabled={trimmed === saved}
								loading={save.isPending}
								type="submit"
							>
								Save
							</Button>
						) : null}
					</div>
					{problem ? (
						<p
							className="text-destructive text-xs"
							id={`${id}-problem`}
							role="alert"
						>
							{problem}
						</p>
					) : addsAllowed && trimmed !== saved ? (
						<FieldDescription>
							Saving also adds it to the allowed redirect URLs.
						</FieldDescription>
					) : null}
				</Field>
			</form>
		</PageSection>
	);
}

function AllowedRedirectsSection({
	environment,
	workspaceId,
	canManage,
}: {
	environment: Environment;
	workspaceId?: string;
	canManage: boolean;
}) {
	const id = useId();
	const save = useSaveConnectSettings(workspaceId);
	const allowed = environment.allowedRedirectUrls ?? [];
	const defaultUrl = environment.defaultRedirectUrl ?? null;
	const [draft, setDraft] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	const add = (event: FormEvent) => {
		event.preventDefault();
		const found = redirectUrlProblem(draft);
		if (found) {
			setProblem(found);
			return;
		}
		const url = normalizeRedirectUrl(draft);
		if (allowed.length >= MAX_REDIRECT_URLS) {
			setProblem(
				`An environment allows up to ${MAX_REDIRECT_URLS} redirect URLs. Remove one to add another.`,
			);
			return;
		}
		if (allowed.includes(url)) {
			setProblem("That URL is already allowed.");
			return;
		}
		setProblem(null);
		save.mutate(
			{ environmentId: environment.id, allowedRedirectUrls: [...allowed, url] },
			{
				onSuccess: () => setDraft(""),
				onError: (error: Error) => setProblem(error.message),
			},
		);
	};

	const holdsDefault = (url: string) =>
		defaultUrl !== null &&
		isAllowedRedirect(defaultUrl, [url]) &&
		!isAllowedRedirect(
			defaultUrl,
			allowed.filter((entry) => entry !== url),
		);

	const addForm = canManage ? (
		<form className="space-y-1.5" noValidate onSubmit={add}>
			<label className="sr-only" htmlFor={id}>
				Redirect URL to allow
			</label>
			<div className="flex flex-wrap gap-2">
				<Input
					aria-describedby={problem ? `${id}-problem` : undefined}
					aria-invalid={problem ? true : undefined}
					autoComplete="off"
					className="min-w-0 flex-1 basis-64 font-mono"
					id={id}
					inputMode="url"
					onChange={(event) => {
						setDraft(event.target.value);
						setProblem(null);
					}}
					placeholder="https://app.example.com/settings"
					spellCheck={false}
					translate="no"
					value={draft}
				/>
				<Button loading={save.isPending} type="submit" variant="outline">
					Add URL
				</Button>
			</div>
			{problem ? (
				<p
					className="text-destructive text-xs"
					id={`${id}-problem`}
					role="alert"
				>
					{problem}
				</p>
			) : null}
		</form>
	) : null;

	return (
		<PageSection
			description="An https origin with a path. A redirect matches when it has the same origin and a path at or under this one."
			title="Allowed redirect URLs"
		>
			{addForm}
			<ListFrame
				footer={
					allowed.length > 0 ? (
						<span className="tabular-nums">
							{allowed.length} of {MAX_REDIRECT_URLS} allowed
						</span>
					) : undefined
				}
			>
				{allowed.length === 0 ? (
					<ListEmpty
						description="A connect link can send users back to a URL listed here, and nowhere else."
						title="No allowed redirect URLs yet"
					/>
				) : (
					<ul className="divide-y">
						{allowed.map((url) => (
							<li
								className="flex min-h-12 items-center justify-between gap-3 px-4 py-2"
								key={url}
							>
								<span className="flex min-w-0 items-center gap-2">
									<code
										className="truncate font-mono text-xs"
										title={url}
										translate="no"
									>
										{url}
									</code>
									{url === defaultUrl ? (
										<Badge size="sm" variant="outline">
											Default
										</Badge>
									) : null}
								</span>
								{canManage ? (
									holdsDefault(url) ? (
										<span className="shrink-0 text-muted-foreground text-xs">
											Used by the default
										</span>
									) : (
										<RemoveRedirectUrl
											onConfirm={() =>
												save.mutate({
													environmentId: environment.id,
													allowedRedirectUrls: allowed.filter(
														(entry) => entry !== url,
													),
												})
											}
											url={url}
										/>
									)
								) : null}
							</li>
						))}
					</ul>
				)}
			</ListFrame>
		</PageSection>
	);
}

function RemoveRedirectUrl({
	url,
	onConfirm,
}: {
	url: string;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button aria-label={`Remove ${url}`} size="xs" variant="ghost">
						Remove
					</Button>
				}
			/>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-all">
						Remove {url}?
					</AlertDialogTitle>
					<AlertDialogDescription>
						A connect link that returns to this URL is refused from now on,
						including links already sent.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose
						render={<Button variant="outline">Cancel</Button>}
					/>
					<AlertDialogClose
						render={
							<Button onClick={onConfirm} variant="destructive">
								Remove URL
							</Button>
						}
					/>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}

function ConfirmationSection({
	environment,
	workspaceId,
	canManage,
}: {
	environment: Environment;
	workspaceId?: string;
	canManage: boolean;
}) {
	const id = useId();
	const save = useSaveConnectSettings(workspaceId);
	const value: ConnectConfirmation =
		environment.connectConfirmation ?? "required";
	const offAllowed = confirmationMayBeOff(environment);

	return (
		<PageSection
			description="After consent, your server confirms the connection for the user who is signed in. Then nobody can attach their account to someone else."
			title="Connect confirmation"
		>
			<Field>
				<FieldLabel htmlFor={id}>Confirmation</FieldLabel>
				<NativeSelect
					className="w-full sm:w-72"
					disabled={!canManage || save.isPending}
					id={id}
					onChange={(event) =>
						save.mutate({
							environmentId: environment.id,
							connectConfirmation:
								event.target.value === "off" ? "off" : "required",
						})
					}
					value={value}
				>
					<NativeSelectOption value="required">
						Required: your server confirms
					</NativeSelectOption>
					<NativeSelectOption disabled={!offAllowed} value="off">
						Off: connect at once
					</NativeSelectOption>
				</NativeSelect>
				{!offAllowed ? (
					<FieldDescription>
						Off is only for environments that are not protected.
					</FieldDescription>
				) : value === "off" ? (
					<p className="text-warning-foreground text-xs">
						Anyone who finishes a connect link gets the connection, without your
						server checking who they are.
					</p>
				) : null}
			</Field>
		</PageSection>
	);
}
