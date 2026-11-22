import { describe, expect, it } from "vitest";
import { requireFeature } from "./feature-flags";

describe("requireFeature", () => {
	it("blocks the route of an unavailable feature", () => {
		expect(() => requireFeature("mcp-events")).toThrow();
	});

	it("lets the Functions pages through the build gate; the deployment decides the rest", () => {
		expect(() => requireFeature("functions")).not.toThrow();
	});

	it("lets a reachable feature through", () => {
		expect(() => requireFeature("agents")).not.toThrow();
	});
});
