"use client";

import { isFeatureEnabled } from "@anlyon/feature-flags";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RotateCw, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { EmptyRow } from "@/components/actions/empty-row";
import { ListSearch } from "@/components/actions/list-search";
import {
	AddSecretStoreDialog,
	ExternalSecretDialog,
	SecretStoresDescription,
	SecretStoresList,
	STORE_FAILURE_LABEL,
} from "@/components/actions/secret-stores";
import {
	ListFrame,
	Page,
	PageHeader,
	PageTabs,
	PageToolbar,
} from "@/components/layout/page";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogForm,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	useDeleteSecret,
	usePutSecret,
	useSecretStores,
	useSecrets,
} from "@/hooks/api/use-actions";
import { useCan } from "@/hooks/api/use-permissions";
import { usePlanAccess } from "@/hooks/use-plan-access";
import { parseAllowedHosts } from "@/lib/allowed-hosts";
import { secretIntegrationId } from "@/lib/integration-catalog";
import type { Secret, SecretPlacement } from "@/lib/types";

type SecretsSearch = {
	tab?: "stores";
	q?: string;
};

export const Route = createFileRoute("/_protected/actions/secrets")({
	validateSearch: (search: Record<string, unknown>): SecretsSearch => ({
		...(search.tab === "stores" ? { tab: "stores" as const } : {}),
		...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
	}),
	component: SecretsPage,
});

function matches(secret: Secret, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [
		secret.name,
		secret.description ?? "",
		secretIntegrationId(secret) ?? "",
		secret.external?.store ?? "",
		...(secret.allowedHosts ?? []),
	]
		.join(" ")
		.toLowerCase()
		.includes(needle);
}

export function SecretsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const navigate = Route.useNavigate();
	const { tab, q: query = "" } = Route.useSearch();
	const secretsQuery = useSecrets(workspaceId);
	const deleteSecret = useDeleteSecret();
	const secrets = secretsQuery.data ?? [];
	const can = useCan(workspaceId);
	const canManage = can("connections.manage");
	const canPointIntoStore = can("secret-stores.manage");
	const stores = useSecretStores(workspaceId).data ?? null;
	const { teamPlanRequired } = usePlanAccess(workspaceId);
	const showStores = stores !== null && tab === "stores";
	const isEmpty = !secretsQuery.isLoading && secrets.length === 0;
	const visible = secrets.filter((secret) => matches(secret, query));

	const setQuery = (next: string) =>
		navigate({
			replace: true,
			search: (previous) => ({ ...previous, q: next || undefined }),
		});

	return (
		<Page>
			<PageHeader
				actions={
					showStores ? (
						!teamPlanRequired && stores.length > 0 ? (
							<AddSecretStoreDialog workspaceId={workspaceId} />
						) : undefined
					) : (
						<>
							{canPointIntoStore && stores && stores.length > 0 ? (
								<ExternalSecretDialog
									workspaceId={workspaceId}
									stores={stores}
								/>
							) : null}
							{canManage && !isEmpty && (
								<PutSecretDialog workspaceId={workspaceId} />
							)}
						</>
					)
				}
				description={
					showStores ? (
						<SecretStoresDescription />
					) : (
						<>
							API keys and tokens your actions send, stored encrypted and never
							shown again. Use one in an action as{" "}
							<code className="font-mono text-foreground text-xs">
								{"{{secret:NAME}}"}
							</code>
							.
						</>
					)
				}
				title="Secrets"
			/>

			{stores !== null ? (
				<PageTabs
					items={[
						{
							label: "Secrets",
							to: "/actions/secrets",
							search: {},
							count: secretsQuery.isLoading ? undefined : secrets.length,
							match: { key: "tab", value: undefined },
						},
						{
							label: "Stores",
							to: "/actions/secrets",
							search: { tab: "stores" },
							count: stores.length,
							match: { key: "tab", value: "stores" },
						},
					]}
					label="Secrets views"
				/>
			) : null}

			{showStores ? (
				<SecretStoresList workspaceId={workspaceId} stores={stores} />
			) : (
				<>
					{secrets.length > 0 ? (
						<PageToolbar>
							<ListSearch
								label="Search secrets"
								onChange={setQuery}
								placeholder="Search by name or description…"
								value={query}
							/>
						</PageToolbar>
					) : null}

					{secretsQuery.isLoading ? (
						<ListFrame aria-busy="true" className="space-y-2" padded>
							{[0, 1, 2].map((i) => (
								<Skeleton key={i} className="h-9 w-full rounded-lg" />
							))}
						</ListFrame>
					) : secrets.length === 0 ? (
						<ListFrame padded>
							<EmptyRow
								action={
									canManage ? (
										<PutSecretDialog workspaceId={workspaceId} />
									) : undefined
								}
								title="No secrets yet"
							>
								Store an app's API key here, then use it in an action's headers.
							</EmptyRow>
						</ListFrame>
					) : (
						<ListFrame
							footer={
								<span className="tabular-nums">
									{visible.length === secrets.length
										? `${secrets.length} ${secrets.length === 1 ? "secret" : "secrets"}`
										: `${visible.length} of ${secrets.length} secrets`}
								</span>
							}
						>
							{visible.length === 0 ? (
								<div className="flex flex-wrap items-center gap-3 p-5">
									<output className="text-muted-foreground text-sm">
										No secret matches “{query.trim()}”.
									</output>
									<Button
										onClick={() => setQuery("")}
										size="sm"
										variant="outline"
									>
										Clear search
									</Button>
								</div>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Name</TableHead>
											<TableHead className="hidden md:table-cell">
												Description
											</TableHead>
											<TableHead className="hidden lg:table-cell">
												Sent to
											</TableHead>
											<TableHead className="hidden w-40 text-right sm:table-cell">
												Last used
											</TableHead>
											<TableHead className="w-24">
												<span className="sr-only">Actions</span>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{visible.map((secret: Secret) => (
											<SecretRow
												canManage={canManage}
												deleting={deleteSecret.isPending}
												key={secret.id}
												onDelete={() => {
													if (!workspaceId) return;
													deleteSecret.mutate({
														name: secret.name,
														workspaceId,
													});
												}}
												secret={secret}
												workspaceId={workspaceId}
											/>
										))}
									</TableBody>
								</Table>
							)}
						</ListFrame>
					)}
				</>
			)}
		</Page>
	);
}

