/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActingFor, ActingForSwitch, parseActingFor } from "./acting-for";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		search,
		children,
		...rest
	}: {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, string | undefined>;
		children: React.ReactNode;
	}) => {
		const path = to.replace("$endUserId", params?.endUserId ?? "");
		const query = new URLSearchParams(
			Object.entries(search ?? {}).flatMap(([k, v]) =>
				v === undefined ? [] : [[k, v]],
			),
		).toString();
		return (
			<a href={query ? `${path}?${query}` : path} {...rest}>
				{children}
			</a>
		);
	},
}));

afterEach(cleanup);

describe("ActingFor", () => {
	it("says Workspace for a call with the workspace's own accounts", () => {
		render(<ActingFor endUserId={null} />);
		expect(screen.getByText("Workspace").tagName).toBe("SPAN");
	});

	it("links a user's id to their page, untranslated and whole on hover", () => {
		render(<ActingFor endUserId="user_42" environmentId="env-1" />);
		const link = screen.getByRole("link", { name: "user_42" });
		expect(link.getAttribute("href")).toBe(
			"/users/user_42?environmentId=env-1",
		);
		expect(link.getAttribute("translate")).toBe("no");
		expect(link.getAttribute("title")).toBe("User user_42");
		expect(link.className).toContain("font-mono");
		expect(link.className).toContain("truncate");
	});

	it("does not open the row under it", () => {
		const onRow = vi.fn();
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a stand-in for a clickable table row
			<div onClick={onRow}>
				<ActingFor endUserId="user_42" />
			</div>,
		);
		fireEvent.click(screen.getByRole("link", { name: "user_42" }));
		expect(onRow).not.toHaveBeenCalled();
	});

	it("is plain text inside something already clickable", () => {
		render(<ActingFor endUserId="user_42" link={false} />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("user_42").getAttribute("translate")).toBe("no");
	});

	it("never links an erased user", () => {
		render(<ActingFor endUserId="erased~3f9a" />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("Erased user")).toBeTruthy();
	});
});

describe("ActingForSwitch", () => {
	it("offers All, Your workspace and Your users, and clears the filter on All", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<ActingForSwitch onChange={onChange} value={undefined} />,
		);
		const group = screen.getByRole("radiogroup", { name: "Whose accounts" });
		expect(
			screen.getAllByRole("radio").map((radio) => radio.textContent),
		).toEqual(["All", "Your workspace", "Your users"]);
		expect(
			screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(screen.getByRole("radio", { name: "Your users" }));
		expect(onChange).toHaveBeenLastCalledWith("end_users");
		rerender(<ActingForSwitch onChange={onChange} value="workspace" />);
		expect(group).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "All" }));
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});

	it("reads only the two sides from the URL", () => {
		expect(parseActingFor("workspace")).toBe("workspace");
		expect(parseActingFor("end_users")).toBe("end_users");
		expect(parseActingFor("users")).toBeUndefined();
		expect(parseActingFor(undefined)).toBeUndefined();
	});
});
