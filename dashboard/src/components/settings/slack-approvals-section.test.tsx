/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackApprovalsSettings } from "@/hooks/api/use-slack-approvals";
import { SlackApprovalsSection } from "./slack-approvals-section";

const state = vi.hoisted(() => ({ settings: null as unknown }));
const setRoute = vi.hoisted(() => vi.fn());
const removeRoute = vi.hoisted(() => vi.fn());
const startLink = vi.hoisted(() => vi.fn());
const unlink = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/api/use-slack-approvals", () => ({
	useSlackApprovals: () => ({ data: state.settings, isLoading: false }),
	useSetSlackApprovalRoute: () => ({ mutate: setRoute, isPending: false }),
	useRemoveSlackApprovalRoute: () => ({
		mutate: removeRoute,
		isPending: false,
	}),
	useStartSlackLink: () => ({ mutate: startLink, isPending: false }),
	useUnlinkSlack: () => ({ mutate: unlink, isPending: false }),
}));
vi.mock("@/hooks/api/use-environments", () => ({
	useEnvironments: () => ({
		isLoading: false,
		data: [
			{ id: "env_prod", name: "Production", slug: "prod", kind: "production" },
			{ id: "env_stg", name: "Staging", slug: "staging", kind: "staging" },
		],
	}),
}));
vi.mock("@/hooks/api/use-integrations", () => ({
	useSlackChannels: (_ws: string, integrationId: string) => ({
		isLoading: false,
		data: integrationId
			? [
					{ id: "C1", name: "approvals", isPrivate: false, isMember: true },
					{ id: "G2", name: "secret", isPrivate: true, isMember: false },
				]
			: undefined,
	}),
}));

afterEach(() => {
	cleanup();
	for (const fn of [setRoute, removeRoute, startLink, unlink]) fn.mockReset();
});

const base: SlackApprovalsSettings = {
	ready: true,
	requestUrl: "https://api.example.test/api/slack/interactions",
	installs: [
		{ integrationId: "int_1", teamId: "T1", teamName: "Acme", isActive: true },
	],
	routes: [
		{
			environmentId: "env_prod",
			integrationId: "int_1",
			channelId: "C1",
			channelName: "approvals",
			updatedAt: "2026-10-19T00:00:00Z",
		},
	],
	links: [],
};

describe("SlackApprovalsSection", () => {
	it("asks to connect Slack first when there is no active connection", () => {
		state.settings = { ...base, installs: [] };
		render(<SlackApprovalsSection workspaceId="ws_1" />);
		expect(screen.getByText(/Add Slack above first/)).toBeTruthy();
	});

	it("shows each environment's channel and says when the deployment is not ready", () => {
		state.settings = { ...base, ready: false };
		render(<SlackApprovalsSection workspaceId="ws_1" />);
		expect(
			screen.getByText("Approval requests are posted to #approvals"),
		).toBeTruthy();
		expect(screen.getByText("Not posted to Slack")).toBeTruthy();
		expect(
			screen.getByText(/cannot send decisions to this deployment yet/),
		).toBeTruthy();
		expect(screen.getByText(base.requestUrl as string)).toBeTruthy();
	});

	it("routes an environment to a chosen channel, and stops posting", () => {
		state.settings = base;
		render(<SlackApprovalsSection workspaceId="ws_1" />);
		fireEvent.click(screen.getByRole("button", { name: "Choose channel" }));
		fireEvent.change(screen.getByLabelText("Slack channel for Staging"), {
			target: { value: "G2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(setRoute).toHaveBeenCalledWith(
			{
				environmentId: "env_stg",
				integrationId: "int_1",
				channelId: "G2",
				channelName: "secret",
			},
			expect.anything(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop posting" }));
		expect(removeRoute).toHaveBeenCalledWith("env_prod");
	});

	it("links and unlinks the member's Slack account", () => {
		state.settings = base;
		const { rerender } = render(<SlackApprovalsSection workspaceId="ws_1" />);
		fireEvent.click(
			screen.getByRole("button", { name: "Link your Slack account" }),
		);
		expect(startLink).toHaveBeenCalled();

		state.settings = {
			...base,
			links: [
				{
					slackTeamId: "T1",
					slackUserId: "U1",
					createdAt: "2026-10-19T00:00:00Z",
				},
			],
		};
		rerender(<SlackApprovalsSection workspaceId="ws_1" />);
		expect(screen.getByText(/Linked to U1 in Acme/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
		expect(unlink).toHaveBeenCalled();
	});
});
