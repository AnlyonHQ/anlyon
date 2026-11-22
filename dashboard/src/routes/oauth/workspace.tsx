import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NothingToAuthorize, OAuthShell } from "@/components/oauth/oauth-shell";
import { Button } from "@/components/ui/button";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import {
	errorMessage,
	followRedirect,
	oauthFetch,
	oauthQuery,
} from "@/lib/oauth";

interface Environment {
	id: string;
	name: string;
	slug: string;
	isDefault: boolean;
}

interface Workspace {
	id: string;
	name: string;
	slug: string;
	role: string;
	environments: Environment[];
}

const defaultEnvironmentId = (workspace: Workspace | undefined): string =>
	(
		workspace?.environments.find((environment) => environment.isDefault) ??
		workspace?.environments[0]
	)?.id ?? "";

export const Route = createFileRoute("/oauth/workspace")({
	component: WorkspacePickerPage,
});

function WorkspacePickerPage() {
	const navigate = useNavigate();
	const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
	const [workspaceId, setWorkspaceId] = useState("");
	const [environmentId, setEnvironmentId] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);

	const query = oauthQuery();
	const clientId = new URLSearchParams(query).get("client_id") ?? "";

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload is a deliberate refetch trigger bumped by the retry button.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const { workspaces: loaded } = await oauthFetch<{
					workspaces: Workspace[];
				}>("/api/oauth/workspaces");
				if (cancelled) return;
				setWorkspaces(loaded);
				setWorkspaceId(loaded[0]?.id ?? "");
				setEnvironmentId(defaultEnvironmentId(loaded[0]));
				setError(null);
			} catch (cause) {
				if (!cancelled)
					setError(errorMessage(cause, "Could not load your workspaces."));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [reload]);

	const selected = workspaces?.find(
		(workspace) => workspace.id === workspaceId,
	);

	async function onContinue() {
		setSubmitting(true);
		setError(null);
		try {
			await oauthFetch("/api/oauth/workspace-binding", {
				method: "POST",
				body: JSON.stringify({ clientId, workspaceId, environmentId }),
			});

			const { data, error: continueError } = await authClient.oauth2.continue({
				postLogin: true,
				oauth_query: query,
			});
			if (continueError)
				throw new Error(
					continueError.message ?? "Could not continue authorization.",
				);
			if (followRedirect(data)) return;
			await navigate({ to: "/" });
		} catch (cause) {
			setError(errorMessage(cause));
			setSubmitting(false);
		}
	}

	if (!clientId) {
		return (
			<NothingToAuthorize detail="Open this page from the app you are connecting  it carries the request this step needs." />
		);
	}

	const failedToLoad = error !== null && workspaces === null;

	return (
		<OAuthShell>
			<CardHeader>
				<CardTitle>Choose a workspace</CardTitle>
				<CardDescription>
					You belong to more than one workspace. Pick the one this app should
					work in it will only see this workspace's data.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				{error ? (
					<p aria-live="polite" className="text-destructive text-sm">
						{error}
					</p>
				) : null}

				{failedToLoad ? (
					<Button
						variant="outline"
						className="w-full"
						onClick={() => setReload((n) => n + 1)}
					>
						Try again
					</Button>
				) : workspaces === null ? (
					<div className="space-y-5" aria-hidden="true">
						{[0, 1].map((field) => (
							<div key={field} className="space-y-2">
								<Skeleton className="h-4 w-24" />
								<Skeleton className="h-8 w-full" />
							</div>
						))}
					</div>
				) : (
					<>
						<div className="space-y-2">
							<Label htmlFor="workspace">Workspace</Label>
							<NativeSelect
								id="workspace"
								className="w-full"
								value={workspaceId}
								onChange={(event) => {
									const next = workspaces.find(
										(workspace) => workspace.id === event.target.value,
									);
									setWorkspaceId(event.target.value);
									setEnvironmentId(defaultEnvironmentId(next));
								}}
							>
								{workspaces.map((workspace) => (
									<NativeSelectOption
										key={workspace.id}
										value={workspace.id}
										translate="no"
									>
										{workspace.name} ({workspace.role})
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>

						<div className="space-y-2">
							<Label htmlFor="environment">Environment</Label>
							<NativeSelect
								id="environment"
								className="w-full"
								value={environmentId}
								onChange={(event) => setEnvironmentId(event.target.value)}
							>
								{selected?.environments.map((environment) => (
									<NativeSelectOption
										key={environment.id}
										value={environment.id}
										translate="no"
									>
										{environment.name}
										{environment.isDefault ? " (default)" : ""}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
					</>
				)}

				<Button
					className="w-full"
					onClick={onContinue}
					disabled={submitting || !workspaceId || !environmentId}
				>
					{submitting ? <Spinner className="mr-2 size-4" /> : null}
					Continue
				</Button>

				<p className="text-muted-foreground text-xs">
					You can change this later from the app, or by connecting again.
				</p>
			</CardContent>
		</OAuthShell>
	);
}
