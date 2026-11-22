import { createFileRoute, Link } from "@tanstack/react-router";
import { SetupWizard } from "@/components/instance/setup-wizard";
import { isSelfHosted } from "@/lib/runtime-config";

export const Route = createFileRoute("/setup")({
	component: SetupPage,
});

function SetupPage() {
	if (!isSelfHosted()) {
		return (
			<div className="flex min-h-svh items-center justify-center bg-background p-6">
				<p className="max-w-sm border bg-card p-6 text-[14px] text-card-foreground">
					There is nothing to set up here.{" "}
					<Link className="underline underline-offset-4" to="/auth/login">
						Sign in
					</Link>
					.
				</p>
			</div>
		);
	}
	return <SetupWizard />;
}