function SecretRow({
	secret,
	workspaceId,
	canManage,
	deleting,
	onDelete,
}: {
	secret: Secret;
	workspaceId?: string;
	canManage: boolean;
	deleting: boolean;
	onDelete: () => void;
}) {
	const integrationId = secretIntegrationId(secret);
	return (
		<TableRow>
			<TableCell className="py-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-mono text-[13px]" translate="no">
						{secret.name}
					</span>
					{integrationId ? (
						<Badge variant="info">Connected account</Badge>
					) : null}
					{secret.kind === "external" && secret.external ? (
						<Badge variant="secondary">From {secret.external.store}</Badge>
					) : null}
					{secret.kind === "external" &&
					secret.health?.status === "unreachable" ? (
						<Badge variant="error">
							{secret.health.reason &&
							secret.health.reason in STORE_FAILURE_LABEL
								? STORE_FAILURE_LABEL[
										secret.health.reason as keyof typeof STORE_FAILURE_LABEL
									]
								: "Unreachable"}
						</Badge>
					) : null}
				</div>
			</TableCell>
			<TableCell className="hidden max-w-0 truncate py-2.5 text-muted-foreground md:table-cell">
				{secret.description ?? "—"}
			</TableCell>
			<TableCell className="hidden max-w-0 truncate py-2.5 lg:table-cell">
				{secret.allowedHosts?.length ? (
					<span
						className="font-mono text-muted-foreground text-xs"
						title={secret.allowedHosts.join(", ")}
						translate="no"
					>
						{secret.allowedHosts.join(", ")}
					</span>
				) : (
					<span
						className="text-warning text-xs"
						title="Not bound to any host. Rotate it to name the hosts it is for."
					>
						Any public host
					</span>
				)}
			</TableCell>
			<TableCell className="hidden py-2.5 text-right text-muted-foreground tabular-nums sm:table-cell">
				{secret.lastUsedAt ? (
					<RelativeTime value={secret.lastUsedAt} />
				) : (
					"Never"
				)}
			</TableCell>
			<TableCell className="py-2 text-right">
				{integrationId ? (
					isFeatureEnabled("connected-accounts") ? (
						<Button
							aria-label={`Manage ${secret.name} under Integrations`}
							render={
								<Link
									search={{ integration: integrationId }}
									to="/integrations"
								/>
							}
							size="sm"
							variant="ghost"
						>
							Manage
						</Button>
					) : null
				) : (
					<div className="flex items-center justify-end gap-1">
						{secret.kind === "external" ? null : (
							<PutSecretDialog
								disabled={!canManage}
								secret={secret}
								workspaceId={workspaceId}
							/>
						)}
						<AlertDialog>
							<AlertDialogTrigger
								render={
									<Button
										aria-label={`Delete secret ${secret.name}`}
										disabled={!workspaceId || !canManage || deleting}
										size="icon-sm"
										variant="ghost"
									>
										<Trash2 className="size-4" />
									</Button>
								}
							/>
							<AlertDialogPopup>
								<AlertDialogHeader>
									<AlertDialogTitle>Delete {secret.name}?</AlertDialogTitle>
									<AlertDialogDescription>
										Any action referencing {secret.name} will fail until you
										store it again.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogClose
										render={<Button variant="outline">Cancel</Button>}
									/>
									<AlertDialogClose
										render={
											<Button onClick={onDelete} variant="destructive">
												Delete
											</Button>
										}
									/>
								</AlertDialogFooter>
							</AlertDialogPopup>
						</AlertDialog>
					</div>
				)}
			</TableCell>
		</TableRow>
	);
}

