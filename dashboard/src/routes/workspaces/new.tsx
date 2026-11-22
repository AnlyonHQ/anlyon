import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import {
	AlertTriangle,
	CheckCircle,
	Copy,
	Eye,
	EyeOff,
	Key,
	Lock,
	Shield,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import {
	useCreateWorkspace,
	useWorkspaces,
	workspaceKeys,
} from "@/hooks/api/use-workspaces";
import { authClient } from "@/lib/auth-client";
import { secureLogger } from "@/lib/logger";
import { safeRedirect, safeReturnPath } from "@/lib/security";
import { secureStorage } from "@/lib/storage";
import type { WorkspaceCredentials } from "@/lib/types";

export const Route = createFileRoute("/workspaces/new")({
	validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
		typeof search.redirect === "string" ? { redirect: search.redirect } : {},
	beforeLoad: async () => {
		try {
			const session = await authClient.getSession();
			if (!session?.data?.user) {
				throw redirect({
					to: "/auth/login",
				});
			}
		} catch (error) {
			throw redirect({
				to: "/auth/login",
			});
		}
	},
	component: CreateWorkspacePage,
});

const MAX_WORKSPACES = 1;

const createWorkspaceSchema = z.object({
	name: z.string().min(2, "Workspace name must be at least 2 characters"),
});

type CreateWorkspaceFormData = z.infer<typeof createWorkspaceSchema>;

function CreateWorkspacePage() {
	const { redirect: returnTo } = Route.useSearch();
	const createMutation = useCreateWorkspace();
	const queryClient = useQueryClient();

	const { data: allWorkspaces, isLoading: isLoadingWorkspaces } =
		useWorkspaces();

	const [isCredentialsDialogOpen, setIsCredentialsDialogOpen] = useState(false);
	const [credentials, setCredentials] = useState<WorkspaceCredentials | null>(
		null,
	);
	const [showApiKey, setShowApiKey] = useState(false);
	const [showSigningSecret, setShowSigningSecret] = useState(false);
	const [apiKeyCopied, setApiKeyCopied] = useState(false);
	const [signingSecretCopied, setSigningSecretCopied] = useState(false);

	const workspaceCount = allWorkspaces?.length || 0;
	const maxWorkspacesReached = workspaceCount >= MAX_WORKSPACES;
	const canCreateWorkspace = !maxWorkspacesReached;

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<CreateWorkspaceFormData>({
		resolver: zodResolver(createWorkspaceSchema),
	});

	const goNext = () => {
		const heading = safeReturnPath(returnTo);
		if (heading) window.location.assign(heading);
		else safeRedirect("/workspaces/setup");
	};

	const onSubmit = async (data: CreateWorkspaceFormData) => {
		try {
			const newWorkspace = await createMutation.mutateAsync(data);

			if (newWorkspace?.id) {
				secureStorage.setItem("current_workspace_id", newWorkspace.id);
			}

			await queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });

			if (newWorkspace?.credentials) {
				setCredentials(newWorkspace.credentials);
				setIsCredentialsDialogOpen(true);
			} else {
				toast.success("Workspace created successfully!");
				goNext();
			}
		} catch (error) {
			secureLogger.error("Failed to create workspace:", error);
		}
	};

	const handleCopyApiKey = () => {
		if (credentials?.apiKey?.key) {
			navigator.clipboard.writeText(credentials.apiKey.key);
			setApiKeyCopied(true);
			toast.success("API key copied to clipboard");
			setTimeout(() => setApiKeyCopied(false), 2000);
		}
	};

	const handleCopySigningSecret = () => {
		if (credentials?.signingSecret?.secretKey) {
			navigator.clipboard.writeText(credentials.signingSecret.secretKey);
			setSigningSecretCopied(true);
			toast.success("Signing secret copied to clipboard");
			setTimeout(() => setSigningSecretCopied(false), 2000);
		}
	};

	const handleCloseCredentialsDialog = () => {
		setCredentials(null);
		setShowApiKey(false);
		setShowSigningSecret(false);
		setApiKeyCopied(false);
		setSigningSecretCopied(false);
		setIsCredentialsDialogOpen(false);

		toast.success("Workspace created successfully!");
		goNext();
	};

	const maskSecret = (secret: string) => {
		if (!secret) return "";
		const prefix = secret.slice(0, 8);
		return `${prefix}${"•".repeat(Math.min(secret.length - 8, 24))}`;
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
			<div className="w-full max-w-md">
				<div className="mb-8 text-center">
					<h1 className="text-3xl font-bold">Create Workspace</h1>
					{workspaceCount > 0 && (
						<p className="mt-2 text-sm text-muted-foreground">
							Only one workspace is allowed per user.
						</p>
					)}
				</div>

				{maxWorkspacesReached && (
					<Card className="mb-4 border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/50">
						<CardContent className="pt-6">
							<div className="flex items-start gap-3">
								<Lock className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
								<div className="flex-1">
									<h3 className="font-medium text-red-900 dark:text-red-100">
										You already have a workspace
									</h3>
									<p className="mt-1 text-sm text-red-800 dark:text-red-200">
										Only one workspace per user is supported right now. Continue
										with your existing workspace.
									</p>
									<Link to="/dashboard">
										<Button variant="outline" size="sm" className="mt-3">
											Go to Dashboard
										</Button>
									</Link>
								</div>
							</div>
						</CardContent>
					</Card>
				)}

				<Card>
					<CardHeader>
						<CardTitle>Workspace Name</CardTitle>
					</CardHeader>
					<CardContent>
						<Form onSubmit={handleSubmit(onSubmit)}>
							<Field name="name">
								<FieldLabel htmlFor="name">Name</FieldLabel>
								<Input
									id="name"
									placeholder="My Company"
									{...register("name")}
									disabled={createMutation.isPending || !canCreateWorkspace}
								/>
								{errors.name && <FieldError>{errors.name.message}</FieldError>}
							</Field>

							<Button
								type="submit"
								className="w-full mt-4"
								disabled={
									createMutation.isPending ||
									!canCreateWorkspace ||
									isLoadingWorkspaces
								}
								loading={createMutation.isPending || isLoadingWorkspaces}
							>
								{canCreateWorkspace
									? "Create Workspace"
									: "Maximum Workspaces Reached"}
							</Button>
						</Form>
					</CardContent>
				</Card>
			</div>

			<Dialog open={isCredentialsDialogOpen} onOpenChange={() => {}}>
				<DialogPopup className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Workspace Created</DialogTitle>
						<DialogDescription>
							Save your API credentials now - you won't be able to see them
							again.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/50 p-3 mb-4">
							<div className="flex items-start gap-2">
								<AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5" />
								<p className="text-sm text-amber-800 dark:text-amber-200">
									Copy these credentials now. They won't be shown again.
								</p>
							</div>
						</div>

						<div className="space-y-4">
							{credentials?.apiKey && (
								<div className="rounded-lg border p-4">
									<div className="flex items-center gap-2 mb-3">
										<Key className="h-4 w-4 text-primary" />
										<span className="font-medium">API Key</span>
									</div>
									<div className="space-y-2">
										<div className="flex gap-2">
											<div className="relative flex-1">
												<Input
													readOnly
													value={
														showApiKey
															? credentials.apiKey.key
															: maskSecret(credentials.apiKey.key)
													}
													className="font-mono text-sm pr-10"
												/>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
													onClick={() => setShowApiKey(!showApiKey)}
												>
													{showApiKey ? (
														<EyeOff className="h-4 w-4 text-muted-foreground" />
													) : (
														<Eye className="h-4 w-4 text-muted-foreground" />
													)}
												</Button>
											</div>
											<Button
												size="icon"
												variant="outline"
												onClick={handleCopyApiKey}
											>
												{apiKeyCopied ? (
													<CheckCircle className="h-4 w-4 text-green-500" />
												) : (
													<Copy className="h-4 w-4" />
												)}
											</Button>
										</div>
									</div>
								</div>
							)}

							{credentials?.signingSecret && (
								<div className="rounded-lg border p-4">
									<div className="flex items-center gap-2 mb-3">
										<Shield className="h-4 w-4 text-primary" />
										<span className="font-medium">Webhook Signing Secret</span>
									</div>
									<div className="space-y-2">
										<div className="flex gap-2">
											<div className="relative flex-1">
												<Input
													readOnly
													value={
														showSigningSecret
															? credentials.signingSecret.secretKey
															: maskSecret(credentials.signingSecret.secretKey)
													}
													className="font-mono text-sm pr-10"
												/>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
													onClick={() =>
														setShowSigningSecret(!showSigningSecret)
													}
												>
													{showSigningSecret ? (
														<EyeOff className="h-4 w-4 text-muted-foreground" />
													) : (
														<Eye className="h-4 w-4 text-muted-foreground" />
													)}
												</Button>
											</div>
											<Button
												size="icon"
												variant="outline"
												onClick={handleCopySigningSecret}
											>
												{signingSecretCopied ? (
													<CheckCircle className="h-4 w-4 text-green-500" />
												) : (
													<Copy className="h-4 w-4" />
												)}
											</Button>
										</div>
									</div>
								</div>
							)}
						</div>
					</DialogPanel>
					<DialogFooter>
						<Button onClick={handleCloseCredentialsDialog}>Continue</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</div>
	);
}
