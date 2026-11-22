import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { notifySignOut } from "@/lib/extensions";
import { secureLogger } from "@/lib/logger";

export function useAuth() {
	const {
		data: session,
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey: ["auth", "session"],
		queryFn: async () => {
			try {
				const session = await authClient.getSession();
				return session;
			} catch (error) {
				secureLogger.error("Session fetch error:", error);
				return null;
			}
		},
		retry: false,
		staleTime: 5 * 60 * 1000,
	});

	const isAuthenticated = !!session?.data?.user;

	const logout = async () => {
		try {
			await authClient.signOut();
			notifySignOut();
			refetch();
			window.location.href = "/auth/login";
		} catch (error) {
			secureLogger.error("Logout error:", error);
			window.location.href = "/auth/login";
		}
	};

	return {
		session: session?.data,
		user: session?.data?.user,
		isAuthenticated,
		isLoading,
		error,
		logout,
		refetch,
	};
}
