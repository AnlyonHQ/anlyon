/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ALL_SCOPES,
	READ_ONLY_SCOPES,
	SCOPE_GROUPS,
	STANDARD_SCOPES,
} from "@/lib/api-key-scopes";
import { CreateApiKeyDialog } from "./create-api-key-dialog";

function renderDialog(endUserRequired = false) {
	const onEndUserRequiredChange = vi.fn();
	const onScopesChange = vi.fn();
	render(
		<CreateApiKeyDialog
			apiKeyName="App server"
			endUserRequired={endUserRequired}
			isPending={false}
			onApiKeyNameChange={vi.fn()}
			onEndUserRequiredChange={onEndUserRequiredChange}
			onOpenChange={vi.fn()}
			onScopesChange={onScopesChange}
			onSubmit={vi.fn()}
			open
			selectedScopes={[...STANDARD_SCOPES]}
		/>,
	);
	return { onEndUserRequiredChange, onScopesChange };
}

describe("Require a user", () => {
	it("is off by default, explained in one line, and turns on", () => {
		const { onEndUserRequiredChange } = renderDialog();
		const toggle = screen.getByRole("switch", { name: "Require a user" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(
			screen.getByText(/must name the user it acts for/).textContent,
		).toContain("never uses your workspace's own connections");
		fireEvent.click(toggle);
		expect(onEndUserRequiredChange).toHaveBeenCalledWith(true);
	});
});

describe("End-user scopes", () => {
	it("offers the three end-user scopes as one group in the picker", () => {
		const group = SCOPE_GROUPS.find((entry) => entry.resource === "end-users");
		expect(group?.scopes).toEqual([
			"end-users:read",
			"end-users:write",
			"end-users:approvals",
		]);
		renderDialog();
		const groupBox = screen.getByRole("checkbox", { name: "users" });
		const box = groupBox.closest("label")?.parentElement as HTMLElement;
		const names = [...box.querySelectorAll("label")].map((label) =>
			label.textContent?.trim(),
		);
		expect(names).toEqual(["users", "read", "write", "approvals"]);
	});

	it("is privileged: never in the Standard preset, added on purpose", () => {
		for (const scope of [
			"end-users:read",
			"end-users:write",
			"end-users:approvals",
		]) {
			expect(ALL_SCOPES).toContain(scope);
			expect(STANDARD_SCOPES).not.toContain(scope);
		}
		expect(READ_ONLY_SCOPES).toContain("end-users:read");
		expect(READ_ONLY_SCOPES).not.toContain("end-users:write");
	});
});
