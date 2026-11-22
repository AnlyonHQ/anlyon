import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extensionPages,
	findExtensionPage,
	getExtensions,
	notifySignOut,
	planActionComponent,
	registerExtension,
	resetExtensions,
	startExtensions,
} from "./extensions";

afterEach(() => {
	resetExtensions();
});

describe("console extensions", () => {
	it("starts as the core alone", () => {
		expect(getExtensions()).toEqual([]);
		expect(extensionPages()).toEqual([]);
		expect(findExtensionPage("/settings/plan")).toBeUndefined();
		expect(planActionComponent()).toBeUndefined();
		expect(() => {
			startExtensions();
			notifySignOut();
		}).not.toThrow();
	});

	it("registers an extension once, in order", () => {
		const first = { id: "first" };
		const second = { id: "second" };
		registerExtension(first);
		registerExtension(second);
		registerExtension({ id: "first" });
		expect(getExtensions()).toEqual([first, second]);
	});

	it("finds a page by its path, with or without a trailing slash", () => {
		const page = { path: "/settings/plan" };
		registerExtension({ id: "fixture", pages: [page] });
		expect(findExtensionPage("/settings/plan")).toBe(page);
		expect(findExtensionPage("/settings/plan/")).toBe(page);
		expect(findExtensionPage("/settings/plans")).toBeUndefined();
	});

	it("starts every extension, and signs out of every one even when one fails", () => {
		const start = vi.fn();
		const signOut = vi.fn();
		registerExtension({
			id: "broken",
			onSignOut: () => {
				throw new Error("boom");
			},
		});
		registerExtension({ id: "fixture", start, onSignOut: signOut });
		startExtensions();
		expect(start).toHaveBeenCalledTimes(1);
		expect(() => notifySignOut()).not.toThrow();
		expect(signOut).toHaveBeenCalledTimes(1);
	});
});
