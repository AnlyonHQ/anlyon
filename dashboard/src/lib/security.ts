const ALLOWED_REDIRECT_PATHS = [
	"/",
	"/dashboard",
	"/auth/login",
	"/auth/signup",
	"/auth/verify-email",
	"/workspaces/new",
	"/workspaces/setup",
	"/workspaces/select",
	"/analytics",
	"/billing",
	"/settings",
	"/team",
	"/dlq",
	"/usage",
] as const;

export function isValidRedirectUrl(url: string): boolean {
	try {
		if (url.includes("://") || url.startsWith("//")) {
			return false;
		}

		const path = url.split("?")[0].split("#")[0];

		return ALLOWED_REDIRECT_PATHS.some((allowedPath) => {
			if (path === allowedPath) return true;
			if (path.startsWith(`${allowedPath}/`)) return true;
			return false;
		});
	} catch {
		return false;
	}
}

export function safeReturnPath(
	value: string | null | undefined,
	origin: string = window.location.origin,
): string | null {
	if (!value || value.includes("\\")) return null;
	if (!value.startsWith("/") && !value.startsWith(`${origin}/`)) return null;
	if (value.startsWith("//")) return null;
	try {
		const url = new URL(value, origin);
		if (url.origin !== origin) return null;
		if (url.pathname.startsWith("//")) return null;
		return `${url.pathname}${url.search}`;
	} catch {
		return null;
	}
}

export function safeRedirect(
	url: string,
	fallback: string = "/dashboard",
): void {
	const safeUrl = isValidRedirectUrl(url) ? url : fallback;
	window.location.href = safeUrl;
}

export function sanitizeString(input: string): string {
	return input
		.replace(/[<>]/g, "")
		.replace(/javascript:/gi, "")
		.replace(/on\w+=/gi, "");
}

export function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}
