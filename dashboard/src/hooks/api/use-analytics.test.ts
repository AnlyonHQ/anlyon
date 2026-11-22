import { describe, expect, it } from "vitest";
import { analyticsKeys } from "./use-analytics";

describe("analytics query keys", () => {
	it("separates workspaces, environments, ranges, and product tabs", () => {
		const baseQuery = {
			startDate: "2026-07-01T00:00:00.000Z",
			endDate: "2026-07-31T00:00:00.000Z",
			environmentId: "123e4567-e89b-42d3-a456-426614174000",
		} as const;

		expect(
			analyticsKeys.resource("overview", "workspace-a", baseQuery),
		).not.toEqual(analyticsKeys.resource("overview", "workspace-b", baseQuery));
		expect(
			analyticsKeys.resource("overview", "workspace-a", baseQuery),
		).not.toEqual(analyticsKeys.resource("agents", "workspace-a", baseQuery));
		expect(
			analyticsKeys.resource("overview", "workspace-a", baseQuery),
		).not.toEqual(
			analyticsKeys.resource("overview", "workspace-a", {
				...baseQuery,
				environmentId: undefined,
			}),
		);
	});
});
