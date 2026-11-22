import { createFileRoute } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { OAuthGrantEnvironmentSelect } from "@/components/settings/oauth-grant-environment-select";
import {
	ListEmpty,
	SettingsPage,
	SettingsTableFrame,
} from "@/components/settings/settings-page";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type OAuthGrant,
	useOAuthGrants,
	useRevokeOAuthGrant,
} from "@/hooks/api/use-oauth-grants";

export const Route = createFileRoute("/_protected/settings/connected-apps")({
	component: ConnectedAppsPage,
});

function since(iso: string): string {
	return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

function ConnectedAppsPage() {
	const { data: grants, isLoading, error } = useOAuthGrants();
	const revoke = useRevokeOAuthGrant();
	const [confirming, setConfirming] = useState<OAuthGrant | null>(null);

	return (
		<SettingsPage
			title="Authorized apps"
			description="Apps you have allowed to act as you in Anlyon. Disconnecting one takes effect immediately."
		>
			{error ? (
				<p aria-live="polite" className="text-destructive text-sm">
					{error.message}
				</p>
			) : isLoading ? (
				<SettingsTableFrame>
					<ul className="divide-y">
						{[0, 1].map((row) => (
							<li key={row} className="p-4">
								<div className="space-y-2">
									<Skeleton className="h-5 w-40" />
									<Skeleton className="h-4 w-64" />
								</div>
							</li>
						))}
					</ul>
				</SettingsTableFrame>
			) : !grants || grants.length === 0 ? (
				<SettingsTableFrame>
					<ListEmpty
						action={
							<Button
								render={
									<a
										href="https://docs.anlyon.com/agents/claude-code"
										rel="noreferrer"
										target="_blank"
									/>
								}
								size="sm"
								variant="outline"
							>
								Read the MCP guide
							</Button>
						}
					>
						No authorized apps yet. Point an MCP client, such as Claude or
						Cursor, at your Anlyon MCP URL; after you sign in, it appears here.
					</ListEmpty>
				</SettingsTableFrame>
			) : (
				<SettingsTableFrame
					footer={
						<>
							<span className="tabular-nums">
								{grants.length} {grants.length === 1 ? "app" : "apps"}
							</span>
							<span>
								Connected with Login with Anlyon. Disconnect anything you do not
								recognise.
							</span>
						</>
					}
				>
					<ul className="divide-y">
						{grants.map((grant) => (
							<li
								key={grant.clientId}
								className="p-4 transition-colors duration-150 ease-out hover:bg-muted/30"
							>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium" translate="no">
												{grant.name ?? "Unnamed app"}
											</span>
											{!grant.active ? (
												<Badge variant="secondary">Dormant</Badge>
											) : null}
											{grant.permissions.some(
												(permission) => permission.sensitive,
											) ? (
												<Badge
													variant="outline"
													className="border-amber-500/50 text-amber-700 dark:text-amber-400"
												>
													High access
												</Badge>
											) : null}
										</div>

										<p className="mt-1 text-muted-foreground text-sm">
											{grant.workspace ? (
												<>
													Works in{" "}
													<span className="font-medium text-foreground">
														{grant.workspace.name}
													</span>
													{grant.environment
														? ` · ${grant.environment.name}`
														: ""}
												</>
											) : (
												"No workspace selected yet"
											)}
										</p>

										<p className="mt-1 text-muted-foreground text-sm">
											Can:{" "}
											{grant.permissions.length > 0
												? grant.permissions
														.map((permission) => permission.label)
														.join(", ")
												: "confirm who you are, nothing else"}
										</p>

										<OAuthGrantEnvironmentSelect grant={grant} />

										<p className="mt-2 text-muted-foreground text-xs">
											Connected {since(grant.authorizedAt)}
											{grant.lastRenewedAt
												? ` · last used ${since(grant.lastRenewedAt)}`
												: ""}
											{grant.redirectHosts.length > 0
												? ` · sends you back to ${grant.redirectHosts.join(", ")}`
												: ""}
										</p>
									</div>

									<Button
										variant="outline"
										size="sm"
										onClick={() => setConfirming(grant)}
										loading={
											revoke.isPending && revoke.variables === grant.clientId
										}
									>
										Disconnect
									</Button>
								</div>
							</li>
						))}
					</ul>
				</SettingsTableFrame>
			)}

			<AlertDialog
				open={confirming !== null}
				onOpenChange={(open) => !open && setConfirming(null)}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<ShieldAlert className="size-4 text-destructive" />
							Disconnect {confirming?.name ?? "this app"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							It loses access immediately, even mid-task, and cannot reconnect
							without you signing in and allowing it again.
							{confirming?.workspace
								? ` It currently works in ${confirming.workspace.name}.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Keep it
						</AlertDialogClose>
						<AlertDialogClose
							render={
								<Button variant="destructive" loading={revoke.isPending} />
							}
							onClick={() => {
								if (confirming) revoke.mutate(confirming.clientId);
								setConfirming(null);
							}}
						>
							Disconnect
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</SettingsPage>
	);
}
