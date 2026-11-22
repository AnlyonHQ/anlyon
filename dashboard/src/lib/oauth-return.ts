import { useEffect, useState } from "react";
import { API_BASE_URL } from "./constants";

export interface AuthorizeRequest {
	query: string;
	clientId: string;
	expired: boolean;
}

export interface FirstPartyClient {
	displayName: string;
	startUrl: string;
}

export function parseAuthorizeRequest(
	search: string,
	now = Date.now(),
): AuthorizeRequest | null {
	const query = search.replace(/^\?/, "");
	if (!query) return null;
	const params = new URLSearchParams(query);
	const clientId = params.get("client_id");
	const exp = Number(params.get("exp"));
	if (!clientId || !params.get("sig") || !Number.isFinite(exp) || exp <= 0)
		return null;
	return { query, clientId, expired: exp * 1000 <= now };
}

export type VerifiedDestination =
	| { kind: "first-party"; url: string; displayName: string }
	| { kind: "authorize"; to: string }
	| { kind: "login"; returnTo?: string };

export function verifiedDestination(
	request: AuthorizeRequest | null,
	firstParty: FirstPartyClient | null,
	returnTo?: string | null,
): VerifiedDestination {
	if (firstParty && isSafeStartUrl(firstParty.startUrl)) {
		return {
			kind: "first-party",
			url: firstParty.startUrl,
			displayName: firstParty.displayName,
		};
	}
	if (request && !request.expired) {
		return { kind: "authorize", to: `/auth/login?${request.query}` };
	}
	return returnTo ? { kind: "login", returnTo } : { kind: "login" };
}

export function isSafeStartUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return true;
		return (
			url.protocol === "http:" &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1")
		);
	} catch {
		return false;
	}
}

export async function fetchFirstPartyClient(
	clientId: string,
): Promise<FirstPartyClient | null> {
	try {
		const response = await fetch(
			`${API_BASE_URL}/api/oauth/first-party-client?client_id=${encodeURIComponent(clientId)}`,
		);
		if (!response.ok) return null;
		return ((await response.json()) as { data: FirstPartyClient }).data;
	} catch {
		return null;
	}
}

export function useAuthorizeRequest(): {
	request: AuthorizeRequest | null;
	firstParty: FirstPartyClient | null;
} {
	const [request] = useState(() =>
		typeof window === "undefined"
			? null
			: parseAuthorizeRequest(window.location.search),
	);
	const [firstParty, setFirstParty] = useState<FirstPartyClient | null>(null);

	useEffect(() => {
		if (!request) return;
		if (request.expired) {
			window.history.replaceState(null, "", window.location.pathname);
		}
		let cancelled = false;
		void fetchFirstPartyClient(request.clientId).then((client) => {
			if (!cancelled) setFirstParty(client);
		});
		return () => {
			cancelled = true;
		};
	}, [request]);

	return { request, firstParty };
}

export function withAuthorizeRequest(
	path: string,
	request: AuthorizeRequest | null,
	returnTo?: string,
): string {
	if (request && !request.expired) return `${path}?${request.query}`;
	return returnTo ? `${path}?redirect=${encodeURIComponent(returnTo)}` : path;
}
