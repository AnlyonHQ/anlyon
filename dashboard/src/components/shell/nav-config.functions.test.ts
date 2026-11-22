import { describe, expect, it, vi } from "vitest";

vi.mock("@anlyon/feature-flags", async (importOriginal) => ({
	...(await importOriginal<typeof import("@anlyon/feature-flags")>()),
	isFeatureEnabled: () => true,
}));

import { areaPages, locate, navAreas } from "./nav-config";

describe("Functions in the nav, on a deployment that has a runner", () => {
	it("sits in Agents & actions, after Actions", () => {
		const build = navAreas({ functions: true }).find(
			(area) => area.id === "build",
		);
		expect(build?.label).toBe("Agents & actions");
		const titles = build ? areaPages(build).map((page) => page.title) : [];
		expect(titles.slice(0, 2)).toEqual(["Actions", "Functions"]);
	});

	it("claims a function and a run for the Functions page", () => {
		const areas = navAreas({ functions: true });
		expect(locate(areas, "/functions/refund")?.page.title).toBe("Functions");
		expect(locate(areas, "/functions/runs/frn_1")).toMatchObject({
			page: { title: "Functions" },
			rest: "runs/frn_1",
		});
	});

	it("is not in the nav where the API serves no functions", () => {
		const build = navAreas().find((area) => area.id === "build");
		const titles = build ? areaPages(build).map((page) => page.title) : [];
		expect(titles).not.toContain("Functions");
	});
});
