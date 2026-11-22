/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceSetting } from "@/hooks/api/use-instance";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	sendTest: vi.fn(),
	testResult: undefined as unknown,
}));

vi.mock("@/hooks/api/use-instance", () => ({
	useUpdateInstanceSettings: () => ({ mutate: mocks.update, isPending: false }),
	useSendTestEmail: () => ({
		mutate: mocks.sendTest,
		isPending: false,
		data: mocks.testResult,
	}),
	useTestStorage: () => ({ mutate: vi.fn(), isPending: false }),
	usePreviewLicense: () => ({ mutate: vi.fn(), isPending: false }),
	useTelemetryPreview: () => ({ data: undefined }),
	useInstanceAdmins: () => ({ data: [] }),
	useGrantInstanceAdmin: () => ({ mutate: vi.fn(), isPending: false }),
	useRevokeInstanceAdmin: () => ({ mutate: vi.fn(), isPending: false }),
	useConfirmRootKeyBackup: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { EmailTest, SettingField, SettingGroupForm } from "./instance-settings";

function setting(patch: Partial<InstanceSetting>): InstanceSetting {
	return {
		key: "email.from",
		group: "email",
		label: "Sender address",
		description: "The address email is sent from.",
		secret: false,
		value: null,
		set: false,
		source: "unset",
		env: "FROM_EMAIL",
		default: null,
		updatedAt: null,
		updatedBy: null,
		...patch,
	};
}

describe("SettingField", () => {
	beforeEach(() => {
		mocks.update.mockReset();
		mocks.sendTest.mockReset();
		mocks.testResult = undefined;
	});

	it("shows a value the environment sets read-only, with its variable", () => {
		render(
			<SettingField
				draft={undefined}
				onChange={vi.fn()}
				setting={setting({
					value: "ops@acme.example",
					set: true,
					source: "environment",
				})}
			/>,
		);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.getByText("FROM_EMAIL")).toBeTruthy();
		expect(screen.getByText("= ops@acme.example")).toBeTruthy();
		expect(screen.getByText(/Change FROM_EMAIL there/)).toBeTruthy();
	});

	it("shows a saved secret as set, with Replace and Clear, never its value", () => {
		const onChange = vi.fn();
		render(
			<SettingField
				draft={undefined}
				onChange={onChange}
				setting={setting({
					key: "email.smtp_url",
					label: "SMTP server",
					secret: true,
					value: undefined,
					set: true,
					source: "database",
					updatedAt: "2026-10-19T16:40:00.000Z",
				})}
			/>,
		);
		expect(screen.getByText("Set")).toBeTruthy();
		expect(screen.queryByLabelText("SMTP server")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Replace SMTP server" }),
		);
		const input = screen.getByLabelText("SMTP server") as HTMLInputElement;
		expect(input.type).toBe("password");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Clear SMTP server" }));
		expect(onChange).toHaveBeenLastCalledWith(null);
	});
});

describe("SettingGroupForm", () => {
	const settings = [
		setting({ key: "email.smtp_url", label: "SMTP server", secret: true }),
		setting({}),
	];

	it("saves only what changed, and blocks a value the server would refuse", () => {
		render(
			<SettingGroupForm group="email" settings={settings}>
				{(unsaved) => (
					<EmailTest defaultTo="sam@example.com" unsaved={unsaved} />
				)}
			</SettingGroupForm>,
		);
		const save = screen.getByRole("button", {
			name: "Save",
		}) as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Sender address"), {
			target: { value: "ops@" },
		});
		expect(screen.getByText("Not an email address")).toBeTruthy();
		expect(save.disabled).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Send test email",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(screen.getByText(/Save your changes first/)).toBeTruthy();

		fireEvent.change(screen.getByLabelText("Sender address"), {
			target: { value: "ops@acme.example" },
		});
		expect(save.disabled).toBe(false);
		fireEvent.click(save);
		expect(mocks.update).toHaveBeenCalledWith(
			{ "email.from": "ops@acme.example" },
			expect.anything(),
		);
	});

	it("typing back the saved value leaves nothing unsaved", () => {
		render(
			<SettingGroupForm
				group="email"
				settings={[setting({ value: "a@b.co", set: true, source: "database" })]}
			/>,
		);
		const input = screen.getByLabelText("Sender address");
		fireEvent.change(input, { target: { value: "c@d.co" } });
		expect(screen.getByText("Edited")).toBeTruthy();
		fireEvent.change(input, { target: { value: "a@b.co" } });
		expect(screen.queryByText("Edited")).toBeNull();
	});
});

describe("EmailTest", () => {
	it("announces the result of the last test", () => {
		mocks.testResult = {
			ok: false,
			message: "The mail server refused it: 535",
		};
		render(<EmailTest defaultTo="sam@example.com" />);
		expect(screen.getByRole("status").textContent).toContain("535");
		fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
		expect(mocks.sendTest).toHaveBeenCalledWith("sam@example.com");
	});
});
