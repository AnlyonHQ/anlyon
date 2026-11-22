import { createFileRoute } from "@tanstack/react-router";
import { History, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
	ApiKeyHistoryDialog,
	CreateApiKeyDialog,
	DisplayApiKeyDialog,
	DisplayRegeneratedKeyDialog,
	maskSecret,
	RegenerateApiKeyDialog,
	RollbackApiKeyDialog,
} from "@/components/settings";
import { KeyBudgetEditor } from "@/components/settings/key-budget-editor";
import {
	LearnMore,
	ListEmpty,
	SettingsPage,
	SettingsTableFrame,
} from "@/components/settings/settings-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import { useEnvironments } from "@/hooks/api/use-environments";
import { useCan } from "@/hooks/api/use-permissions";
import {
	useApiKeyHistory,
	useApiKeys,
	useCreateApiKey,
	useRegenerateApiKey,
	useRollbackApiKey,
} from "@/hooks/api/use-workspaces";
import { STANDARD_SCOPES } from "@/lib/api-key-scopes";
import type { ApiKey } from "@/lib/types";
import { copyToClipboard } from "@/lib/utils";

export const Route = createFileRoute("/_protected/settings/api-keys")({
	component: ApiKeysSettingsPage,
});

type DialogKind =
	| "create"
	| "display-created"
	| "regenerate"
	| "display-regenerated"
	| "history"
	| "rollback"
	| null;

function ApiKeysSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id ?? "";
	const { data: apiKeys, isLoading } = useApiKeys(workspaceId);
	const envQuery = useEnvironments(workspaceId || undefined);
	const environments = envQuery.data ?? [];
	const createApiKey = useCreateApiKey();
	const regenerateApiKey = useRegenerateApiKey();
	const rollbackApiKey = useRollbackApiKey();
	const canManageKeys = useCan(workspaceId || undefined)("keys.manage");

	const [dialog, setDialog] = useState<DialogKind>(null);
	const [newKeyName, setNewKeyName] = useState("");
	const [newKeyEnvironmentId, setNewKeyEnvironmentId] = useState("");
	const [newKeyScopes, setNewKeyScopes] = useState<string[]>([
		...STANDARD_SCOPES,
	]);
	const [newKeyEndUserRequired, setNewKeyEndUserRequired] = useState(false);
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const [regeneratedKey, setRegeneratedKey] = useState<string | null>(null);
	const [rollbackExpiresAt, setRollbackExpiresAt] = useState<string | null>(
		null,
	);
	const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null);
	const [showSecret, setShowSecret] = useState(false);
	const [isCopied, setIsCopied] = useState(false);

	const { data: keyHistory, isLoading: isLoadingHistory } = useApiKeyHistory(
		workspaceId,
		selectedKey?.id ?? "",
	);

	const environmentName = (id: string | null) => {
		if (!id) return "Workspace default";
		return (
			environments.find((environment) => environment.id === id)?.name ?? "—"
		);
	};

	const copy = async (value: string | null, onDone: () => void) => {
		if (!value) return;
		const result = await copyToClipboard(value);
		if (result.success) {
			onDone();
			toast.success("Copied");
			setTimeout(() => setIsCopied(false), 2000);
		} else toast.error(result.error || "Copy failed");
	};

	const closeSecretDialogs = () => {
		setCreatedKey(null);
		setRegeneratedKey(null);
		setRollbackExpiresAt(null);
		setShowSecret(false);
		setIsCopied(false);
		setDialog(null);
	};

	const getRollbackTimeRemaining = (expiresAt: string): string => {
		const diff = new Date(expiresAt).getTime() - Date.now();
		if (diff <= 0) return "Expired";
		const minutes = Math.floor(diff / 60000);
		const seconds = Math.floor((diff % 60000) / 1000);
		return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
	};

	return (
		<SettingsPage
			title="API keys"
			description={
				<>
					Your server sends a key with each call to Anlyon. Each key belongs to
					one environment, and its secret is shown once, when it is created.{" "}
					<LearnMore href="https://docs.anlyon.com/authentication" />
				</>
			}
			actions={
				canManageKeys && (isLoading || (apiKeys && apiKeys.length > 0)) ? (
					<Button size="sm" onClick={() => setDialog("create")}>
						<Plus aria-hidden="true" />
						Create API key
					</Button>
				) : undefined
			}
		>
			{isLoading ? (
				<SettingsTableFrame>
					<Table className="min-w-[640px] [&_td]:p-3 [&_th]:px-3">
						<TableHeader>
							<TableRow>
								<TableHead>Key</TableHead>
								<TableHead>Environment</TableHead>
								<TableHead>Activity</TableHead>
								<TableHead>Budget</TableHead>
								<TableHead aria-label="Actions" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{[0, 1].map((index) => (
								<TableRow key={index}>
									<TableCell>
										<div className="flex flex-col gap-2">
											<Skeleton className="h-4 w-28" />
											<Skeleton className="h-3 w-36" />
										</div>
									</TableCell>
									<TableCell>
										<Skeleton className="h-5 w-20" />
									</TableCell>
									<TableCell>
										<div className="flex flex-col gap-2">
											<Skeleton className="h-3 w-24" />
											<Skeleton className="h-3 w-28" />
										</div>
									</TableCell>
									<TableCell>
										<Skeleton className="h-5 w-24" />
									</TableCell>
									<TableCell>
										<Skeleton className="size-8 rounded-full" />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</SettingsTableFrame>
			) : apiKeys && apiKeys.length > 0 ? (
				<SettingsTableFrame
					footer={
						<span className="tabular-nums">
							{apiKeys.length} {apiKeys.length === 1 ? "key" : "keys"} in{" "}
							{currentWorkspace?.name ?? "this workspace"}
						</span>
					}
				>
					<Table className="min-w-[640px] [&_td]:p-3 [&_th]:px-3">
						<TableCaption className="sr-only">
							API keys for {currentWorkspace?.name ?? "this workspace"}
						</TableCaption>
						<TableHeader>
							<TableRow>
								<TableHead>Key</TableHead>
								<TableHead className="hidden md:table-cell">
									Environment
								</TableHead>
								<TableHead className="hidden md:table-cell">Activity</TableHead>
								<TableHead>Budget</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{apiKeys.map((key) => (
								<TableRow key={key.id}>
									<TableCell className="min-w-40">
										<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
											<span className="max-w-32 truncate font-medium">
												{key.name}
											</span>
											<Badge
												variant={key.isActive ? "success" : "secondary"}
												size="sm"
											>
												{key.isActive ? "Active" : "Revoked"}
											</Badge>
											{key.endUserRequired ? (
												<Badge size="sm" variant="outline">
													User required
												</Badge>
											) : null}
										</div>
										<code
											className="mt-1 block font-mono text-muted-foreground text-xs"
											translate="no"
										>
											{key.keyPrefix}••••••••
										</code>
										<div className="mt-1 text-muted-foreground text-xs md:hidden">
											{environmentName(key.environmentId)} ·{" "}
											{key.lastUsedAt ? (
												<>
													used <RelativeTime value={key.lastUsedAt} />
												</>
											) : (
												"never used"
											)}
										</div>
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<Badge variant="outline">
											{environmentName(key.environmentId)}
										</Badge>
									</TableCell>
									<TableCell className="hidden text-xs md:table-cell">
										<div className="font-medium tabular-nums">
											{key.lastUsedAt ? (
												<>
													Used <RelativeTime value={key.lastUsedAt} />
												</>
											) : (
												"Never used"
											)}
										</div>
										<div className="mt-1 text-muted-foreground tabular-nums">
											Created <RelativeTime value={key.createdAt} />
										</div>
									</TableCell>
									<TableCell>
										<KeyBudgetEditor
											apiKeyId={key.id}
											workspaceId={workspaceId}
										/>
									</TableCell>
									<TableCell className="text-right">
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon-xs"
													className="max-sm:size-11"
													aria-label={`Actions for ${key.name}`}
												>
													<MoreHorizontal aria-hidden="true" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuGroup>
													<DropdownMenuItem
														disabled={!key.isActive || !canManageKeys}
														onSelect={() => {
															setSelectedKey(key);
															setDialog("regenerate");
														}}
													>
														<RefreshCw aria-hidden="true" />
														Regenerate…
													</DropdownMenuItem>
													<DropdownMenuItem
														onSelect={() => {
															setSelectedKey(key);
															setDialog("history");
														}}
													>
														<History aria-hidden="true" />
														View history
													</DropdownMenuItem>
												</DropdownMenuGroup>
											</DropdownMenuContent>
										</DropdownMenu>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</SettingsTableFrame>
			) : (
				<SettingsTableFrame>
					<ListEmpty
						action={
							canManageKeys ? (
								<Button size="sm" onClick={() => setDialog("create")}>
									<Plus aria-hidden="true" />
									Create API key
								</Button>
							) : undefined
						}
					>
						No API keys yet. Create one so your server can call Anlyon.
					</ListEmpty>
				</SettingsTableFrame>
			)}

			<CreateApiKeyDialog
				open={dialog === "create"}
				onOpenChange={(open) => setDialog(open ? "create" : null)}
				apiKeyName={newKeyName}
				onApiKeyNameChange={setNewKeyName}
				environments={environments}
				environmentId={newKeyEnvironmentId}
				onEnvironmentChange={setNewKeyEnvironmentId}
				selectedScopes={newKeyScopes}
				onScopesChange={setNewKeyScopes}
				endUserRequired={newKeyEndUserRequired}
				onEndUserRequiredChange={setNewKeyEndUserRequired}
				isPending={createApiKey.isPending}
				onSubmit={async () => {
					if (!workspaceId || !newKeyName.trim()) {
						toast.error("Enter a name for the API key.");
						return;
					}
					if (newKeyScopes.length === 0) {
						toast.error("Select at least one scope for the API key.");
						return;
					}
					const result = await createApiKey.mutateAsync({
						workspaceId,
						data: {
							name: newKeyName.trim(),
							...(newKeyEnvironmentId
								? { environmentId: newKeyEnvironmentId }
								: {}),
							scopes: newKeyScopes,
							...(newKeyEndUserRequired ? { endUserRequired: true } : {}),
						},
					});
					setCreatedKey(result.key);
					setNewKeyName("");
					setNewKeyEnvironmentId("");
					setNewKeyScopes([...STANDARD_SCOPES]);
					setNewKeyEndUserRequired(false);
					setDialog("display-created");
				}}
			/>

			<DisplayApiKeyDialog
				open={dialog === "display-created"}
				onOpenChange={(open) => {
					if (!open) closeSecretDialogs();
				}}
				displayValue={
					showSecret ? (createdKey ?? "") : maskSecret(createdKey ?? "")
				}
				showValue={showSecret}
				onToggleShow={() => setShowSecret((v) => !v)}
				isCopied={isCopied}
				onCopy={() => copy(createdKey, () => setIsCopied(true))}
				onClose={closeSecretDialogs}
			/>

			<RegenerateApiKeyDialog
				open={dialog === "regenerate"}
				onOpenChange={(open) => setDialog(open ? "regenerate" : null)}
				apiKeyName={selectedKey?.name ?? ""}
				isPending={regenerateApiKey.isPending}
				onClose={() => setSelectedKey(null)}
				onConfirm={async () => {
					if (!workspaceId || !selectedKey) return;
					const result = await regenerateApiKey.mutateAsync({
						workspaceId,
						keyId: selectedKey.id,
					});
					setRegeneratedKey(result.key);
					setRollbackExpiresAt(result.rollbackExpiresAt);
					setDialog("display-regenerated");
				}}
			/>

			<DisplayRegeneratedKeyDialog
				open={dialog === "display-regenerated"}
				onOpenChange={(open) => {
					if (!open) closeSecretDialogs();
				}}
				displayValue={
					showSecret ? (regeneratedKey ?? "") : maskSecret(regeneratedKey ?? "")
				}
				showValue={showSecret}
				onToggleShow={() => setShowSecret((v) => !v)}
				isCopied={isCopied}
				onCopy={() => copy(regeneratedKey, () => setIsCopied(true))}
				onClose={() => {
					closeSecretDialogs();
					setSelectedKey(null);
				}}
				rollbackExpiresAt={rollbackExpiresAt}
			/>

			<ApiKeyHistoryDialog
				open={dialog === "history"}
				onOpenChange={(open) => setDialog(open ? "history" : null)}
				apiKeyName={selectedKey?.name ?? ""}
				history={keyHistory?.history}
				rollbackWindowMinutes={keyHistory?.rollbackWindowMinutes}
				isLoading={isLoadingHistory}
				getRollbackTimeRemaining={getRollbackTimeRemaining}
				onClose={() => setSelectedKey(null)}
				onRollback={() => setDialog("rollback")}
			/>

			<RollbackApiKeyDialog
				open={dialog === "rollback"}
				onOpenChange={(open) => setDialog(open ? "rollback" : null)}
				apiKeyName={selectedKey?.name ?? ""}
				isPending={rollbackApiKey.isPending}
				onClose={() => setSelectedKey(null)}
				onConfirm={async () => {
					if (!workspaceId || !selectedKey) return;
					await rollbackApiKey.mutateAsync({
						workspaceId,
						keyId: selectedKey.id,
					});
					setDialog(null);
					setSelectedKey(null);
				}}
			/>
		</SettingsPage>
	);
}
