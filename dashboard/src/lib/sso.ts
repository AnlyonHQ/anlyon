import { authClient } from "./auth-client";

export async function startSsoSignIn(
	email: string,
	redirectPath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const origin = window.location.origin;
	const result = await authClient.$fetch<{ url?: string }>("/sign-in/sso", {
		method: "POST",
		body: {
			email,
			callbackURL: `${origin}${redirectPath}`,
			errorCallbackURL: `${origin}/auth/login?sso=failed`,
		},
	});
	const url = result.data?.url;
	if (url) {
		window.location.assign(url);
		return { ok: true };
	}
	const status = result.error?.status;
	return {
		ok: false,
		message:
			status === 404
				? "No single sign-on is set up for this email domain. Sign in another way, or ask your workspace admin."
				: status === 401
					? "Single sign-on for this domain is not active yet. Ask your workspace admin to verify the domain."
					: result.error?.message ||
						"Single sign-on could not start. Try again.",
	};
}

export function redirectToSsoSignIn(): void {
	const { pathname, search } = window.location;
	if (pathname.startsWith("/auth/")) return;
	const redirect = encodeURIComponent(`${pathname}${search}`);
	window.location.assign(`/auth/login?sso=required&redirect=${redirect}`);
}
