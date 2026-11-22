import { type FormEvent, useId, useState } from "react";
import { PageSection } from "@/components/layout/page";
import { CopyValue } from "@/components/settings/identity-shared";
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
	DialogForm,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	useDeleteEnvironmentOAuthApp,
	useEnvironmentOAuthApp,
	useSaveEnvironmentOAuthApp,
} from "@/hooks/api/use-end-users";
import type { IntegrationOverview, SignInApp } from "@/lib/types";

const GOOGLE = new Set(["gmail", "google-calendar"]);

export const SIGN_IN_APP_LABEL: Record<SignInApp, string> = {
	anlyon: "Anlyon's app",
	own: "Your app",
	own_required: "Needs your app",
	unavailable: "Unavailable",
};

export function SignInAppBadge({ app }: { app: SignInApp }) {
	return (
		<Badge
			variant={
				app === "own_required"
					? "warning"
					: app === "unavailable"
						? "outline"
						: "secondary"
			}
		>
			{SIGN_IN_APP_LABEL[app]}
		</Badge>
	);
}

export function SignInPanel({
	integration,
	environmentId,
	workspaceId,
	canManage,
}: {
	integration: IntegrationOverview;
	environmentId?: string;
	workspaceId?: string;
	canManage: boolean;
}) {
	const app = useEnvironmentOAuthApp(
		workspaceId,
		environmentId,
		integration.id,
	);
	const remove = useDeleteEnvironmentOAuthApp(workspaceId, environmentId);
	const signIn = integration.signIn;
	if (!signIn) return null;
	const configured = app.data?.configured ?? signIn.app === "own";
	const redirectUri = app.data?.redirectUri ?? signIn.redirectUri;

	const summary =
		signIn.app === "own"
			? `People sign in with your own ${integration.name} app, and its consent screen shows your app's name.`
			: signIn.app === "anlyon"
				? `People sign in with Anlyon's ${integration.name} app. There is nothing to set up; the consent screen names Anlyon. Add your own app to show your name instead.`
				: signIn.app === "own_required"
					? `Anlyon does not offer its own ${integration.name} app yet. Add your OAuth app to connect accounts here, your own and your users'.`
					: "Signing in is not set up on this deployment.";

	return (
		<>
			<PageSection title="Sign-in app">
				<div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="flex min-w-0 flex-col gap-1">
							<span className="flex items-center gap-2 font-medium text-sm">
								{configured ? "Your app" : SIGN_IN_APP_LABEL[signIn.app]}
								{configured && app.data?.clientId ? (
									<code
										className="truncate font-mono text-muted-foreground text-xs"
										translate="no"
									>
										{app.data.clientId}
									</code>
								) : null}
							</span>
							<p className="max-w-prose text-muted-foreground text-sm">
								{summary}
								{GOOGLE.has(integration.id) && !configured
									? " Google requires your own app in production."
									: ""}
							</p>
						</div>
						{canManage && environmentId && signIn.app !== "unavailable" ? (
							<span className="flex items-center gap-1">
								<OAuthAppDialog
									clientId={configured ? (app.data?.clientId ?? null) : null}
									environmentId={environmentId}
									integration={integration}
									redirectUri={redirectUri}
									workspaceId={workspaceId}
								/>
								{configured ? (
									<AlertDialog>
										<AlertDialogTrigger
											render={
												<Button
													aria-label={`Remove your ${integration.name} app`}
													disabled={remove.isPending}
													size="sm"
													variant="ghost"
												>
													Remove
												</Button>
											}
										/>
										<AlertDialogPopup>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Remove your {integration.name} app?
												</AlertDialogTitle>
												<AlertDialogDescription>
													New connections use Anlyon's app where it offers one.
													Accounts connected with your app may stop working when
													their tokens need renewing, and those people connect
													again.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogClose
													render={<Button variant="outline">Cancel</Button>}
												/>
												<AlertDialogClose
													render={
														<Button
															onClick={() =>
																remove.mutate({ integration: integration.id })
															}
															variant="destructive"
														>
															Remove app
														</Button>
													}
												/>
											</AlertDialogFooter>
										</AlertDialogPopup>
									</AlertDialog>
								) : null}
							</span>
						) : null}
					</div>
					{signIn.app !== "unavailable" ? (
						<CopyValue
							label="Redirect URI for your own app"
							value={redirectUri}
						/>
					) : null}
				</div>
			</PageSection>
			{integration.scopes.length > 0 ? (
				<PageSection
					description="What a person approves at the provider's consent screen."
					title="Access requested"
				>
					<ul className="flex flex-wrap gap-1.5" translate="no">
						{integration.scopes.map((scope) => (
							<li key={scope}>
								<code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
									{scope}
								</code>
							</li>
						))}
					</ul>
				</PageSection>
			) : null}
		</>
	);
}

