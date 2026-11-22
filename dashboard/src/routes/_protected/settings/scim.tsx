import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { TeamPlanNotice } from "@/components/plan/team-plan-notice";
import {
	ConfirmAction,
	CopyValue,
	EnterpriseOnly,
	RoleSelect,
} from "@/components/settings/identity-shared";
import {
	LearnMore,
	SettingsPage,
	SettingsRow,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	isUnavailable,
	type ScimRoleMapping,
	type ScimSettings,
	useIssueScimToken,
	useReplaceScimRoleMappings,
	useRevokeScimToken,
	useScimSettings,
	useSsoConnection,
	useUpdateScimDefaultRole,
} from "@/hooks/api/use-identity";
import { useWorkspaceMembers } from "@/hooks/api/use-workspaces";
import { useAuth } from "@/hooks/use-auth";
import { usePlanAccess } from "@/hooks/use-plan-access";

export const Route = createFileRoute("/_protected/settings/scim")({
	component: ScimSettingsPage,
});

function ScimSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id ?? "";
	const { user } = useAuth();
	const { data: members } = useWorkspaceMembers(workspaceId);
	const myRole = members?.find((m) => m.userId === user?.id)?.role;
	const isAdmin = myRole === "admin";
	const { data: settings, isLoading, error } = useScimSettings(workspaceId);
	const { teamPlanRequired } = usePlanAccess(workspaceId);

	return (
		<SettingsPage
			title="Directory sync"
			description="Your identity directory adds and removes members over SCIM 2.0, and its groups set their roles."
		>
			{isUnavailable(error) ? (
				<EnterpriseOnly feature="Directory sync" />
			) : isLoading || !settings ? (
				<Skeleton className="h-40 w-full" />
			) : !isAdmin ? (
				<p className="text-muted-foreground text-sm">
					Only workspace admins can view or change directory sync.
				</p>
			) : (
				<>
					<TeamPlanNotice
						feature="Directory sync"
						hasConfiguration={settings.connected}
					/>
					{settings.connected || !teamPlanRequired ? (
						<ScimSettingsBody workspaceId={workspaceId} settings={settings} />
					) : null}
				</>
			)}
		</SettingsPage>
	);
}

function ScimSettingsBody({
	workspaceId,
	settings,
}: {
	workspaceId: string;
	settings: ScimSettings;
}) {
	const issue = useIssueScimToken(workspaceId);
	const revoke = useRevokeScimToken(workspaceId);
	const updateDefault = useUpdateScimDefaultRole(workspaceId);
	const sso = useSsoConnection(workspaceId);
	const [token, setToken] = useState<string | null>(null);

	const createToken = async () => {
		const result = await issue.mutateAsync();
		setToken(result.token);
	};

	return (
		<>
			<SettingsSection
				title="Connection"
				description={
					<>
						Enter these in your directory's SCIM app for Anlyon. The token is
						shown once.{" "}
						<LearnMore href="https://docs.anlyon.com/account/sso-scim#the-token" />
					</>
				}
				footer={
					settings.connected ? (
						<ConfirmAction
							title="Generate a new SCIM token?"
							description="The current token stops working now. Update your directory with the new one."
							confirmLabel="Generate new token"
							pending={issue.isPending}
							onConfirm={createToken}
							trigger={(open) => (
								<Button size="sm" variant="outline" onClick={open}>
									Generate new token
								</Button>
							)}
						/>
					) : (
						<Button
							size="sm"
							loading={issue.isPending}
							disabled={issue.isPending}
							onClick={createToken}
						>
							Generate SCIM token
						</Button>
					)
				}
			>
				<div className="flex flex-col gap-3">
					<CopyValue label="SCIM base URL" value={settings.baseUrl} />
					{settings.connected ? (
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
							<dt className="text-muted-foreground">Token</dt>
							<dd className="font-mono">{settings.tokenPrefix}••••••••</dd>
							<dt className="text-muted-foreground">Last used</dt>
							<dd>
								{settings.lastUsedAt ? (
									<RelativeTime value={settings.lastUsedAt} />
								) : (
									"Never"
								)}
							</dd>
						</dl>
					) : (
						<p className="text-sm text-muted-foreground">
							Not connected. Generate a token to connect a directory.
						</p>
					)}
				</div>
			</SettingsSection>

			<SettingsSection
				title="What the directory changes"
				description={
					<>
						Removing someone in the directory ends their access here at once,
						keys and apps included.{" "}
						<LearnMore href="https://docs.anlyon.com/account/sso-scim#deactivating-and-deleting" />
					</>
				}
			>
				<div className="flex flex-col gap-3 text-sm text-muted-foreground">
					<p>
						The directory can add a person only if their email address is on a
						domain verified for this workspace's{" "}
						<Link
							className="text-foreground underline underline-offset-4"
							to="/settings/sso"
						>
							single sign-on
						</Link>
						, or if they are a member already. Anyone else is refused, and the
						directory reports the error.
					</p>
					{!sso.isSuccess || sso.data?.domainsVerified ? null : (
						<Alert variant="warning">
							<AlertDescription>
								This workspace has no verified single sign-on domain yet, so the
								directory can update existing members but cannot add new people.
								Connect an identity provider and verify its domains first.
							</AlertDescription>
						</Alert>
					)}
				</div>
			</SettingsSection>

			<SettingsSection
				title="Default role"
				description="The role of a provisioned member who is in none of the mapped groups below."
			>
				<RoleSelect
					value={settings.defaultRole}
					disabled={!settings.connected || updateDefault.isPending}
					onChange={(role) => updateDefault.mutate(role)}
				/>
			</SettingsSection>

			<RoleMappings
				workspaceId={workspaceId}
				mappings={settings.roleMappings}
			/>

			{settings.connected ? (
				<SettingsSection title="Danger zone" variant="danger">
					<SettingsRow
						label="Disconnect directory"
						description="The token stops working. Members it added stay members with their current role."
					>
						<ConfirmAction
							title="Disconnect the directory?"
							description="Changes in your directory will no longer reach this workspace."
							confirmLabel="Disconnect"
							pending={revoke.isPending}
							onConfirm={() => revoke.mutate(undefined)}
							trigger={(open) => (
								<Button size="sm" variant="destructive" onClick={open}>
									Disconnect
								</Button>
							)}
						/>
					</SettingsRow>
				</SettingsSection>
			) : null}

			<Dialog
				open={token !== null}
				onOpenChange={(open) => {
					if (!open) setToken(null);
				}}
			>
				<DialogPopup className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>SCIM token</DialogTitle>
						<DialogDescription>
							Copy it into your directory now. It is not shown again.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<div className="flex flex-col gap-4">
							<Alert variant="warning">
								<AlertDescription>
									Anyone with this token can add and remove members of this
									workspace. Store it only in your directory.
								</AlertDescription>
							</Alert>
							{token ? <CopyValue label="Token" value={token} /> : null}
						</div>
					</DialogPanel>
					<DialogFooter>
						<Button onClick={() => setToken(null)}>I have copied it</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</>
	);
}

