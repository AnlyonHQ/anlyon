/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoutePending } from "@/components/layout/route-pending";

describe("RoutePending", () => {
	it("announces the wait without reading the brand name out as a message", () => {
		render(<RoutePending />);

		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.getByText("Loading")).toBeTruthy();
		expect(screen.queryByAltText("Anlyon")).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("uses the bundled loader copies, not the full-size brand assets", () => {
		const { container } = render(<RoutePending />);
		const sources = [...container.querySelectorAll("img")].map(
			(img) => img.getAttribute("src") ?? "",
		);

		expect(sources).toHaveLength(2);
		for (const src of sources) {
			expect(src).toContain("logo-loader");
			expect(src).not.toContain("-v2.png");
		}
	});
});
