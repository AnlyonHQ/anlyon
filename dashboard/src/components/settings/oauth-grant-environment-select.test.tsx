/* @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OAuthGrant } from "@/hooks/api/use-oauth-grants";
import type { Environment } from "@/lib/types";

const update = vi.hoisted(() => ({
	mutate: vi.fn(),
	isPending: false,
}));

const environments: Environment[] = [
	{
		id: "environment-production",
		name: "Production",
		slug: "production",
		kind: "production",
		isDefault: true,
		isProtected: true,
		halted: false,
		haltedAt: null,
		haltedReason: null,
		createdAt: "2026-07-19T00:00:00.000Z",
		updatedAt: "2026-07-19T00:00:00.000Z",
	},
	{
		id: "environment-staging",
		name: "staging",
		slug: "staging",
		kind: "development",
		isDefault: false,
		isProtected: false,
		halted: false,
		haltedAt: null,
		haltedReason: null,
		createdAt: "2026-07-19T00:00:00.000Z",
		updatedAt: "2026-07-19T00:00:00.000Z",
	},
];

vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({ data: environments, isLoading: false }),
}));

vi.mock("@/hooks/api/use-oauth-grants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/hooks/api/use-oauth-grants")>();
	return {
		...actual,
		useUpdateOAuthGrantEnvironment: () => update,
	};
});

import { OAuthGrantEnvironmentSelect } from "./oauth-grant-environment-select";

const grant: OAuthGrant = {
	clientId: "claude-client",
	name: "Claude",
	uri: null,
	redirectHosts: [],
	permissions: [],
	workspace: { id: "workspace-1", name: "Anlyon" },
	environment: { id: "environment-production", name: "Production" },
	authorizedAt: "2026-07-19T00:00:00.000Z",
	lastRenewedAt: null,
	active: true,
};

describe("OAuthGrantEnvironmentSelect", () => {
	it("changes the environment for this OAuth client only", () => {
		render(<OAuthGrantEnvironmentSelect grant={grant} />);

		fireEvent.change(screen.getByLabelText("Environment for Claude"), {
			target: { value: "environment-staging" },
		});

		expect(update.mutate).toHaveBeenCalledWith({
			clientId: "claude-client",
			workspaceId: "workspace-1",
			environmentId: "environment-staging",
		});
	});
});
