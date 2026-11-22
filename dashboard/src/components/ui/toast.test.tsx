/* @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { ToastProvider, toast } from "@/components/ui/toast";

describe("toast", () => {
	it("renders a success toast through the mounted provider", async () => {
		render(<ToastProvider position="top-right" />);

		toast.success("Policy created");

		await waitFor(() =>
			expect(screen.getByText("Policy created")).toBeTruthy(),
		);
	});

	it("renders an error toast with its description", async () => {
		render(<ToastProvider position="top-right" />);

		toast.error("Could not create policy", {
			description: 'A policy named "Require two approvers" already exists.',
		});

		await waitFor(() =>
			expect(screen.getByText("Could not create policy")).toBeTruthy(),
		);
		expect(
			screen.getByText(
				'A policy named "Require two approvers" already exists.',
			),
		).toBeTruthy();
	});

	it.each([
		[
			"sheet",
			() => (
				<Sheet open>
					<SheetPopup>
						<SheetTitle>Create approval policy</SheetTitle>
					</SheetPopup>
				</Sheet>
			),
		],
		[
			"dialog",
			() => (
				<Dialog open>
					<DialogPopup>
						<DialogTitle>Confirm</DialogTitle>
					</DialogPopup>
				</Dialog>
			),
		],
	])("stacks toasts above an open %s", async (kind, Overlay) => {
		render(
			<ToastProvider position="top-right">
				<Overlay />
			</ToastProvider>,
		);

		toast.error("A policy with that name already exists.");
		await waitFor(() =>
			expect(
				screen.getByText("A policy with that name already exists."),
			).toBeTruthy(),
		);

		const layer = (slot: string) => {
			const element = document.querySelector(`[data-slot="${slot}"]`);
			expect(element, slot).not.toBeNull();
			const match = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(element?.className ?? "");
			expect(match, `${slot} sets a z-index`).not.toBeNull();
			return Number(match?.[1]);
		};
		const toastLayer = layer("toast-viewport");
		for (const slot of [`${kind}-backdrop`, `${kind}-viewport`]) {
			expect(toastLayer).toBeGreaterThan(layer(slot));
		}
	});
});
