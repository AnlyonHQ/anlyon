import { API_BASE_URL } from "./constants";

export function oauthQuery(): string {
	return window.location.search.replace(/^\?/, "");
}

export function errorMessage(
	cause: unknown,
	fallback = "Something went wrong.",
): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

interface ApiError {
	error?: { message?: string };
}

export async function oauthFetch<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		credentials: "include",
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
	});

	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as ApiError | null;
		throw new Error(
			body?.error?.message ?? `Request failed (${response.status}).`,
		);
	}

	return ((await response.json()) as { data: T }).data;
}

export function followRedirect(data: unknown): boolean {
	if (
		data &&
		typeof data === "object" &&
		"url" in data &&
		typeof (data as { url: unknown }).url === "string"
	) {
		window.location.href = (data as { url: string }).url;
		return true;
	}
	return false;
}
