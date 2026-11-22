import { describe, expect, it } from "vitest";
import {
	callNeeds,
	connectNeeds,
	START_SNIPPETS,
	startProgress,
	startSteps,
} from "./start-here";

describe("startSteps", () => {
	it("is three unknown steps while nothing has loaded", () => {
		const steps = startSteps({});
		expect(steps.map((s) => s.id)).toEqual(["key", "connect", "call"]);
		expect(steps.every((s) => s.done === undefined)).toBe(true);
		expect(startProgress(steps)).toMatchObject({
			done: 0,
			total: 3,
			complete: false,
			next: null,
			loading: true,
		});
	});

	it("points at the key in a brand-new workspace", () => {
		const progress = startProgress(
			startSteps({ apiKeys: 0, connectedUsers: 0, usersWithCalls: 0 }),
		);
		expect(progress).toMatchObject({ done: 0, next: "key", loading: false });
	});

	it("ticks each step from what the server holds", () => {
		const half = startProgress(
			startSteps({ apiKeys: 2, connectedUsers: 1, usersWithCalls: 0 }),
		);
		expect(half).toMatchObject({ done: 2, next: "call", complete: false });
		const all = startProgress(
			startSteps({ apiKeys: 1, connectedUsers: 3, usersWithCalls: 1 }),
		);
		expect(all).toMatchObject({ done: 3, next: null, complete: true });
	});

	it("does not wait on a step it cannot read yet to point at an earlier one", () => {
		const progress = startProgress(
			startSteps({ apiKeys: 0, connectedUsers: undefined }),
		);
		expect(progress.next).toBe("key");
		expect(progress.loading).toBe(true);
	});
});

describe("what the open step asks for", () => {
	it("asks for a redirect URL before the connect code", () => {
		expect(connectNeeds({ redirectUrlSet: false })).toBe("redirect");
		expect(connectNeeds({ redirectUrlSet: true })).toBe("code");
		expect(connectNeeds({})).toBe("code");
	});

	it("asks for an action before the call code", () => {
		expect(callNeeds({ actions: 0 })).toBe("action");
		expect(callNeeds({ actions: 4 })).toBe("code");
		expect(callNeeds({})).toBe("code");
	});

	it("names the user from your server in every snippet, never from the model", () => {
		expect(START_SNIPPETS.key).toContain("process.env.ANLYON_API_KEY");
		expect(START_SNIPPETS.connect).toContain("createConnectLink");
		expect(START_SNIPPETS.connect).toContain("connections.confirm");
		expect(START_SNIPPETS.call("hubspot-update-deal")).toContain(
			"anlyon.forUser(user.id)",
		);
		expect(START_SNIPPETS.call("hubspot-update-deal")).toContain(
			"invoke('hubspot-update-deal', input)",
		);
	});
});
