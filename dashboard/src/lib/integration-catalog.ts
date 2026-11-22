export interface IntegrationPresentation {
	category: string;
	summary: string;
	logo: string | null;
}

const PRESENTATION: Record<string, IntegrationPresentation> = {
	asana: {
		category: "Tasks",
		summary: "Tasks and comments in the projects your token reaches.",
		logo: "/integrations/asana.svg",
	},
	attio: {
		category: "CRM",
		summary: "People, companies and notes.",
		logo: "/integrations/attio.png",
	},
	discord: {
		category: "Messaging",
		summary: "Messages and threads, posted as your bot.",
		logo: "/integrations/discord.svg",
	},
	intercom: {
		category: "Support",
		summary: "Contacts and the state of conversations.",
		logo: "/integrations/intercom.svg",
	},
	sentry: {
		category: "Errors",
		summary: "Issues: resolve, reopen and assign.",
		logo: "/integrations/sentry.svg",
	},
	stripe: {
		category: "Payments",
		summary: "Refunds, counted in money.",
		logo: "/integrations/stripe.svg",
	},
	github: {
		category: "Code",
		summary:
			"Issues and their comments in the repositories your token reaches.",
		logo: "/integrations/github.svg",
	},
	pagerduty: {
		category: "Incidents",
		summary: "Incidents on your services.",
		logo: "/integrations/pagerduty.svg",
	},
	resend: {
		category: "Email",
		summary: "Email sent from a domain you verified.",
		logo: "/integrations/resend.svg",
	},
	hubspot: {
		category: "CRM",
		summary: "Contacts, companies and deals.",
		logo: "/integrations/hubspot.svg",
	},
	slack: {
		category: "Messaging",
		summary: "Messages, reactions and channel details in public channels.",
		logo: "/integrations/slack.svg",
	},
	"google-calendar": {
		category: "Calendar",
		summary: "Events on a person's calendar.",
		logo: "/integrations/google-calendar.svg",
	},
	gmail: {
		category: "Email",
		summary: "Email from a person's own Gmail address.",
		logo: null,
	},
	linear: {
		category: "Issue tracking",
		summary: "Issues, projects and comments.",
		logo: "/integrations/linear.svg",
	},
	notion: {
		category: "Documents",
		summary: "Pages you share with the integration you create.",
		logo: "/integrations/notion.svg",
	},
	salesforce: {
		category: "CRM",
		summary: "Records in a Salesforce org.",
		logo: "/integrations/salesforce.svg",
	},
	sendgrid: {
		category: "Email",
		summary: "Email you send and the contacts on your lists.",
		logo: "/integrations/sendgrid.png",
	},
	postmark: {
		category: "Email",
		summary: "Email sent and received through one Postmark server.",
		logo: "/integrations/postmark.png",
	},
	pipedrive: {
		category: "CRM",
		summary: "Deals, people and organizations in your pipelines.",
		logo: "/integrations/pipedrive.png",
	},
	front: {
		category: "Support",
		summary: "Shared inbox conversations and the contacts behind them.",
		logo: "/integrations/front.svg",
	},
	airtable: {
		category: "Database",
		summary: "Records and comments in the bases your token reaches.",
		logo: "/integrations/airtable.svg",
	},
	mailchimp: {
		category: "Email marketing",
		summary: "Audiences, their members and your campaigns.",
		logo: "/integrations/mailchimp.svg",
	},
	clickup: {
		category: "Tasks",
		summary: "Tasks, comments and checklists in the spaces your token reaches.",
		logo: "/integrations/clickup.svg",
	},
	todoist: {
		category: "Tasks",
		summary: "Tasks, projects and comments in a person's Todoist.",
		logo: "/integrations/todoist.svg",
	},
	calcom: {
		category: "Scheduling",
		summary: "Event types, free times and the bookings on your calendar.",
		logo: "/integrations/calcom.svg",
	},
	calendly: {
		category: "Scheduling",
		summary:
			"Meetings booked on your event types, and the people who booked them.",
		logo: "/integrations/calendly.svg",
	},
	gitlab: {
		category: "Code",
		summary:
			"Issues, merge requests and pipelines in the projects your token reaches.",
		logo: "/integrations/gitlab.svg",
	},
	vercel: {
		category: "Deployments",
		summary: "Deployments and domains of the projects your token reaches.",
		logo: "/integrations/vercel.svg",
	},
	jira: {
		category: "Issues",
		summary: "Issues, comments and transitions on your Jira site.",
		logo: "/integrations/jira.svg",
	},
	zendesk: {
		category: "Support",
		summary: "Tickets, replies and notes in your Zendesk.",
		logo: "/integrations/zendesk.svg",
	},
	"linear-key": {
		category: "Issues",
		summary:
			"Issues, comments and workflow states in the teams your key reaches.",
		logo: "/integrations/linear.svg",
	},
	monday: {
		category: "Work management",
		summary: "Items, column values and updates on your boards.",
		logo: "/integrations/monday.png",
	},
	trello: {
		category: "Tasks",
		summary: "Cards, lists, labels and comments on your boards.",
		logo: "/integrations/trello.svg",
	},
	close: {
		category: "CRM",
		summary: "Leads, contacts, opportunities, notes and tasks.",
		logo: "/integrations/close.png",
	},
	twilio: {
		category: "Messaging",
		summary: "Text messages, phone numbers and call logs.",
		logo: "/integrations/twilio.svg",
	},
};

const UNKNOWN: IntegrationPresentation = {
	category: "Integration",
	summary: "An account connected to this workspace.",
	logo: null,
};

export function integrationPresentation(id: string): IntegrationPresentation {
	return PRESENTATION[id] ?? UNKNOWN;
}

const ORDER = [
	"stripe",
	"hubspot",
	"github",
	"intercom",
	"attio",
	"notion",
	"sentry",
	"pagerduty",
	"asana",
	"discord",
	"resend",
];

export function byIntegrationOrder(
	a: { id: string; name: string },
	b: { id: string; name: string },
): number {
	const rank = (id: string) => {
		const index = ORDER.indexOf(id);
		return index === -1 ? ORDER.length : index;
	};
	return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
}

export function secretIntegrationId(secret: {
	integrationId?: string | null;
	connection?: { integrationId: string } | null;
}): string | null {
	return secret.integrationId ?? secret.connection?.integrationId ?? null;
}

export function matchesIntegration(
	entry: { id: string; name: string },
	query: string,
): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [entry.name, entry.id, integrationPresentation(entry.id).category]
		.join(" ")
		.toLowerCase()
		.includes(needle);
}
