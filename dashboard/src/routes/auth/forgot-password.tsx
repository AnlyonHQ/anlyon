import { createFileRoute } from "@tanstack/react-router";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { AppLogo } from "@/components/logo/app-logo";

export const Route = createFileRoute("/auth/forgot-password")({
	component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
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

				<ForgotPasswordForm />
			</div>
		</div>
	);
}