type Row = { groupName: string; role: string; priority: string };

const toRows = (list: ScimRoleMapping[]): Row[] =>
	list.map((m) => ({ ...m, priority: String(m.priority) }));

function RoleMappings({
	workspaceId,
	mappings,
}: {
	workspaceId: string;
	mappings: ScimRoleMapping[];
}) {
	const save = useReplaceScimRoleMappings(workspaceId);
	const [rows, setRows] = useState<Row[]>(toRows(mappings));
	useEffect(() => setRows(toRows(mappings)), [mappings]);

	const set = (index: number, patch: Partial<Row>) =>
		setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

	const valid = rows.every(
		(row) => row.groupName.trim() && /^-?\d+$/.test(row.priority.trim()),
	);

	return (
		<SettingsSection
			title="Group to role"
			description={
				<>
					A directory group gives its members a role. The highest priority wins.{" "}
					<LearnMore href="https://docs.anlyon.com/account/sso-scim#groups-map-to-roles" />
				</>
			}
			footer={
				<Button
					size="sm"
					disabled={!valid || save.isPending}
					loading={save.isPending}
					onClick={() =>
						save.mutate(
							rows.map((row) => ({
								groupName: row.groupName.trim(),
								role: row.role,
								priority: Number.parseInt(row.priority, 10),
							})),
						)
					}
				>
					Save mappings
				</Button>
			}
		>
			<div className="flex flex-col gap-2">
				{rows.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No mappings. Every provisioned member gets the default role.
					</p>
				) : (
					<div className="grid grid-cols-[1fr_auto_5rem_auto] items-center gap-2 text-xs text-muted-foreground">
						<span>Group name</span>
						<span>Role</span>
						<span>Priority</span>
						<span />
					</div>
				)}
				{rows.map((row, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
						key={index}
						className="grid grid-cols-[1fr_auto_5rem_auto] items-center gap-2"
					>
						<Input
							aria-label="Group name"
							placeholder="Anlyon Admins"
							value={row.groupName}
							onChange={(e) => set(index, { groupName: e.target.value })}
						/>
						<RoleSelect
							value={row.role}
							onChange={(role) => set(index, { role })}
						/>
						<Input
							aria-label="Priority"
							inputMode="numeric"
							value={row.priority}
							onChange={(e) => set(index, { priority: e.target.value })}
						/>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							aria-label="Remove mapping"
							onClick={() => setRows(rows.filter((_, i) => i !== index))}
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				))}
				<div>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() =>
							setRows([
								...rows,
								{ groupName: "", role: "member", priority: "0" },
							])
						}
					>
						<Plus className="h-4 w-4" />
						Add mapping
					</Button>
				</div>
			</div>
		</SettingsSection>
	);
}
