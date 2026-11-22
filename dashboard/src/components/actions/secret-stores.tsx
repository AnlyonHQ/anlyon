"use client";

import { Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { EmptyRow } from "@/components/actions/empty-row";
import { ListFrame } from "@/components/layout/page";
import { TeamPlanNotice } from "@/components/plan/team-plan-notice";
import { LearnMore } from "@/components/settings/settings-page";
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
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	useCheckSecretStore,
	useCreateSecretStore,
	useDeleteSecretStore,
	usePutExternalSecret,
	useSecretStoreSettings,
	useUpdateSecretStoreSettings,
} from "@/hooks/api/use-actions";
import { usePlanAccess } from "@/hooks/use-plan-access";
import { isSelfHosted } from "@/lib/runtime-config";
import type {
	SecretStore,
	SecretStoreFailure,
	SecretStoreType,
} from "@/lib/types";

export const STORE_TYPE_LABEL: Record<SecretStoreType, string> = {
	aws_secrets_manager: "AWS Secrets Manager",
	hashicorp_vault: "HashiCorp Vault",
};

export const STORE_FAILURE_LABEL: Record<SecretStoreFailure, string> = {
	store_unreachable: "Store did not answer",
	store_denied: "Store refused access",
	reference_not_found: "Not found in store",
};

function listOf(text: string): string[] | null {
	const items = text
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : null;
}

