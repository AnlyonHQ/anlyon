import { describe, expect, it } from "vitest";
import { Route } from "./analytics";

const validateSearch = Route.options.validateSearch as (
	search: Record<string, unknown>,
) => { tab?: string; range?: string; environmentId?: string };

describe("analytics search params", () => {
	it("accepts the three tabs the page offers", () => {
		for (const tab of ["overview", "agents", "trust-control"]) {
			expect(validateSearch({ tab }).tab).toBe(tab);
		}
	});

	it("drops ?tab=delivery, so the page opens on the overview", () => {
		expect(validateSearch({ tab: "delivery" }).tab).toBeUndefined();
		expect(validateSearch({ tab: "Delivery" }).tab).toBeUndefined();
	});

	it("keeps the range and environment filters", () => {
		expect(
			validateSearch({ tab: "delivery", range: "7d", environmentId: "env-1" }),
		).toEqual({ tab: undefined, range: "7d", environmentId: "env-1" });
	});
});
