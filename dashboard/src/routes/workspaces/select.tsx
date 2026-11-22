import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaces } from "@/hooks/api/use-workspaces";
import { authClient } from "@/lib/auth-client";
import { secureStorage } from "@/lib/storage";

export const Route = createFileRoute("/workspaces/select")({
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
	component: SelectWorkspacePage,
});

function SelectWorkspacePage() {
	const navigate = useNavigate();
	const { data: workspaces, isLoading } = useWorkspaces();

	const selectWorkspace = (workspaceId: string) => {
		secureStorage.setItem("current_workspace_id", workspaceId);
		navigate({ to: "/dashboard" });
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
			<div className="w-full max-w-2xl">
				<div className="mb-8 text-center">
					<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
						<Building2 className="h-8 w-8" />
					</div>
					<h1 className="text-3xl font-bold">Select a Workspace</h1>
					<p className="mt-2 text-muted-foreground">
						Choose a workspace to continue
					</p>
				</div>

				{isLoading ? (
					<div className="space-y-4">
						{[1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-24 w-full" />
						))}
					</div>
				) : workspaces && workspaces.length > 0 ? (
					<div className="space-y-4">
						{workspaces
							.filter((w) => w?.name && w.id)
							.map((workspace) => (
								<Card
									key={workspace.id}
									className="cursor-pointer transition-colors hover:bg-accent"
									onClick={() => selectWorkspace(workspace.id)}
								>
									<CardHeader>
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-3">
												<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold">
													{workspace.name[0].toUpperCase()}
												</div>
												<div>
													<CardTitle className="text-lg">
														{workspace.name}
													</CardTitle>
													<CardDescription className="text-sm">
														{workspace.slug}
													</CardDescription>
												</div>
											</div>
											<div className="flex items-center gap-2">
												<Badge variant="secondary">{workspace.plan}</Badge>
												<ArrowRight className="h-5 w-5 text-muted-foreground" />
											</div>
										</div>
									</CardHeader>
								</Card>
							))}
					</div>
				) : (
					<Card>
						<CardContent className="flex flex-col items-center justify-center py-12">
							<Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
							<p className="mb-4 text-center text-muted-foreground">
								You don't have any workspaces yet
							</p>
							<Button onClick={() => navigate({ to: "/workspaces/new" })}>
								Create Your First Workspace
							</Button>
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	);
}