export function SecretStoresList({
	workspaceId,
	stores,
}: {
	workspaceId?: string;
	stores: SecretStore[];
}) {
	const checkStore = useCheckSecretStore();
	const deleteStore = useDeleteSecretStore();
	const { teamPlanRequired } = usePlanAccess(workspaceId);

	return (
		<>
			{teamPlanRequired ? (
				<TeamPlanNotice
					feature="Secret stores"
					hasConfiguration={stores.length > 0}
					variant="inline"
				/>
			) : null}

			{stores.length === 0 ? (
				<ListFrame padded>
					<EmptyRow
						action={
							teamPlanRequired ? undefined : (
								<AddSecretStoreDialog workspaceId={workspaceId} />
							)
						}
						title="No secret stores yet"
					>
						Add a store, then create a secret that reads its value from it.
					</EmptyRow>
				</ListFrame>
			) : (
				<ListFrame
					footer={
						<span className="tabular-nums">
							{stores.length} {stores.length === 1 ? "store" : "stores"}
						</span>
					}
				>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden md:table-cell">Type</TableHead>
								<TableHead className="w-48">Status</TableHead>
								<TableHead className="w-28" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{stores.map((store) => (
								<TableRow key={store.id}>
									<TableCell className="py-2.5 font-mono" translate="no">
										{store.name}
									</TableCell>
									<TableCell className="hidden py-2.5 text-muted-foreground md:table-cell">
										{STORE_TYPE_LABEL[store.type]}
									</TableCell>
									<TableCell className="py-2.5">
										{store.health?.status === "unreachable" ? (
											<Badge variant="error">
												{store.health.reason
													? STORE_FAILURE_LABEL[store.health.reason]
													: "Unreachable"}
											</Badge>
										) : (
											<Badge variant="success">Reachable</Badge>
										)}
									</TableCell>
									<TableCell className="py-2 text-right">
										<div className="flex items-center justify-end gap-1">
											<Button
												size="sm"
												variant="ghost"
												disabled={!workspaceId || checkStore.isPending}
												onClick={() => {
													if (!workspaceId) return;
													checkStore.mutate({ name: store.name, workspaceId });
												}}
											>
												Check
											</Button>
											<AlertDialog>
												<AlertDialogTrigger
													render={
														<Button
															aria-label={`Delete secret store ${store.name}`}
															disabled={!workspaceId || deleteStore.isPending}
															size="icon-sm"
															variant="ghost"
														>
															<Trash2 className="size-4" />
														</Button>
													}
												/>
												<AlertDialogPopup>
													<AlertDialogHeader>
														<AlertDialogTitle>
															Delete {store.name}?
														</AlertDialogTitle>
														<AlertDialogDescription>
															A store that secrets still point at cannot be
															deleted. Delete or repoint those secrets first.
														</AlertDialogDescription>
													</AlertDialogHeader>
													<AlertDialogFooter>
														<AlertDialogClose
															render={<Button variant="outline">Cancel</Button>}
														/>
														<AlertDialogClose
															render={
																<Button
																	variant="destructive"
																	onClick={() => {
																		if (!workspaceId) return;
																		deleteStore.mutate({
																			name: store.name,
																			workspaceId,
																		});
																	}}
																>
																	Delete
																</Button>
															}
														/>
													</AlertDialogFooter>
												</AlertDialogPopup>
											</AlertDialog>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</ListFrame>
			)}
			<PrivateNetworkSetting workspaceId={workspaceId} />
		</>
	);
}

export function SecretStoresDescription() {
	return (
		<>
			Keep secret values in your own AWS Secrets Manager or HashiCorp Vault.
			Anlyon reads them at each call.{" "}
			<LearnMore href="https://docs.anlyon.com/execution/secrets" />
		</>
	);
}

function PrivateNetworkSetting({ workspaceId }: { workspaceId?: string }) {
	const id = useId();
	const settings = useSecretStoreSettings(workspaceId).data;
	const update = useUpdateSecretStoreSettings();
	if (!settings) return null;
	if (!settings.available) {
		if (!isSelfHosted()) return null;
		return (
			<p className="rounded-lg border bg-card px-4 py-3.5 text-muted-foreground text-xs">
				An instance admin has turned off private network destinations on this
				install, so stores must be reachable at public addresses (Settings,
				Instance, Network).
			</p>
		);
	}
	return (
		<div className="flex items-start justify-between gap-4 rounded-lg border bg-card px-4 py-3.5">
			<div className="flex flex-col gap-1">
				<label htmlFor={id} className="font-medium text-sm">
					Allow private network addresses
				</label>
				<p className="text-muted-foreground text-xs">
					Lets this workspace's stores sit on your own network, such as a Vault
					at 10.0.0.5. Admins only. Plain http is accepted only while this is
					on.
				</p>
			</div>
			<Switch
				id={id}
				checked={settings.allowPrivateNetwork}
				disabled={!workspaceId || update.isPending}
				onCheckedChange={(checked) => {
					if (!workspaceId) return;
					update.mutate({ workspaceId, allowPrivateNetwork: checked === true });
				}}
			/>
		</div>
	);
}

export function AddSecretStoreDialog({
	workspaceId,
}: {
	workspaceId?: string;
}) {
	const ids = {
		name: useId(),
		type: useId(),
		region: useId(),
		auth: useId(),
		roleArn: useId(),
		externalId: useId(),
		accessKeyId: useId(),
		secretAccessKey: useId(),
		address: useId(),
		namespace: useId(),
		mount: useId(),
		token: useId(),
		roleId: useId(),
		secretId: useId(),
		paths: useId(),
		ttl: useId(),
	};
	const [type, setType] = useState<SecretStoreType>("hashicorp_vault");
	const [fields, setFields] = useState<Record<string, string>>({
		name: "",
		region: "",
		awsAuth: "access_key",
		roleArn: "",
		externalId: "",
		accessKeyId: "",
		secretAccessKey: "",
		address: "",
		namespace: "",
		mount: "secret",
		vaultAuth: "token",
		token: "",
		roleId: "",
		secretId: "",
		paths: "",
		ttl: "30",
	});
	const set = (key: string) => (value: string) =>
		setFields((current) => ({ ...current, [key]: value }));
	const createStore = useCreateSecretStore();

	const nameIsValid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(fields.name);
	const ttl = Number(fields.ttl);
	const ttlIsValid = Number.isInteger(ttl) && ttl >= 0 && ttl <= 300;
	const credentialGiven =
		type === "aws_secrets_manager"
			? Boolean(fields.accessKeyId && fields.secretAccessKey)
			: fields.vaultAuth === "token"
				? Boolean(fields.token)
				: Boolean(fields.roleId && fields.secretId);
	const settingsGiven =
		type === "aws_secrets_manager"
			? Boolean(fields.region) &&
				(fields.awsAuth === "access_key" || Boolean(fields.roleArn))
			: Boolean(fields.address);
	const canSave =
		Boolean(workspaceId) &&
		nameIsValid &&
		ttlIsValid &&
		credentialGiven &&
		settingsGiven;

	const save = () => {
		if (!workspaceId || !canSave) return;
		const config: Record<string, unknown> =
			type === "aws_secrets_manager"
				? {
						region: fields.region.trim(),
						auth: fields.awsAuth,
						...(fields.awsAuth === "assume_role"
							? {
									roleArn: fields.roleArn.trim(),
									...(fields.externalId.trim()
										? { externalId: fields.externalId.trim() }
										: {}),
								}
							: {}),
					}
				: {
						address: fields.address.trim(),
						mount: fields.mount.trim() || "secret",
						auth: fields.vaultAuth,
						...(fields.namespace.trim()
							? { namespace: fields.namespace.trim() }
							: {}),
					};
		const credential: Record<string, string> =
			type === "aws_secrets_manager"
				? {
						accessKeyId: fields.accessKeyId.trim(),
						secretAccessKey: fields.secretAccessKey.trim(),
					}
				: fields.vaultAuth === "token"
					? { token: fields.token.trim() }
					: { roleId: fields.roleId.trim(), secretId: fields.secretId.trim() };
		createStore.mutate({
			workspaceId,
			name: fields.name,
			type,
			config,
			credential,
			allowedPaths: listOf(fields.paths),
			cacheTtlSeconds: ttl,
		});
	};

	const text = (
		key: string,
		id: string,
		label: string,
		placeholder: string,
		secret = false,
	) => (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				type={secret ? "password" : "text"}
				autoComplete="off"
				spellCheck={false}
				value={fields[key]}
				onChange={(e) => set(key)(e.target.value)}
				placeholder={placeholder}
				className="font-mono"
			/>
		</Field>
	);

	return (
		<Dialog>
			<DialogTrigger render={<Button size="sm">Add secret store</Button>} />
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Add a secret store</DialogTitle>
					<DialogDescription>
						Anlyon checks it can sign in before saving. The credential is
						encrypted and can never be read back. Give it read access only to
						the secrets Anlyon should use.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 py-2">
					<Field>
						<FieldLabel htmlFor={ids.name}>Name</FieldLabel>
						<Input
							id={ids.name}
							value={fields.name}
							onChange={(e) => set("name")(e.target.value.toLowerCase())}
							placeholder="prod-vault"
							className="font-mono"
						/>
						{fields.name && !nameIsValid ? (
							<p className="text-destructive text-xs">
								Lowercase letters, digits and dashes.
							</p>
						) : null}
					</Field>

					<Field>
						<FieldLabel htmlFor={ids.type}>Type</FieldLabel>
						<NativeSelect
							id={ids.type}
							className="w-full"
							value={type}
							onChange={(e) => setType(e.target.value as SecretStoreType)}
						>
							<NativeSelectOption value="hashicorp_vault">
								HashiCorp Vault (KV version 2)
							</NativeSelectOption>
							<NativeSelectOption value="aws_secrets_manager">
								AWS Secrets Manager
							</NativeSelectOption>
						</NativeSelect>
					</Field>

					{type === "aws_secrets_manager" ? (
						<>
							{text("region", ids.region, "Region", "eu-west-1")}
							<Field>
								<FieldLabel htmlFor={ids.auth}>Sign-in</FieldLabel>
								<NativeSelect
									id={ids.auth}
									className="w-full"
									value={fields.awsAuth}
									onChange={(e) => set("awsAuth")(e.target.value)}
								>
									<NativeSelectOption value="access_key">
										Access keys
									</NativeSelectOption>
									<NativeSelectOption value="assume_role">
										Access keys that assume a role
									</NativeSelectOption>
								</NativeSelect>
							</Field>
							{fields.awsAuth === "assume_role" ? (
								<>
									{text(
										"roleArn",
										ids.roleArn,
										"Role ARN",
										"arn:aws:iam::123456789012:role/anlyon-reader",
									)}
									{text(
										"externalId",
										ids.externalId,
										"External ID (optional)",
										"anlyon-…",
									)}
								</>
							) : null}
							{text(
								"accessKeyId",
								ids.accessKeyId,
								"Access key ID",
								"<your-access-key-id>",
							)}
							{text(
								"secretAccessKey",
								ids.secretAccessKey,
								"Secret access key",
								"<your-secret-access-key>",
								true,
							)}
						</>
					) : (
						<>
							{text(
								"address",
								ids.address,
								"Address",
								"https://vault.example.com:8200",
							)}
							{text(
								"namespace",
								ids.namespace,
								"Namespace (optional)",
								"admin/team-a",
							)}
							{text("mount", ids.mount, "KV mount", "secret")}
							<Field>
								<FieldLabel htmlFor={ids.auth}>Sign-in</FieldLabel>
								<NativeSelect
									id={ids.auth}
									className="w-full"
									value={fields.vaultAuth}
									onChange={(e) => set("vaultAuth")(e.target.value)}
								>
									<NativeSelectOption value="token">Token</NativeSelectOption>
									<NativeSelectOption value="approle">
										AppRole
									</NativeSelectOption>
								</NativeSelect>
							</Field>
							{fields.vaultAuth === "token" ? (
								text("token", ids.token, "Token", "<your-vault-token>", true)
							) : (
								<>
									{text("roleId", ids.roleId, "Role ID", "<your-role-id>")}
									{text(
										"secretId",
										ids.secretId,
										"Secret ID",
										"<your-secret-id>",
										true,
									)}
								</>
							)}
						</>
					)}

					{text(
						"paths",
						ids.paths,
						"Allowed paths (optional)",
						"payments, billing/stripe",
					)}
					<Field>
						<FieldLabel htmlFor={ids.ttl}>Cache, in seconds</FieldLabel>
						<Input
							id={ids.ttl}
							inputMode="numeric"
							value={fields.ttl}
							onChange={(e) => set("ttl")(e.target.value)}
							placeholder="30"
						/>
						<p className="text-muted-foreground text-xs">
							How long a value is kept in memory between calls, from 0 to 300. 0
							reads the store at every call.
						</p>
					</Field>
				</DialogPanel>

				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<DialogClose
						render={
							<Button
								disabled={!canSave || createStore.isPending}
								onClick={save}
							>
								Add store
							</Button>
						}
					/>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}

export function ExternalSecretDialog({
	workspaceId,
	stores,
}: {
	workspaceId?: string;
	stores: SecretStore[];
}) {
	const ids = {
		name: useId(),
		store: useId(),
		path: useId(),
		key: useId(),
		version: useId(),
		hosts: useId(),
		description: useId(),
	};
	const [name, setName] = useState("");
	const [store, setStore] = useState(stores[0]?.name ?? "");
	const [path, setPath] = useState("");
	const [key, setKey] = useState("");
	const [version, setVersion] = useState("");
	const [hosts, setHosts] = useState("");
	const [description, setDescription] = useState("");
	const putExternal = usePutExternalSecret();

	const selected = stores.find((s) => s.name === store) ?? stores[0];
	const isVault = selected?.type === "hashicorp_vault";
	const nameIsValid = /^[A-Z0-9_]+$/.test(name);
	const canSave =
		Boolean(workspaceId) &&
		Boolean(selected) &&
		nameIsValid &&
		path.trim().length > 0 &&
		(!isVault || key.trim().length > 0) &&
		listOf(hosts) !== null;

	const save = () => {
		if (!workspaceId || !selected || !canSave) return;
		putExternal.mutate(
			{
				workspaceId,
				name,
				store: selected.name,
				path: path.trim(),
				key: key.trim() || undefined,
				version: version.trim() || undefined,
				description: description.trim() || undefined,
				allowedHosts: listOf(hosts),
			},
			{
				onSuccess: () => {
					setName("");
					setPath("");
					setKey("");
					setVersion("");
					setHosts("");
					setDescription("");
				},
			},
		);
	};

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button size="sm" variant="outline">
						Add from a store
					</Button>
				}
			/>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Read a secret from your store</DialogTitle>
					<DialogDescription>
						Anlyon reads the value at each call and does not store it. It reads
						it once now to check the path. If your store does not hold it yet,
						the secret is still saved, and calls that use it fail until it does.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel className="space-y-4 py-2">
					<Field>
						<FieldLabel htmlFor={ids.name}>Name</FieldLabel>
						<Input
							id={ids.name}
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
					<Field>
						<FieldLabel htmlFor={ids.store}>Store</FieldLabel>
						<NativeSelect
							id={ids.store}
							className="w-full"
							value={selected?.name ?? ""}
							onChange={(e) => setStore(e.target.value)}
						>
							{stores.map((s) => (
								<NativeSelectOption key={s.id} value={s.name}>
									{s.name} ({STORE_TYPE_LABEL[s.type]})
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<FieldLabel htmlFor={ids.path}>
							{isVault ? "Path" : "Secret name or ARN"}
						</FieldLabel>
						<Input
							id={ids.path}
							value={path}
							onChange={(e) => setPath(e.target.value)}
							placeholder={isVault ? "payments/stripe" : "prod/stripe"}
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={ids.key}>
							{isVault ? "Key" : "JSON key (optional)"}
						</FieldLabel>
						<Input
							id={ids.key}
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder="apiKey"
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={ids.version}>Version (optional)</FieldLabel>
						<Input
							id={ids.version}
							value={version}
							onChange={(e) => setVersion(e.target.value)}
							placeholder={isVault ? "3" : "AWSCURRENT"}
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={ids.hosts}>Allowed hosts</FieldLabel>
						<Input
							id={ids.hosts}
							value={hosts}
							onChange={(e) => setHosts(e.target.value)}
							placeholder="api.stripe.com"
							className="font-mono"
							spellCheck={false}
							required
						/>
						<p className="text-muted-foreground text-xs">
							Required. The only hosts this value may be sent to, separated by
							commas; start one with a dot to allow its subdomains
							(.example.com). A value read from your store is never sent
							anywhere else, so calls to an unlisted host fail.
						</p>
					</Field>
					<Field>
						<FieldLabel htmlFor={ids.description}>
							Description (optional)
						</FieldLabel>
						<Input
							id={ids.description}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="What this credential is for"
						/>
					</Field>
				</DialogPanel>

				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<DialogClose
						render={
							<Button
								disabled={!canSave || putExternal.isPending}
								onClick={save}
							>
								Save secret
							</Button>
						}
					/>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
