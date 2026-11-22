export type Limit = number | "unlimited";

export type PlanId = "starter" | "production" | "growth" | "enterprise";

export interface PlanCatalogueEntry {
	id: PlanId;
	name: string;
	contract: boolean;
	monthlyPriceCents: number | null;
	yearlyPriceCents: number | null;
	trialDays: number | null;
	governedActionsPerMonth: number | null;
	actionGraceRatio: number | null;
	actionPacks: boolean;
	seats: Limit | null;
	environments: Limit | null;
	storageBytes: number | null;
	egressBytesPerMonth: number | null;
	traceRetentionDays: number | null;
	traceArchive: boolean;
	auditRetentionMonths: number | null;
	requestsPerMinute: Limit | null;
	requestsPerHour: Limit | null;
	approvalPoliciesPerEnvironment: Limit | null;
	vigilReviewsPerMonth: Limit | null;
	vigilAutoApprovalsPerDay: Limit | null;
	protectedProduction: boolean;
	controlledPromotion: boolean;
	teamFeatures: boolean;
	support: "standard" | "priority" | "dedicated";
	functionRuns: FunctionRunLimitsEntry | null;
}

export interface FunctionRunLimitsEntry {
	runsPerMonth: Limit;
	concurrentRuns: Limit;
	runStartsPerMinute: Limit;
}

export interface ActionPackTerms {
	units: number;
	priceCents: number;
	validMonths: number;
}

export const INCLUDED = "Included";
export const NOT_INCLUDED = "Not included";
export const CUSTOM = "Custom";

const n = (value: number) => new Intl.NumberFormat("en-US").format(value);
const compact = (value: number) =>
	new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