export function OAuthAppDialog({
	integration,
	environmentId,
	workspaceId,
	clientId: savedClientId,
	redirectUri,
}: {
	integration: { id: string; name: string };
	environmentId: string;
	workspaceId?: string;
	clientId: string | null;
	redirectUri: string;
}) {
	const id = useId();
	const save = useSaveEnvironmentOAuthApp(workspaceId, environmentId);
	const [open, setOpen] = useState(false);
	const [clientId, setClientId] = useState(savedClientId ?? "");
	const [secret, setSecret] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const editing = savedClientId !== null;

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!clientId.trim()) return setProblem("Enter the client id.");
		if (!secret.trim()) return setProblem("Enter the client secret.");
		setProblem(null);
		save.mutate(
			{
				integration: integration.id,
				clientId: clientId.trim(),
				clientSecret: secret.trim(),
			},
			{
				onSuccess: () => {
					setSecret("");
					setOpen(false);
				},
				onError: (error: Error) => setProblem(error.message),
			},
		);
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setClientId(savedClientId ?? "");
				else {
					setSecret("");
					setProblem(null);
				}
			}}
			open={open}
		>
			<DialogTrigger
				render={
					<Button
						aria-label={`${editing ? "Change" : "Use"} your own ${integration.name} app`}
						size="sm"
						variant="outline"
					>
						{editing ? "Change" : "Use your own app"}
					</Button>
				}
			/>
			<DialogPopup className="sm:max-w-lg">
				<DialogForm noValidate onSubmit={submit}>
					<DialogHeader>
						<DialogTitle>Your own {integration.name} app</DialogTitle>
						<DialogDescription>
							Create an OAuth app at {integration.name}, register the redirect
							URI below, then paste its client id and secret.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<FieldGroup>
							<CopyValue label="Redirect URI to register" value={redirectUri} />
							<Field>
								<FieldLabel htmlFor={`${id}-client`}>Client id</FieldLabel>
								<Input
									autoComplete="off"
									autoFocus
									className="font-mono"
									id={`${id}-client`}
									onChange={(event) => setClientId(event.target.value)}
									spellCheck={false}
									translate="no"
									value={clientId}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-secret`}>Client secret</FieldLabel>
								<Input
									autoComplete="off"
									className="font-mono"
									id={`${id}-secret`}
									onChange={(event) => setSecret(event.target.value)}
									placeholder={
										editing ? "Enter it again to save a change" : undefined
									}
									spellCheck={false}
									type="password"
									value={secret}
								/>
								<FieldDescription>
									Stored encrypted. Nobody can read it back, including you.
								</FieldDescription>
							</Field>
							{problem ? (
								<p className="text-destructive text-sm" role="alert">
									{problem}
								</p>
							) : null}
						</FieldGroup>
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button loading={save.isPending} type="submit">
							Save app
						</Button>
					</DialogFooter>
				</DialogForm>
			</DialogPopup>
		</Dialog>
	);
}
