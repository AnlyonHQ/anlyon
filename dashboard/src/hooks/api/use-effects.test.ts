import { describe, expect, it } from "vitest";
import {
	effectKeys,
	effectListParams,
	impactLimitKeys,
	withEnvironment,
} from "./use-effects";

describe("governed-effect query keys", () => {
	it("scope every key to workspace and environment", () => {
		expect(effectKeys.list("ws", "env_a", { unresolved: true })).not.toEqual(
			effectKeys.list("ws", "env_b", { unresolved: true }),
		);
		expect(effectKeys.detail("ws", "env_a", "eff_1").slice(0, 3)).toEqual(
			effectKeys.scope("ws", "env_a"),
		);
		expect(impactLimitKeys.list("ws", undefined)[2]).toBe("default");
	});

	it("filters by receipt grade on the server, under a key that includes the grade", () => {
		expect(effectKeys.list("ws", "env_a", { grade: "unknown" })).not.toEqual(
			effectKeys.list("ws", "env_a", { grade: "confirmed" }),
		);
		expect(effectKeys.list("ws", "env_a", { grade: "unknown" })).not.toEqual(
			effectKeys.list("ws", "env_a"),
		);
		expect(effectListParams("env_a", { grade: "unknown" })).toMatchObject({
			environmentId: "env_a",
			grade: "unknown",
			offset: 0,
		});
		expect(effectListParams("env_a").grade).toBeUndefined();
	});

	it("asks for one side, or one user, under a key that includes it", () => {
		expect(
			effectKeys.list("ws", "env_a", { actingFor: "workspace" }),
		).not.toEqual(effectKeys.list("ws", "env_a", { actingFor: "end_users" }));
		expect(
			effectKeys.list("ws", "env_a", { endUserId: "user_42" }),
		).not.toEqual(effectKeys.list("ws", "env_a"));
		expect(
			effectListParams("env_a", {
				actingFor: "end_users",
				endUserId: "user_42",
			}),
		).toMatchObject({ actingFor: "end_users", endUserId: "user_42" });
		expect(effectListParams("env_a").actingFor).toBeUndefined();
	});

	it("puts the environment on mutation paths, so writes are scoped like reads", () => {
		expect(withEnvironment("/actions/effects/eff_1/resolve", "env a")).toBe(
			"/actions/effects/eff_1/resolve?environmentId=env%20a",
		);
		expect(withEnvironment("/impact-limits", undefined)).toBe("/impact-limits");
	});
});