const usd = (cents: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(cents / 100);
const GIB = 1024 ** 3;
const gib = (bytes: number) => `${n(bytes / GIB)} GiB`;
const yes = (on: boolean) => (on ? INCLUDED : NOT_INCLUDED);
const limit = (
	plan: PlanCatalogueEntry,
	value: Limit | null | undefined,
	format: (value: number) => string,
) =>
	plan.contract ||
	value === null ||
	value === undefined ||
	value === "unlimited"
		? CUSTOM
		: format(value);

export type ComparisonGroup =
	| "Usage"
	| "Governance"
	| "Your users and integrations"
	| "Hosted functions"
	| "Team features"
	| "Support and billing";

export interface ComparisonRow {
	group: ComparisonGroup;
	dimension: string;
	explain: string;
	values: Partial<Record<PlanId, string>>;
}

type RowDef = {
	group: ComparisonGroup;
	dimension: string;
	explain: string;
	value: (plan: PlanCatalogueEntry, pack: ActionPackTerms) => string;
};

const ROWS: RowDef[] = [
	{
		group: "Usage",
		dimension: "Governed actions",
		explain:
			"A confirmed outbound call through an action you defined, including a destination error response. Never-dispatched requests do not count. Alerts at 80% and 100%, then a 10% buffer.",
		value: (p) => limit(p, p.governedActionsPerMonth, (v) => `${n(v)} / month`),
	},
	{
		group: "Usage",
		dimension: "Action packs",
		explain:
			"Prepaid governed actions used after the monthly allowance, valid for 12 months.",
		value: (p, pack) =>
			p.contract
				? CUSTOM
				: p.actionPacks
					? `${usd(pack.priceCents)} per ${compact(pack.units)}`
					: NOT_INCLUDED,
	},
	{
		group: "Usage",
		dimension: "Seats",
		explain: "Members and pending invitations.",
		value: (p) => limit(p, p.seats, n),
	},
	{
		group: "Usage",
		dimension: "Environments",
		explain:
			"Separate credentials, data, and execution. Each one can be of kind production, staging or development.",
		value: (p) => limit(p, p.environments, n),
	},
	{
		group: "Usage",
		dimension: "Storage",
		explain: "Trace archives and files attached to runs. A fixed limit.",
		value: (p) => limit(p, p.storageBytes, gib),
	},
	{
		group: "Usage",
		dimension: "Egress",
		explain: "Data transferred on outbound deliveries. A fixed limit.",
		value: (p) => limit(p, p.egressBytesPerMonth, (v) => `${gib(v)} / month`),
	},
	{
		group: "Usage",
		dimension: "API requests",
		explain:
			"Requests for the workspace, across its keys. The minute limit absorbs bursts; the hour limit is there for a sustained flood.",
		value: (p) =>
			p.contract
				? CUSTOM
				: `${limit(p, p.requestsPerMinute, (v) => `${n(v)} / minute`)} · ${limit(p, p.requestsPerHour, (v) => `${n(v)} / hour`)}`,
	},
	{
		group: "Usage",
		dimension: "Receipt and trace history",
		explain: "How long receipts and traces stay in the console and the API.",
		value: (p) => limit(p, p.traceRetentionDays, (v) => `${n(v)} days`),
	},
	{
		group: "Usage",
		dimension: "Trace archive",
		explain: "Traces are archived before they leave the history window.",
		value: (p) => yes(p.traceArchive),
	},
	{
		group: "Governance",
		dimension: "Approvals and Slack approvals",
		explain:
			"A person approves the exact request, in Slack, the console or through the API.",
		value: () => INCLUDED,
	},
	{
		group: "Governance",
		dimension: "Approval policies",
		explain:
			"Policies one environment may hold. Every call is checked against them.",
		value: (p) =>
			limit(
				p,
				p.approvalPoliciesPerEnvironment,
				(v) => `${n(v)} per environment`,
			),
	},
	{
		group: "Governance",
		dimension: "Impact limits, key budgets and the halt switch",
		explain:
			"Shared limits on what calls may change, and a stop for an environment.",
		value: () => INCLUDED,
	},
	{
		group: "Governance",
		dimension: "Receipts, the audit API and export",
		explain:
			"Every call Anlyon made, graded by its outcome, readable and exportable.",
		value: () => INCLUDED,
	},
	{
		group: "Governance",
		dimension: "Audit record retention",
		explain:
			"How long audit records are kept. Recent records are in the console; older ones are archived, verified and still in the export, then deleted when retention ends.",
		value: (p) => limit(p, p.auditRetentionMonths, (v) => `${n(v)} months`),
	},
	{
		group: "Governance",
		dimension: "Environment protection and controlled promotion",
		explain: "Protected production and promotion between environments.",
		value: (p) => yes(p.protectedProduction && p.controlledPromotion),
	},
	{
		group: "Governance",
		dimension: "Anlyon Vigil",
		explain:
			"A second reader for your approval queue: reviews a month, and approvals it may make a day.",
		value: (p) =>
			p.contract ||
			p.vigilReviewsPerMonth === null ||
			p.vigilAutoApprovalsPerDay === null ||
			p.vigilReviewsPerMonth === "unlimited" ||
			p.vigilAutoApprovalsPerDay === "unlimited"
				? CUSTOM
				: `${n(p.vigilReviewsPerMonth)} / month · ${n(p.vigilAutoApprovalsPerDay)} / day`,
	},
	{
		group: "Your users and integrations",
		dimension: "Your users, each with their own limits and approvals",
		explain:
			"Act in each of your users' accounts, with limits, approvals and receipts per user.",
		value: () => INCLUDED,
	},
	{
		group: "Your users and integrations",
		dimension: "Connected accounts and integrations",
		explain:
			"Your users connect their own accounts; the integrations come with their actions.",
		value: () => INCLUDED,
	},
	{
		group: "Your users and integrations",
		dimension: "MCP servers",
		explain: "The hosted MCP endpoint, and one server per integration.",
		value: () => INCLUDED,
	},
	{
		group: "Hosted functions",
		dimension: "Function runs",
		explain:
			"Runs of your own code a month. Its action calls count as governed actions.",
		value: (p) =>
			limit(p, p.functionRuns?.runsPerMonth, (v) => `${n(v)} / month`),
	},
	{
		group: "Hosted functions",
		dimension: "Runs at once",
		explain: "Runs going at the same time across the workspace.",
		value: (p) => limit(p, p.functionRuns?.concurrentRuns, n),
	},
	{
		group: "Hosted functions",
		dimension: "Run starts",
		explain: "Runs started in any minute.",
		value: (p) =>
			limit(p, p.functionRuns?.runStartsPerMinute, (v) => `${n(v)} / minute`),
	},
	{
		group: "Team features",
		dimension: "Single sign-on and directory sync",
		explain: "OIDC or SAML, and SCIM provisioning.",
		value: (p) => yes(p.teamFeatures),
	},
	{
		group: "Team features",
		dimension: "Roles per environment",
		explain:
			"A role that differs per environment, such as approver in production.",
		value: (p) => yes(p.teamFeatures),
	},
	{
		group: "Team features",
		dimension: "Audit streaming",
		explain: "A signed webhook, S3, Datadog or Splunk.",
		value: (p) => yes(p.teamFeatures),
	},
	{
		group: "Team features",
		dimension: "Your own vault",
		explain:
			"Secrets read from AWS Secrets Manager or HashiCorp Vault when the call is made.",
		value: (p) => yes(p.teamFeatures),
	},
	{
		group: "Support and billing",
		dimension: "Support",
		explain:
			"Pro and Team include priority support, and Enterprise dedicated support.",
		value: (p) =>
			p.support === "dedicated"
				? "Dedicated"
				: p.support === "priority"
					? "Priority"
					: "Standard",
	},
	{
		group: "Support and billing",
		dimension: "Trial",
		explain: "A card is required. Nothing is charged until the trial ends.",
		value: (p) => (p.trialDays === null ? CUSTOM : `${n(p.trialDays)} days`),
	},
	{
		group: "Support and billing",
		dimension: "Yearly billing",
		explain: "Two months free when billed yearly.",
		value: (p) =>
			p.yearlyPriceCents === null
				? "Annual contract"
				: `${usd(p.yearlyPriceCents)} a year`,
	},
];

export function comparisonRows(
	plans: readonly PlanCatalogueEntry[],
	pack: ActionPackTerms,
	{ hostedFunctionsAvailable }: { hostedFunctionsAvailable: boolean },
): ComparisonRow[] {
	return ROWS.map((row) => ({
		group: row.group,
		dimension:
			row.group === "Hosted functions" && !hostedFunctionsAvailable
				? `${row.dimension} (coming soon)`
				: row.dimension,
		explain: row.explain,
		values: Object.fromEntries(
			plans.map((plan) => [plan.id, row.value(plan, pack)]),
		) as Partial<Record<PlanId, string>>,
	}));
}
