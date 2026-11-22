import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NothingToAuthorize, OAuthShell } from "@/components/oauth/oauth-shell";
import { Button } from "@/components/ui/button";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import {
	errorMessage,
	followRedirect,
	oauthFetch,
	oauthQuery,
} from "@/lib/oauth";

interface ScopeGroup {
	scope: string;
	label: string;
	description: string;
	sensitive: boolean;
	grants: string[];
}

interface ScopeDescriptions {
	groups: ScopeGroup[];
	identity: string[];
}

interface ClientInfo {
	name: string | null;
	uri: string | null;
	redirectHosts: string[];
	selfRegistered: boolean;
	firstSeenMinutesAgo: number;
}

export const Route = createFileRoute("/oauth/consent")({
	component: ConsentPage,
});

function ConsentPage() {
	const [scopes, setScopes] = useState<ScopeDescriptions | null>(null);
	const [client, setClient] = useState<ClientInfo | null>(null);
	const [granted, setGranted] = useState<Set<string>>(new Set());
	const [pending, setPending] = useState<"accept" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);

	const query = oauthQuery();
	const params = new URLSearchParams(query);
	const scope = params.get("scope") ?? "";
	const clientId = params.get("client_id") ?? "";

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload is a deliberate refetch trigger bumped by the retry button.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const [data, info] = await Promise.all([
					oauthFetch<ScopeDescriptions>(
						`/api/oauth/scope-descriptions?scope=${encodeURIComponent(scope)}`,
					),
					oauthFetch<ClientInfo>(
						`/api/oauth/client-info?client_id=${encodeURIComponent(clientId)}`,
					),
				]);
				if (cancelled) return;
				setClient(info);
				setScopes(data);
				setGranted(
					new Set(
						data.groups
							.filter((group) => !group.sensitive)
							.map((group) => group.scope),
					),
				);
				setError(null);
			} catch (cause) {
				if (!cancelled)
					setError(errorMessage(cause, "Could not load permissions."));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [scope, clientId, reload]);

	async function decide(accept: boolean) {
		setPending(accept ? "accept" : "deny");
		setError(null);
		try {
			const grantedScope = accept
				? [...(scopes?.identity ?? []), ...granted].join(" ")
				: "";

			const { data, error: consentError } = await authClient.oauth2.consent({
				accept,
				scope: grantedScope,
				oauth_query: query,
			});
			if (consentError)
				throw new Error(
					consentError.message ?? "Could not record your decision.",
				);
			if (followRedirect(data)) return;
			setPending(null);
		} catch (cause) {
			setError(errorMessage(cause));
			setPending(null);
		}
	}

	if (!query || !clientId) return <NothingToAuthorize />;

	const failedToLoad = error !== null && scopes === null;

	return (
		<OAuthShell>
			<CardHeader>
				<CardTitle>
					<span translate="no">{client?.name ?? "An app"}</span> wants to access
					Anlyon
				</CardTitle>
				<CardDescription>
					It will act as you, in the workspace you selected. Only allow this if
					you just started it.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				{error ? (
					<p aria-live="polite" className="text-destructive text-sm">
						{error}
					</p>
				) : null}

				{client ? (
					<dl className="rounded-md border bg-muted/40 p-3 text-sm">
						{client.redirectHosts.length > 0 ? (
							<div className="flex gap-2">
								<dt className="text-muted-foreground">Sends you back to</dt>
								<dd className="min-w-0 break-all font-medium" translate="no">
									{client.redirectHosts.join(", ")}
								</dd>
							</div>
						) : null}
						<div className="flex gap-2">
							<dt className="text-muted-foreground">Registered</dt>
							<dd className="font-medium">
								{client.firstSeenMinutesAgo < 60
									? `${client.firstSeenMinutesAgo} min ago`
									: `${Math.floor(client.firstSeenMinutesAgo / 60)} h ago`}
								{client.selfRegistered ? " · self-registered" : ""}
							</dd>
						</div>
					</dl>
				) : null}

				{failedToLoad ? (
					<Button
						variant="outline"
						className="w-full"
						onClick={() => setReload((n) => n + 1)}
					>
						Try again
					</Button>
				) : scopes === null ? (
					<ul className="space-y-2" aria-hidden="true">
						{[0, 1, 2].map((row) => (
							<li key={row} className="rounded-md border p-3">
								<div className="flex items-start gap-3">
									<Skeleton className="mt-1 size-4 shrink-0" />
									<div className="min-w-0 flex-1 space-y-2">
										<Skeleton className="h-4 w-24" />
										<Skeleton className="h-4 w-full" />
									</div>
								</div>
							</li>
						))}
					</ul>
				) : scopes.groups.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						It is only asking to confirm who you are. It will not be able to
						read or change your data.
					</p>
				) : (
					<ul className="space-y-2">
						{scopes.groups.map((group) => (
							<li
								key={group.scope}
								className={`rounded-md border p-3 ${group.sensitive ? "border-amber-500/50" : ""}`}
							>
								<label className="flex cursor-pointer items-start gap-3">
									<Checkbox
										className="mt-1"
										checked={granted.has(group.scope)}
										onCheckedChange={(checked) =>
											setGranted((previous) => {
												const next = new Set(previous);
												if (checked) next.add(group.scope);
												else next.delete(group.scope);
												return next;
											})
										}
									/>
									<span className="min-w-0">
										<span className="flex flex-wrap items-center gap-2">
											<span className="font-medium text-sm">{group.label}</span>
											{group.sensitive ? (
												<span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 text-xs dark:text-amber-400">
													High access
												</span>
											) : null}
										</span>
										<span className="block text-muted-foreground text-sm">
											{group.description}
										</span>
									</span>
								</label>
							</li>
						))}
					</ul>
				)}

				{scopes?.groups.some((group) => group.sensitive) ? (
					<p className="text-muted-foreground text-xs">
						Anything marked <span className="font-medium">High access</span> is
						off unless you turn it on.
					</p>
				) : null}

				<div className="flex gap-3">
					<Button
						variant="outline"
						className="flex-1"
						onClick={() => decide(false)}
						disabled={pending !== null}
					>
						{pending === "deny" ? <Spinner className="mr-2 size-4" /> : null}
						Cancel
					</Button>
					<Button
						className="flex-1"
						onClick={() => decide(true)}
						disabled={pending !== null || scopes === null}
					>
						{pending === "accept" ? <Spinner className="mr-2 size-4" /> : null}
						Allow
					</Button>
				</div>

				<p className="text-muted-foreground text-xs">
					You can revoke this at any time from your Anlyon settings.
				</p>
			</CardContent>
		</OAuthShell>
	);
}
