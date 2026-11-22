/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	Dialog,
	DialogFooter,
	DialogForm,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "./dialog";

afterEach(cleanup);

const FLEX_COLUMN = ["flex", "min-h-0", "flex-1", "flex-col"];

describe("a form inside a dialog", () => {
	it("DialogForm is a shrinkable flex column, and Enter submits it", () => {
		const onSubmit = vi.fn((event: { preventDefault: () => void }) =>
			event.preventDefault(),
		);
		render(
			<Dialog open>
				<DialogPopup>
					<DialogForm onSubmit={onSubmit}>
						<DialogHeader>
							<DialogTitle>Add a sink</DialogTitle>
						</DialogHeader>
						<DialogPanel>
							<input aria-label="Name" />
						</DialogPanel>
						<DialogFooter>
							<button type="submit">Add sink</button>
						</DialogFooter>
					</DialogForm>
				</DialogPopup>
			</Dialog>,
		);
		const form = screen.getByRole("dialog").querySelector("form");
		expect(form).not.toBeNull();
		for (const name of FLEX_COLUMN) expect(form?.classList).toContain(name);
		expect(form?.getAttribute("data-slot")).toBe("dialog-form");

		const popup = document.querySelector("[data-slot=dialog-popup]");
		expect(
			popup?.contains(screen.getByText("Add sink", { selector: "button" })),
		).toBe(true);

		fireEvent.submit(form as HTMLFormElement);
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("DialogPopup makes a plain <form> child a shrinkable flex column too", () => {
		render(
			<Dialog open>
				<DialogPopup>
					<form>
						<DialogPanel>content</DialogPanel>
					</form>
				</DialogPopup>
			</Dialog>,
		);
		const popup = document.querySelector("[data-slot=dialog-popup]");
		for (const name of FLEX_COLUMN) {
			expect(popup?.className).toContain(`[&>form]:${name}`);
		}
	});
});
