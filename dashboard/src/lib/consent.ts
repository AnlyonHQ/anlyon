import type { ConnectSession, ConnectSessionCompletion, Secret } from "./types";

export type ConsentFailure = "popup_blocked" | "expired" | "cancelled";

export class ConsentError extends Error {
	constructor(readonly kind: ConsentFailure) {
		super(kind);
		this.name = "ConsentError";
	}
}

export interface ConsentWindow {
	closed: boolean;
	close(): void;
}

export interface ConsentClient {
	open(url: string): ConsentWindow | null;
	pollIntervalMs?: number;
}

export type ConsentClientFactory = (session: ConnectSession) => ConsentClient;

export const defaultConsentClient: ConsentClientFactory = () => ({
	open: (url) =>
		window.open(url, "anlyon-consent", "popup,width=520,height=720"),
});

export const CONSENT_POLL_INTERVAL_MS = 2000;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ConsentError("cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ConsentError("cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function runConsent(
	session: ConnectSession,
	factory: ConsentClientFactory = defaultConsentClient,
	options: {
		poll: () => Promise<ConnectSessionCompletion>;
		signal?: AbortSignal;
		intervalMs?: number;
		now?: () => number;
	},
): Promise<{ secret: Secret }> {
	const { poll, signal } = options;
	const client = factory(session);
	const intervalMs =
		options.intervalMs ?? client.pollIntervalMs ?? CONSENT_POLL_INTERVAL_MS;
	const now = options.now ?? Date.now;
	if (signal?.aborted) throw new ConsentError("cancelled");
	const popup = client.open(session.connectUrl);
	if (!popup) throw new ConsentError("popup_blocked");
	const expiresAt = Date.parse(session.expiresAt);
	try {
		for (;;) {
			await wait(intervalMs, signal);
			const result = await poll();
			if (signal?.aborted) throw new ConsentError("cancelled");
			if (result.status === "completed") return { secret: result.secret };
			if (Number.isFinite(expiresAt) && now() >= expiresAt)
				throw new ConsentError("expired");
		}
	} catch (error) {
		if (error instanceof ConsentError && error.kind === "cancelled") {
			try {
				popup.close();
			} catch {
			}
		}
		throw error;
	}
}
