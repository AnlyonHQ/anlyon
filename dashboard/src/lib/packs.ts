import airtable from "../../../packs/airtable/pack.json?raw";
import asana from "../../../packs/asana/pack.json?raw";
import attio from "../../../packs/attio/pack.json?raw";
import calcom from "../../../packs/calcom/pack.json?raw";
import calendly from "../../../packs/calendly/pack.json?raw";
import clickup from "../../../packs/clickup/pack.json?raw";
import close from "../../../packs/close/pack.json?raw";
import discord from "../../../packs/discord/pack.json?raw";
import front from "../../../packs/front/pack.json?raw";
import github from "../../../packs/github/pack.json?raw";
import gitlab from "../../../packs/gitlab/pack.json?raw";
import gmail from "../../../packs/gmail/pack.json?raw";
import googleCalendar from "../../../packs/google-calendar/pack.json?raw";
import hubspot from "../../../packs/hubspot/pack.json?raw";
import intercom from "../../../packs/intercom/pack.json?raw";
import jira from "../../../packs/jira/pack.json?raw";
import linear from "../../../packs/linear/pack.json?raw";
import linearKey from "../../../packs/linear-key/pack.json?raw";
import mailchimp from "../../../packs/mailchimp/pack.json?raw";
import monday from "../../../packs/monday/pack.json?raw";
import notion from "../../../packs/notion/pack.json?raw";
import outboundSales from "../../../packs/outbound-sales/pack.json?raw";
import pagerduty from "../../../packs/pagerduty/pack.json?raw";
import pipedrive from "../../../packs/pipedrive/pack.json?raw";
import postmark from "../../../packs/postmark/pack.json?raw";
import resend from "../../../packs/resend/pack.json?raw";
import sendgrid from "../../../packs/sendgrid/pack.json?raw";
import sentry from "../../../packs/sentry/pack.json?raw";
import slack from "../../../packs/slack/pack.json?raw";
import stripe from "../../../packs/stripe/pack.json?raw";
import supportRefunds from "../../../packs/support-refunds/pack.json?raw";
import todoist from "../../../packs/todoist/pack.json?raw";
import trello from "../../../packs/trello/pack.json?raw";
import twilio from "../../../packs/twilio/pack.json?raw";
import vercel from "../../../packs/vercel/pack.json?raw";
import zendesk from "../../../packs/zendesk/pack.json?raw";
import {
	expandPackRefsSync,
	installPack,
	type PackInstallOptions,
	type PackInstallResult,
	type PackManifest,
	type PackTransport,
	planPack,
	validatePackManifest,
} from "../../../sdks/typescript/sdk/src/resources/packs-core.ts";
import { ApiError, apiClient } from "./api-client";

export {
	type PackCredentialMode,
	PackError,
	type PackInstallResult,
	type PackManifest,
	type PackStep,
} from "../../../sdks/typescript/sdk/src/resources/packs-core.ts";

export const CATALOGUE_PACKS: PackManifest[] = [
	airtable,
	asana,
	attio,
	discord,
	front,
	github,
	hubspot,
	intercom,
	mailchimp,
	notion,
	pagerduty,
	pipedrive,
	postmark,
	resend,
	sendgrid,
	sentry,
	slack,
	stripe,
	clickup,
	todoist,
	calcom,
	calendly,
	gitlab,
	vercel,
	close,
	jira,
	linear,
	linearKey,
	monday,
	trello,
	twilio,
	zendesk,
	googleCalendar,
	gmail,
].map((raw) => validatePackManifest(JSON.parse(raw)));

export function cataloguePack(id: string): PackManifest | undefined {
	return CATALOGUE_PACKS.find((pack) => pack.pack === id);
}

export const BUNDLED_PACKS: PackManifest[] = [
	supportRefunds,
	outboundSales,
].map((raw) =>
	validatePackManifest(expandPackRefsSync(JSON.parse(raw), cataloguePack)),
);

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return null;
		throw error;
	}
}

export interface OperationsApi extends PackTransport {
	updatePolicy(id: string, request: Record<string, unknown>): Promise<unknown>;
}

export function consoleTransport(workspaceId: string): OperationsApi {
	const opts = { workspaceId };
	return {
		getSecret: (name) => orNull(() => apiClient.get(`/secrets/${name}`, opts)),
		putSecret: (name, request) =>
			apiClient.put(`/secrets/${name}`, request, opts),
		getAction: (name) =>
			orNull(() => apiClient.get(`/actions/${encodeURIComponent(name)}`, opts)),
		createAction: (request) => apiClient.post("/actions", request, opts),
		updateAction: (name, request) =>
			apiClient.patch(`/actions/${encodeURIComponent(name)}`, request, opts),
		listPolicies: (actionName) =>
			apiClient.get("/approval-policies", { ...opts, params: { actionName } }),
		createPolicy: (request) =>
			apiClient.post("/approval-policies", request, opts),
		listLimits: () => apiClient.get("/impact-limits", opts),
		createLimit: (request) => apiClient.post("/impact-limits", request, opts),
		updatePolicy: (id, request) =>
			apiClient.patch(`/approval-policies/${id}`, request, opts),
	};
}

export function planBundledPack(
	transport: PackTransport,
	manifest: PackManifest,
	options: PackInstallOptions,
): Promise<PackInstallResult> {
	return planPack(transport, manifest, options);
}

export function installBundledPack(
	transport: PackTransport,
	manifest: PackManifest,
	options: PackInstallOptions,
): Promise<PackInstallResult> {
	return installPack(transport, manifest, options);
}
