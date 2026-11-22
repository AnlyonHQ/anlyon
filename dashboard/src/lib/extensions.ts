import { KNOWN_VENDORS, type KnownVendor } from "@anlyon/known-vendors";
import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { AreaId } from "@/components/shell/nav-config";
import type { Plan } from "@/lib/types";

export interface ConsoleExtension {
	id: string;
	edition?: "cloud";
	start?: () => void;
	onSignOut?: () => void;
	Session?: ComponentType;
	topBar?: ComponentType[];
	useBanners?: (context: BannerContext) => ExtensionBanners;
	pages?: ExtensionPage[];
	PlanAction?: ComponentType<PlanActionProps>;
	vendors?: readonly KnownVendor[];
}

export interface BannerContext {
	workspaceId: string | undefined;
	pathname: string;
	onHome: boolean;
	canManageBilling: boolean;
	quotaFeedbackShown: boolean;
}

export interface ExtensionBanners {
	quiet: boolean;
	node: ReactNode;
}

export interface ExtensionPage {
	path: string;
	component?: ComponentType;
	redirectTo?: string;
	nav?: {
		area: AreaId;
		group: string;
		title: string;
		icon: LucideIcon;
		at?: "start" | "end";
	};
	accountMenu?: string;
	hostedOnly?: boolean;
}

export type PlanActionSite =
	| "team-notice"
	| "team-notice-inline"
	| "team-notice-aside"
	| "allowance-banner"
	| "paid-usage-banner"
	| "quota-feedback"
	| "usage-summary"
	| "usage-alert"
	| "feature-unavailable"
	| "workspace-plan";

export interface PlanActionProps {
	site: PlanActionSite;
	canManageBilling?: boolean;
	code?: string;
	plan?: Plan;
	className?: string;
}

let registered: readonly ConsoleExtension[] = [];

export function registerExtension(extension: ConsoleExtension): void {
	if (registered.some((existing) => existing.id === extension.id)) return;
	registered = [...registered, extension];
}

export function resetExtensions(): void {
	registered = [];
}

export function getExtensions(): readonly ConsoleExtension[] {
	return registered;
}

export function startExtensions(): void {
	for (const extension of registered) extension.start?.();
}

export function notifySignOut(): void {
	for (const extension of registered) {
		try {
			extension.onSignOut?.();
		} catch {
		}
	}
}

export function extensionPages(): ExtensionPage[] {
	return registered.flatMap((extension) => extension.pages ?? []);
}

const normalise = (path: string) => path.replace(/\/+$/, "") || "/";

export function findExtensionPage(pathname: string): ExtensionPage | undefined {
	const path = normalise(pathname);
	return extensionPages().find((page) => normalise(page.path) === path);
}

export function knownVendors(): readonly KnownVendor[] {
	const added = registered.flatMap((extension) => extension.vendors ?? []);
	return added.length === 0 ? KNOWN_VENDORS : [...KNOWN_VENDORS, ...added];
}

export function planActionComponent():
	| ComponentType<PlanActionProps>
	| undefined {
	return registered.find((extension) => extension.PlanAction)?.PlanAction;
}
