/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
	afterEach(cleanup);

	it("toggles without letting its absolute indicator escape the checkbox", () => {
		render(<Checkbox aria-label="Select row" />);
		const checkbox = screen.getByRole("checkbox");

		expect(checkbox.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(checkbox);
		expect(checkbox.getAttribute("aria-checked")).toBe("true");

		expect(checkbox.classList.contains("relative")).toBe(true);
	});
});
