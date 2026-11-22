import { redirect } from "@tanstack/react-router";
import { findExtensionPage } from "./extensions";

export function forwardExtensionPage(pathname: string): void {
	const target = findExtensionPage(pathname)?.redirectTo;
	if (target) throw redirect({ href: target, replace: true });
}

export type SearchValue = string | number | boolean | null;

export function passSearch(
	search: Record<string, unknown>,
): Record<string, SearchValue> {
	return search as Record<string, SearchValue>;
}
