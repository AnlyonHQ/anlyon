import { Link, useLocation } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	type BannerContext,
	type ExtensionBanners,
	findExtensionPage,
	getExtensions,
	type PlanActionProps,
	planActionComponent,
} from "@/lib/extensions";

export function ExtensionSessions() {
	return (
		<>
			{getExtensions().map(({ id, Session }) =>
				Session ? <Session key={id} /> : null,
			)}
		</>
	);
}

export function ExtensionTopBar() {
	return (
		<>
			{getExtensions().flatMap(({ id, topBar }) =>
				(topBar ?? []).map((Item, index) => (
					<Item key={`${id}-${index.toString()}`} />
				)),
			)}
		</>
	);
}

export function useExtensionBanners(context: BannerContext): ExtensionBanners {
	const results = getExtensions().flatMap(({ id, useBanners }) =>
		// biome-ignore lint/correctness/useHookAtTopLevel: the registry never changes after the first render, so the same hooks run in the same order every time.
		useBanners ? [{ id, ...useBanners(context) }] : [],
	);
	return {
		quiet: results.some((result) => result.quiet),
		node: results.map((result) => (
			<Fragment key={result.id}>{result.node}</Fragment>
		)),
	};
}

export function hasPlanActions(): boolean {
	return planActionComponent() !== undefined;
}

export function PlanAction({
	fallback = null,
	...props
}: PlanActionProps & { fallback?: ReactNode }) {
	const Action = planActionComponent();
	if (!Action) return <>{fallback}</>;
	return <Action {...props} />;
}

export function ExtensionPageView() {
	const pathname = useLocation({ select: (location) => location.pathname });
	const Page = findExtensionPage(pathname)?.component;
	if (Page) return <Page />;
	return <PageNotFound />;
}

export function PageNotFound() {
	return (
		<section className="flex flex-col items-start gap-3 py-16">
			<h2 className="font-heading text-2xl">Page not found</h2>
			<p className="text-muted-foreground text-sm">
				Nothing is served at this address on this console.
			</p>
			<Button render={<Link to="/" />} size="sm" variant="outline">
				Go to Home
			</Button>
		</section>
	);
}