const PLACEMENTS: { value: SecretPlacement; label: string }[] = [
	{ value: "header", label: "Header" },
	{ value: "url", label: "URL" },
	{ value: "body", label: "Body" },
];

function initialPlacements(secret?: Secret): SecretPlacement[] {
	if (!secret) return ["header"];
	return secret.allowedPlacements ?? PLACEMENTS.map((p) => p.value);
}

function PutSecretDialog({
	workspaceId,
	secret,
	disabled = false,
}: {
	workspaceId?: string;
	secret?: Secret;
	disabled?: boolean;
}) {
	const nameId = useId();
	const valueId = useId();
	const hostsId = useId();
	const descriptionId = useId();
	const rotating = secret !== undefined;

	const [open, setOpen] = useState(false);
	const [name, setName] = useState(secret?.name ?? "");
	const [value, setValue] = useState("");
	const [hosts, setHosts] = useState(secret?.allowedHosts?.join(", ") ?? "");
	const [placements, setPlacements] = useState<SecretPlacement[]>(() =>
		initialPlacements(secret),
	);
	const [description, setDescription] = useState(secret?.description ?? "");
	const [error, setError] = useState<string | null>(null);
	const putSecret = usePutSecret();

	const reset = () => {
		setName(secret?.name ?? "");
		setValue("");
		setHosts(secret?.allowedHosts?.join(", ") ?? "");
		setPlacements(initialPlacements(secret));
		setDescription(secret?.description ?? "");
		setError(null);
	};

	const nameIsValid = /^[A-Z0-9_]+$/.test(name);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		if (!workspaceId) return;
		if (!nameIsValid)
			return setError(
				"Name the secret in uppercase letters, digits and underscores, such as STRIPE_KEY.",
			);
		if (!value) return setError("Enter the value to store.");
		const parsed = parseAllowedHosts(hosts);
		if (!parsed.ok) return setError(parsed.error);
		if (placements.length === 0)
			return setError("Choose where in a request the secret may appear.");
		putSecret.mutate(
			{
				name,
				value,
				description: description.trim() || undefined,
				allowedHosts: parsed.hosts,
				allowedPlacements:
					placements.length === PLACEMENTS.length
						? null
						: PLACEMENTS.map((p) => p.value).filter((p) =>
								placements.includes(p),
							),
				workspaceId,
			},
			{
				onSuccess: () => {
					setOpen(false);
					reset();
				},
			},
		);
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				setOpen(next);
				if (next) reset();
			}}
			open={open}
		>
			<DialogTrigger
				render={
					rotating ? (
						<Button
							aria-label={`Rotate ${secret.name}`}
							disabled={disabled || !workspaceId}
							size="icon-sm"
							variant="ghost"
						>
							<RotateCw className="size-4" />
						</Button>
					) : (
						<Button size="sm">Add secret</Button>
					)
				}
			/>
			<DialogPopup>
				<DialogForm noValidate onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>
							{rotating ? `Rotate ${secret.name}` : "Store a secret"}
						</DialogTitle>
						<DialogDescription>
							{rotating
								? "The new value replaces the old one for every action that uses it. It is encrypted and can never be read back."
								: "The value is encrypted and can never be read back. It is decrypted only inside an action call, and sent only to the hosts you name."}
						</DialogDescription>
					</DialogHeader>

					<DialogPanel className="space-y-4 py-2">
						{rotating ? null : (
							<Field>
								<FieldLabel htmlFor={nameId}>Name</FieldLabel>
								<Input
									id={nameId}
									value={name}
									onChange={(e) => setName(e.target.value.toUpperCase())}
									placeholder="STRIPE_KEY"
									className="font-mono"
								/>
								{name && !nameIsValid ? (
									<p className="text-destructive text-xs">
										Uppercase letters, digits and underscores only.
									</p>
								) : null}
							</Field>
						)}

						<Field>
							<FieldLabel htmlFor={valueId}>
								{rotating ? "New value" : "Value"}
							</FieldLabel>
							<Input
								id={valueId}
								type="password"
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder="sk_test_"
								className="font-mono"
								autoComplete="off"
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor={hostsId}>Allowed hosts</FieldLabel>
							<Input
								id={hostsId}
								value={hosts}
								onChange={(e) => setHosts(e.target.value)}
								placeholder="api.stripe.com"
								className="font-mono"
								spellCheck={false}
								autoComplete="off"
								required
							/>
							<p className="text-muted-foreground text-xs">
								{rotating && !secret.allowedHosts?.length
									? `${secret.name} may be sent to any public host now. Name the hosts it is for to bind it. `
									: ""}
								The only hosts this value may be sent to, separated by commas;
								start one with a dot to allow its subdomains (.example.com). A
								call to any other host fails before anything is sent.
							</p>
						</Field>

						<fieldset className="space-y-2">
							<legend className="font-medium text-sm">May appear in</legend>
							<div className="flex flex-wrap gap-x-5 gap-y-2">
								{PLACEMENTS.map((placement) => (
									<Label
										className="cursor-pointer font-normal"
										key={placement.value}
									>
										<Checkbox
											checked={placements.includes(placement.value)}
											onCheckedChange={(checked) =>
												setPlacements((previous) =>
													checked
														? [...previous, placement.value]
														: previous.filter((p) => p !== placement.value),
												)
											}
										/>
										{placement.label}
									</Label>
								))}
							</div>
							<p className="text-muted-foreground text-xs">
								A credential belongs in a header. Allow the URL or the body only
								for an API that asks for the key there.
							</p>
						</fieldset>

						<Field>
							<FieldLabel htmlFor={descriptionId}>
								Description (optional)
							</FieldLabel>
							<Textarea
								id={descriptionId}
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="What this credential is for"
								className="min-h-16"
							/>
						</Field>

						{error ? (
							<p className="text-destructive text-sm" role="alert">
								{error}
							</p>
						) : null}
					</DialogPanel>

					<DialogFooter>
						<DialogClose render={<Button variant="outline">Cancel</Button>} />
						<Button
							disabled={!workspaceId}
							loading={putSecret.isPending}
							type="submit"
						>
							{rotating ? "Rotate secret" : "Store secret"}
						</Button>
					</DialogFooter>
				</DialogForm>
			</DialogPopup>
		</Dialog>
	);
}
