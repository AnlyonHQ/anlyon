import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppLogo } from "@/components/logo/app-logo";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

export function OAuthShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-svh w-full flex-col items-center justify-center bg-slate-200/30 p-4 dark:bg-background sm:p-6 md:p-10">
			<div className="w-full max-w-md">
				<div className="mb-8 flex flex-col items-center justify-center gap-2">
					<AppLogo size={32} />
				</div>
				<Card>{children}</Card>
			</div>
		</div>
	);
}

export function NothingToAuthorize({ detail }: { detail?: string }) {
	return (
		<OAuthShell>
			<CardHeader>
				<CardTitle>Nothing to authorize</CardTitle>
				<CardDescription>
					{detail ??
						"Start from the app you are connecting  it sends the request this page needs."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Link to="/" className="text-sm underline underline-offset-4">
					Go to your dashboard
				</Link>
			</CardContent>
		</OAuthShell>
	);
}
