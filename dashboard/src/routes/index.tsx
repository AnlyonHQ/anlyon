import { createFileRoute, isRedirect, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		let signedIn = false;
		try {
			const session = await authClient.getSession();
			signedIn = !!session?.data?.user;
		} catch (error) {
			if (isRedirect(error)) throw error;
		}
		throw redirect({ to: signedIn ? "/dashboard" : "/auth/login" });
	},
});
