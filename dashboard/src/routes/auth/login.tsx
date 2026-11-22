import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { LoginForm } from "@/components/auth/login-form";
import { useSetupPending } from "@/hooks/api/use-instance";

const searchSchema = z.object({
	redirect: z.string().optional(),
	sso: z.enum(["required", "failed"]).optional().catch(undefined),
});

export const Route = createFileRoute("/auth/login")({
	validateSearch: searchSchema,
	component: RouteComponent,
});

function RouteComponent() {
	const { redirect, sso } = Route.useSearch();
	const navigate = useNavigate();
	const { data: setupPending } = useSetupPending();
	useEffect(() => {
		if (setupPending) navigate({ to: "/setup" });
	}, [setupPending, navigate]);
	return (
		<div className="flex min-h-svh w-full min-w-0 flex-col items-center justify-center overflow-x-hidden bg-slate-200/30 dark:bg-background p-4 sm:p-6 md:p-10">
			<div className="w-full max-w-sm min-w-0 px-1">
				<div className="flex justify-center items-center flex-col">
					<img src="/logo-light-v2.png" className="w-8 h-8 dark:hidden" />
					<img src="/logo-dark-v2.png" className="hidden w-8 h-8 dark:block" />
				</div>

				<LoginForm redirectTo={redirect} sso={sso} />
			</div>
		</div>
	);
}
