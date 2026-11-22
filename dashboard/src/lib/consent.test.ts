import { describe, expect, it, vi } from "vitest";
import { ConsentError, runConsent } from "./consent";
import type { ConnectSession, ConnectSessionCompletion, Secret } from "./types";

const session = {
	sessionId: "csn_x",
	sessionToken: "tok",
	expiresAt: "2999-01-01T00:00:00.000Z",
	connectUrl:
		"https://api.anlyon.test/api/v2/connection-consent/start?token=tok",
} as ConnectSession;

const secret = { id: "sec_1", name: "HUBSPOT" } as Secret;
const pending: ConnectSessionCompletion = { status: "pending", secret: null };
const completed: ConnectSessionCompletion = { status: "completed", secret };

function opener(
	popup: { closed: boolean; close: () => void } | null = {
		closed: false,
		close: vi.fn(),
	},
) {
	const open = vi.fn(() => popup);
	return { open, factory: () => ({ open }) };
}

describe("runConsent", () => {
	it("opens the session's connect URL and polls until Anlyon has recorded the account", async () => {
		const { open, factory } = opener();
		const poll = vi
			.fn<() => Promise<ConnectSessionCompletion>>()
			.mockResolvedValueOnce(pending)
			.mockResolvedValueOnce(pending)
			.mockResolvedValueOnce(completed);
		const result = await runConsent(session, factory, { poll, intervalMs: 1 });
		expect(open).toHaveBeenCalledWith(session.connectUrl);
		expect(poll).toHaveBeenCalledTimes(3);
		expect(result).toEqual({ secret });
	});

	it("a blocked window is popup_blocked, and nothing is polled", async () => {
		const poll = vi.fn();
		await expect(
			runConsent(session, opener(null).factory, { poll, intervalMs: 1 }),
		).rejects.toEqual(new ConsentError("popup_blocked"));
		expect(poll).not.toHaveBeenCalled();
	});

	it("keeps waiting while the window reads closed: a provider page can sever the opener", async () => {
		const poll = vi
			.fn<() => Promise<ConnectSessionCompletion>>()
			.mockResolvedValueOnce(pending)
			.mockResolvedValueOnce(completed);
		const result = await runConsent(
			session,
			opener({ closed: true, close: vi.fn() }).factory,
			{ poll, intervalMs: 1 },
		);
		expect(result).toEqual({ secret });
	});

	it("stops at the session's expiry", async () => {
		const poll = vi.fn(async () => pending);
		await expect(
			runConsent(
				{ ...session, expiresAt: "2000-01-01T00:00:00.000Z" },
				opener().factory,
				{ poll, intervalMs: 1 },
			),
		).rejects.toEqual(new ConsentError("expired"));
	});

	it("stops when aborted, and closes the window", async () => {
		const close = vi.fn();
		const controller = new AbortController();
		const poll = vi.fn(async () => {
			controller.abort();
			return pending;
		});
		await expect(
			runConsent(session, opener({ closed: false, close }).factory, {
				poll,
				intervalMs: 1,
				signal: controller.signal,
			}),
		).rejects.toEqual(new ConsentError("cancelled"));
		expect(close).toHaveBeenCalled();
	});

	it("passes the API's own errors through", async () => {
		const error = new Error("declined");
		await expect(
			runConsent(session, opener().factory, {
				poll: async () => Promise.reject(error),
				intervalMs: 1,
			}),
		).rejects.toBe(error);
	});
});
