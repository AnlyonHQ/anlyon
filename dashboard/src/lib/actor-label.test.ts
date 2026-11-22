import { describe, expect, it } from "vitest";
import { describeActor } from "./actor-label";

const users = new Map([
	["usr_1", { name: "Ada Lovelace", email: "ada@example.com" }],
	["usr_2", { name: null, email: "grace@example.com" }],
]);
const keys = new Map([["key_1", "support-agent"]]);
const loaded = { users, keys, currentUserId: "usr_1" };

describe("describeActor", () => {
	it("says so when nobody was recorded", () => {
		expect(describeActor(null).text).toBe("Not recorded");
		expect(describeActor({ type: "user", id: null }).text).toBe("Not recorded");
		expect(describeActor({ type: "unknown", id: "x" }).text).toBe(
			"Not recorded",
		);
	});

	it("names a member, marks the viewer, and keeps the id in the tooltip", () => {
		expect(describeActor({ type: "user", id: "usr_1" }, loaded)).toEqual({
			text: "Ada Lovelace (you)",
			title: "ada@example.com · usr_1",
		});
		expect(describeActor({ type: "user", id: "usr_2" }, loaded)).toEqual({
			text: "grace@example.com",
			title: "usr_2",
		});
	});

	it("names an API key", () => {
		expect(describeActor({ type: "api_key", id: "key_1" }, loaded)).toEqual({
			text: 'API key "support-agent"',
			title: "key_1",
		});
	});

	it("says a member left or a key is gone only when the list actually loaded", () => {
		expect(describeActor({ type: "user", id: "usr_gone" }, loaded).text).toBe(
			"Former member",
		);
		expect(
			describeActor({ type: "api_key", id: "key_gone" }, loaded).text,
		).toBe("Revoked or deleted API key");
		expect(
			describeActor({ type: "user", id: "8wqzrc2wmVJPRZ3oaV4UnEPZyYnU0RRw" }),
		).toEqual({
			text: "User 8wqzrc2w…",
			title: "8wqzrc2wmVJPRZ3oaV4UnEPZyYnU0RRw",
		});
		expect(describeActor({ type: "api_key", id: "key_ci" }).text).toBe(
			"API key key_ci",
		);
	});

	it("still recognises the viewer before the member list loads", () => {
		expect(
			describeActor({ type: "user", id: "usr_1" }, { currentUserId: "usr_1" })
				.text,
		).toBe("You");
	});
});
