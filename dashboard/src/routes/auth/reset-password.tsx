import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { AppLogo } from "@/components/logo/app-logo";

const searchSchema = z.object({
	token: z.string().optional(),
	error: z.string().optional(),
});

export const Route = createFileRoute("/auth/reset-password")({
	validateSearch: searchSchema,
	component: ResetPasswordPage,
});

function ResetPasswordPage() {
	const { token, error } = Route.useSearch();

	return (
		<div className="flex min-h-svh w-full min-w-0 flex-col items-center justify-center overflow-x-hidden bg-background p-4 sm:p-6 md:p-10">
			<div className="w-full max-w-sm min-w-0 px-1">
				<a
					href="#"
					className="group flex flex-col items-center justify-center gap-2 mb-8"
				>
					<div className="">
						<AppLogo size={32} />
					</div>
				</a>

				<ResetPasswordForm token={token} error={error} />
			</div>
		</div>
	);
}
