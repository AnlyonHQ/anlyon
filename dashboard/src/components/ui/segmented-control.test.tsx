/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentedControl } from "./segmented-control";

afterEach(cleanup);

const options = [
	{ value: 0, label: "Routine" },
	{ value: 1, label: "Low" },
	{ value: 2, label: "Moderate" },
] as const;

function Harness({ initial = 1 }: { initial?: number }) {
	const [value, setValue] = useState<number>(initial);
	return (
		<SegmentedControl
			label="Risk ceiling"
			onChange={setValue}
			options={options}
			value={value}
		/>
	);
}

const checked = () =>
	screen
		.getAllByRole("radio")
		.find((r) => r.getAttribute("aria-checked") === "true");

describe("SegmentedControl", () => {
	it("is one tab stop, on the checked segment", () => {
		render(<Harness />);
		expect(
			screen.getByRole("radiogroup", { name: "Risk ceiling" }),
		).toBeTruthy();
		const stops = screen
			.getAllByRole("radio")
			.filter((r) => r.getAttribute("tabindex") === "0");
		expect(stops).toEqual([screen.getByRole("radio", { name: "Low" })]);
	});

	it("moves and selects with the arrow keys, wrapping at the ends", () => {
		render(<Harness />);
		fireEvent.keyDown(screen.getByRole("radio", { name: "Low" }), {
			key: "ArrowRight",
		});
		expect(checked()?.textContent).toBe("Moderate");
		expect(document.activeElement).toBe(checked());
		fireEvent.keyDown(checked() as Element, { key: "ArrowDown" });
		expect(checked()?.textContent).toBe("Routine");
		fireEvent.keyDown(checked() as Element, { key: "ArrowLeft" });
		expect(checked()?.textContent).toBe("Moderate");
	});

	it("jumps to the ends with Home and End", () => {
		render(<Harness />);
		fireEvent.keyDown(screen.getByRole("radio", { name: "Low" }), {
			key: "End",
		});
		expect(checked()?.textContent).toBe("Moderate");
		fireEvent.keyDown(checked() as Element, { key: "Home" });
		expect(checked()?.textContent).toBe("Routine");
	});
});
