import { isFeatureEnabled } from "@anlyon/feature-flags";
import { Link } from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useIntegrationRoute } from "@/hooks/api/use-connections";
import { knownVendors } from "@/lib/extensions";
import type { IntegrationRoute } from "@/lib/types";

const DELAY_MS = 300;

function useSettled(value: string): string {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), DELAY_MS);
		return () => clearTimeout(timer);
	}, [value]);
	return settled;
}

const LABEL: Record<IntegrationRoute["kind"], string> = {
	integration: "Connect it",
	mcp: "Add its MCP server",
	mcp_address: "Add an MCP server by address",
	openapi: "Import an OpenAPI spec",
	custom_action: "Declare a custom action",
};

const LINK_CLASS = "text-foreground underline underline-offset-2";

type AnchorProps = { className?: string; children?: ReactNode };

function routeAnchor(
	route: IntegrationRoute,
	vendor: string,
	props: AnchorProps,
): ReactElement {
	switch (route.kind) {
		case "integration":
			return (
				<Link
					{...props}
					search={{ integration: route.integration?.id }}
					to="/integrations"
				/>
			);
		case "mcp": {
			const server = knownVendors().find(
				(vendor) => vendor.server.registryName === route.mcp?.registryName,
			)?.slug;
			return (
				<Link
					{...props}
					search={server ? { server } : {}}
					to="/mcp-servers/new"
				/>
			);
		}
		case "mcp_address":
			return <Link {...props} search={{}} to="/mcp-servers/new" />;
		case "openapi":
			return (
				<Link
					{...props}
					search={{ action: undefined, import: "openapi", vendor }}
					to="/actions"
				/>
			);
		default:
			return (
				<a {...props} href={route.next.docs} rel="noreferrer" target="_blank">
					{props.children}
				</a>
			);
	}
}

function RouteLink({
	route,
	vendor,
	primary,
}: {
	route: IntegrationRoute;
	vendor: string;
	primary?: boolean;
}) {
	const isMcp = route.kind === "mcp" || route.kind === "mcp_address";
	if (isMcp && !isFeatureEnabled("mcp-upstreams")) return null;
	const label = LABEL[route.kind];
	return primary ? (
		<Button render={routeAnchor(route, vendor, {})} size="sm" variant="outline">
			{label}
		</Button>
	) : (
		routeAnchor(route, vendor, { className: LINK_CLASS, children: label })
	);
}

export function IntegrationRouteHint({
	workspaceId,
	name,
}: {
	workspaceId?: string;
	name: string;
}) {
	const settled = useSettled(name.trim());
	const { data, isError } = useIntegrationRoute(workspaceId, settled);

	if (!settled) return null;
	if (isError)
		return (
			<p className="text-muted-foreground text-sm">
				Import its OpenAPI spec from{" "}
				<Link
					className={LINK_CLASS}
					search={{ action: undefined }}
					to="/actions"
				>
					Actions
				</Link>
				, or{" "}
				<a
					className={LINK_CLASS}
					href="mailto:support@anlyon.com?subject=Integration%20request"
				>
					ask for it
				</a>
				.
			</p>
		);
	if (!data) return null;

	const { route, alternatives, name: vendor, tellUs } = data;
	return (
		<section
			aria-label={`The best way to act in ${vendor}`}
			className="max-w-2xl space-y-2 text-sm"
		>
			<p className="text-foreground">{route.why}</p>
			{route.mcp ? (
				<p className="text-muted-foreground">
					It lives at{" "}
					<span className="font-mono text-foreground">{route.mcp.host}</span>.{" "}
					<a
						className={LINK_CLASS}
						href={route.mcp.report}
						rel="noreferrer"
						target="_blank"
					>
						See what its tools do
					</a>
					.
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
				<RouteLink primary route={route} vendor={vendor} />
				{alternatives.map((other) => (
					<RouteLink key={other.kind} route={other} vendor={vendor} />
				))}
				<a className={LINK_CLASS} href={tellUs}>
					Tell us
				</a>
			</div>
		</section>
	);
}
