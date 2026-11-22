import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SignupForm } from "@/components/auth/signup-form";

const searchParamsSchema = z.object({
	redirect: z.string().optional(),
	email: z.string().optional(),
});

export const Route = createFileRoute("/auth/signup")({
	component: SignupPage,
	validateSearch: searchParamsSchema,
});

function SignupPage() {
	const { redirect, email } = Route.useSearch();

	return (
		<div className="flex min-h-svh w-full min-w-0 flex-col items-center justify-center overflow-x-hidden bg-slate-200/30 dark:bg-background p-4 sm:p-6 md:p-10">
			<div className="w-full max-w-sm min-w-0 px-1">
				<div className="flex justify-center items-center flex-col">
					<img src="/logo-light-v2.png" className="w-8 h-8 dark:hidden" />
					<img src="/logo-dark-v2.png" className="hidden w-8 h-8 dark:block" />
				</div>

				<SignupForm defaultEmail={email} redirectTo={redirect} />
			</div>
		</div>
	);
}
