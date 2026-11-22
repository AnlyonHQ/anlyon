import { isFeatureEnabled } from "@anlyon/feature-flags";
import { ValidationError } from "../../utils/errors.ts";

export type HostSpec = string[] | { hostTemplate: string; from: string };

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  pattern: string;
  hint?: string;
}

export type CredentialEncoding =
  | { kind: "basic"; username: string; password: string }
  | { kind: "template"; template: string };

export interface AccountParam {
  name: string;
  label: string;
  hint?: string;
}

export interface ApiKeyAuth {
  kind: "api_key";
  header: string;
  prefix: string;
  instructions: string;
  instructionsUrl: string;
  check: { url: string; headers?: Record<string, string>; graphql?: string };
  fields?: CredentialField[];
  encoding?: CredentialEncoding;
  account?: AccountParam;
}

export interface OAuthAuth {
  kind: "oauth";
  apiKey?: ApiKeyAuth;
}

export type IntegrationAuth = OAuthAuth | ApiKeyAuth;

export interface IntegrationEntry {
  id: string;
  auth: IntegrationAuth;
  displayName: string;
  hosts: HostSpec;
  scopes: string[];
  verificationStatus: "pending" | "verified" | "paused";
  exercised: boolean;
  reviewNote: string;
  operationsPack: string | null;
  workflowPacks: string[];
}

export const GITHUB_HEADERS: Readonly<Record<string, string>> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "anlyon" };
export const NOTION_HEADERS: Readonly<Record<string, string>> = { "Notion-Version": "2022-06-28" };

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export function googleEntries(offered: boolean): IntegrationEntry[] {
  if (!offered) {
    return [
      {
        id: "google-calendar",
        auth: { kind: "oauth" },
        exercised: false,
        displayName: "Google Calendar",
        hosts: ["www.googleapis.com"],
        scopes: [GOOGLE_CALENDAR_SCOPE],
        verificationStatus: "paused",
        reviewNote: "Not offered yet. Brand verification plus sensitive-scope verification (demo video, justification); Google quotes days, plan for weeks. Unverified apps stop at 100 users for the project's lifetime.",
        operationsPack: null,
        workflowPacks: ["anlyon/outbound-sales"],
      },
      {
        id: "gmail",
        auth: { kind: "oauth" },
        exercised: false,
        displayName: "Gmail",
        hosts: ["gmail.googleapis.com"],
        scopes: [],
        verificationStatus: "paused",
        reviewNote: "Not offered. Reading a sent message back needs a restricted Google scope, which puts the whole app through a yearly third-party security assessment.",
        operationsPack: null,
        workflowPacks: [],
      },
    ];
  }
  return [
    {
      id: "google-calendar",
      auth: { kind: "oauth" },
      exercised: true,
      displayName: "Google Calendar",
      hosts: ["www.googleapis.com"],
      scopes: [GOOGLE_CALENDAR_SCOPE],
      verificationStatus: "verified",
      reviewNote: "Anlyon's Google app is waiting for Google's verification (brand and sensitive scope). Until it passes, only the test users listed on the app can connect, and Google ends their sign-in after 7 days.",
      operationsPack: "anlyon/google-calendar",
      workflowPacks: ["anlyon/outbound-sales"],
    },
    {
      id: "gmail",
      auth: { kind: "oauth" },
      exercised: true,
      displayName: "Gmail",
      hosts: ["gmail.googleapis.com"],
      scopes: [GMAIL_SEND_SCOPE],
      verificationStatus: "verified",
      reviewNote: "Send only: Anlyon cannot read your mail, so a sent email is acknowledged, not read back. Anlyon's Google app is waiting for Google's verification; until it passes, only the app's test users can connect, and Google ends their sign-in after 7 days.",
      operationsPack: "anlyon/gmail",
      workflowPacks: [],
    },
  ];
}

export const CATALOGUE: readonly IntegrationEntry[] = [
  {
    id: "hubspot",
    auth: { kind: "oauth" },
    exercised: true,
    displayName: "HubSpot",
    hosts: ["api.hubapi.com"],
    scopes: [
      "crm.objects.contacts.write",
      "crm.objects.contacts.read",
      "crm.objects.companies.write",
      "crm.objects.companies.read",
      "crm.objects.deals.write",
      "crm.objects.deals.read",
    ],
    verificationStatus: "verified",
    reviewNote: "None to sign in with your own app. Anlyon's unlisted app is capped at 25 installs until HubSpot reviews and lists it, so add your own app for production. New apps are developer-platform projects (CLI); legacy public apps can no longer be created.",
    operationsPack: "anlyon/hubspot",
    workflowPacks: ["anlyon/support-refunds", "anlyon/outbound-sales"],
  },
  {
    id: "slack",
    auth: { kind: "oauth" },
    exercised: true,
    displayName: "Slack",
    hosts: ["slack.com"],
    scopes: ["chat:write", "channels:history", "channels:read", "channels:write.topic", "reactions:write", "reactions:read"],
    verificationStatus: "verified",
    reviewNote: "None once public distribution is activated. Unlisted apps get a 1 request/minute limit on conversations.history; a Marketplace listing lifts it.",
    operationsPack: "anlyon/slack",
    workflowPacks: ["anlyon/support-refunds", "anlyon/outbound-sales"],
  },
  ...googleEntries(isFeatureEnabled("google-integrations")),
  {
    id: "linear",
    auth: { kind: "oauth" },
    exercised: true,
    displayName: "Linear",
    hosts: ["api.linear.app"],
    scopes: ["read", "write"],
    verificationStatus: "verified",
    reviewNote: "None for an OAuth app used outside a marketplace listing.",
    operationsPack: "anlyon/linear",
    workflowPacks: [],
  },
  {
    id: "salesforce",
    auth: { kind: "oauth" },
    exercised: false,
    displayName: "Salesforce",
    hosts: { hostTemplate: "{instance}", from: "connection_config.instance_url" },
    scopes: ["api", "refresh_token"],
    verificationStatus: "paused",
    reviewNote: "Not offered yet. New Connected Apps are disabled since Spring '26: use an External Client App, packaged in a second-generation managed package for customer orgs (no AppExchange listing needed). The API host is the account's own instance.",
    operationsPack: null,
    workflowPacks: [],
  },
  {
    id: "github",
    auth: {
      kind: "oauth",
      apiKey: {
        kind: "api_key",
        header: "Authorization",
        prefix: "Bearer ",
        instructions: "In GitHub, open Settings, Developer settings, Personal access tokens, Fine-grained tokens, and generate a token limited to the repositories your agent should work in. Give it Issues: Read and write, Pull requests: Read and write, and Contents: Read. Contents: Read and write is needed only to merge pull requests.",
        instructionsUrl: "https://github.com/settings/personal-access-tokens/new",
        check: { url: "https://api.github.com/user", headers: GITHUB_HEADERS },
      },
    },
    exercised: true,
    displayName: "GitHub",
    hosts: ["api.github.com"],
    scopes: ["repo"],
    verificationStatus: "verified",
    reviewNote: "None. An OAuth app or a GitHub App signs anyone in once it is created; only a GitHub Marketplace listing is reviewed. You can also connect with a token you create in GitHub.",
    operationsPack: "anlyon/github",
    workflowPacks: [],
  },
  {
    id: "notion",
    auth: {
      kind: "oauth",
      apiKey: {
        kind: "api_key",
        header: "Authorization",
        prefix: "Bearer ",
        instructions: "In Notion, open Settings, Connections, Develop or manage integrations, and create an internal integration with Read content, Update content, Insert content, Read comments and Insert comments. Then share each page your agent should reach with that integration, from the page's own menu.",
        instructionsUrl: "https://www.notion.so/profile/integrations",
        check: { url: "https://api.notion.com/v1/users/me", headers: NOTION_HEADERS },
      },
    },
    exercised: true,
    displayName: "Notion",
    hosts: ["api.notion.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None to sign in: a public integration works for any workspace once it is made public. Only a listing in Notion's integration gallery is reviewed. You can also connect with an internal integration token you create in Notion.",
    operationsPack: "anlyon/notion",
    workflowPacks: [],
  },

  {
    id: "asana",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Asana, open the developer console at app.asana.com/0/my-apps and create a personal access token. It acts as you, so create it from an account limited to the projects your agent should reach.",
      instructionsUrl: "https://app.asana.com/0/my-apps",
      check: { url: "https://app.asana.com/api/1.0/users/me", headers: { Accept: "application/json" } },
    },
    exercised: true,
    displayName: "Asana",
    hosts: ["app.asana.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal access token you create in Asana.",
    operationsPack: "anlyon/asana",
    workflowPacks: [],
  },
  {
    id: "attio",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Attio, open Workspace settings, Developers, and create an access token. Give it Records: Read-write, Object configuration: Read, List configuration: Read, List entries: Read-write, Notes: Read-write, Tasks: Read-write and User management: Read.",
      instructionsUrl: "https://app.attio.com/_/settings/developers",
      check: { url: "https://api.attio.com/v2/self" },
    },
    exercised: true,
    displayName: "Attio",
    hosts: ["api.attio.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API key you create in Attio.",
    operationsPack: "anlyon/attio",
    workflowPacks: [],
  },
  {
    id: "discord",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bot ",
      instructions: "In the Discord Developer Portal, create an application, add a bot, and copy the bot's token. Invite the bot to your server with View Channel, Send Messages, Send Messages in Threads, Read Message History, Create Public Threads, Add Reactions and Pin Messages.",
      instructionsUrl: "https://discord.com/developers/applications",
      check: { url: "https://discord.com/api/v10/users/@me", headers: { "User-Agent": "DiscordBot (https://anlyon.com, 1.0)" } },
    },
    exercised: true,
    displayName: "Discord",
    hosts: ["discord.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a bot token you create in Discord.",
    operationsPack: "anlyon/discord",
    workflowPacks: [],
  },
  {
    id: "intercom",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In the Intercom Developer Hub, create an app for your workspace and copy its access token from Authentication. The workspace must be hosted in the US region.",
      instructionsUrl: "https://app.intercom.com/a/apps/_/developer-hub",
      check: { url: "https://api.intercom.io/me", headers: { Accept: "application/json", "Intercom-Version": "2.11" } },
    },
    exercised: true,
    displayName: "Intercom",
    hosts: ["api.intercom.io"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an access token you create in Intercom.",
    operationsPack: "anlyon/intercom",
    workflowPacks: [],
  },
  {
    id: "sentry",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Sentry, open Settings, Developer Settings, Personal Tokens (or an internal integration), and create a token with org:read, project:read and event:write. Nothing else is needed.",
      instructionsUrl: "https://sentry.io/settings/account/api/auth-tokens/",
      check: { url: "https://sentry.io/api/0/organizations/" },
    },
    exercised: true,
    displayName: "Sentry",
    hosts: ["sentry.io"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an auth token you create in Sentry.",
    operationsPack: "anlyon/sentry",
    workflowPacks: [],
  },
  {
    id: "stripe",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Stripe, open Developers, API keys, and create a restricted key with Customers: Write, Payment Intents: Read, Charges: Read, Refunds: Write, Invoices: Write, Subscriptions: Write and Balance: Read. Leave out any your agent should not touch; the operations that need them are refused.",
      instructionsUrl: "https://dashboard.stripe.com/apikeys",
      check: { url: "https://api.stripe.com/v1/refunds?limit=1" },
    },
    exercised: true,
    displayName: "Stripe",
    hosts: ["api.stripe.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a restricted key you create in Stripe.",
    operationsPack: "anlyon/stripe",
    workflowPacks: [],
  },
  {
    id: "pagerduty",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Token token=",
      instructions: "In PagerDuty, open Integrations, API Access Keys, and create a key. Leave Read-only API key unticked, because your agent opens and updates incidents.",
      instructionsUrl: "https://support.pagerduty.com/main/docs/api-access-keys",
      check: { url: "https://api.pagerduty.com/abilities", headers: { Accept: "application/vnd.pagerduty+json;version=2" } },
    },
    exercised: true,
    displayName: "PagerDuty",
    hosts: ["api.pagerduty.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API key you create in PagerDuty.",
    operationsPack: "anlyon/pagerduty",
    workflowPacks: [],
  },
  {
    id: "resend",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Resend, open API Keys and create a key with Full access. A Sending access key can send but cannot read an email back, so a send could never be confirmed.",
      instructionsUrl: "https://resend.com/api-keys",
      check: { url: "https://api.resend.com/domains" },
    },
    exercised: true,
    displayName: "Resend",
    hosts: ["api.resend.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API key you create in Resend.",
    operationsPack: "anlyon/resend",
    workflowPacks: [],
  },

  {
    id: "sendgrid",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In SendGrid, open Settings, API Keys, and create a key with Custom Access. Give it Mail Send: Full Access, Marketing: Full Access, Suppressions: Full Access and Template Engine: Read Access.",
      instructionsUrl: "https://app.sendgrid.com/settings/api_keys",
      check: { url: "https://api.sendgrid.com/v3/scopes" },
    },
    exercised: true,
    displayName: "SendGrid",
    hosts: ["api.sendgrid.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API key you create in SendGrid.",
    operationsPack: "anlyon/sendgrid",
    workflowPacks: [],
  },
  {
    id: "postmark",
    auth: {
      kind: "api_key",
      header: "X-Postmark-Server-Token",
      prefix: "",
      instructions: "In Postmark, open the server your agent should send from, then its API Tokens tab, and copy the Server API token. The token reaches that one server and its message streams, so use a server set aside for what your agent sends.",
      instructionsUrl: "https://postmarkapp.com/support/article/1008-what-are-the-account-and-server-api-tokens",
      check: { url: "https://api.postmarkapp.com/deliverystats", headers: { Accept: "application/json" } },
    },
    exercised: true,
    displayName: "Postmark",
    hosts: ["api.postmarkapp.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a Server API token you copy from Postmark.",
    operationsPack: "anlyon/postmark",
    workflowPacks: [],
  },
  {
    id: "pipedrive",
    auth: {
      kind: "api_key",
      header: "x-api-token",
      prefix: "",
      instructions: "In Pipedrive, open Settings, Personal preferences, API, and copy your personal API token. It acts as you with your permissions, so use the token of a user who can see and edit the deals, people and organizations your agent should reach.",
      instructionsUrl: "https://support.pipedrive.com/en/article/how-can-i-find-my-personal-api-key",
      check: { url: "https://api.pipedrive.com/v1/users/me" },
    },
    exercised: true,
    displayName: "Pipedrive",
    hosts: ["api.pipedrive.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal API token you copy from Pipedrive.",
    operationsPack: "anlyon/pipedrive",
    workflowPacks: [],
  },
  {
    id: "front",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Front, an admin opens Settings, Developers, API Tokens and creates a token for Global resources and the shared workspaces your agent works in. Give it Read, Write and Send; Delete is not needed.",
      instructionsUrl: "https://dev.frontapp.com/docs/create-and-revoke-api-tokens",
      check: { url: "https://api2.frontapp.com/me" },
    },
    exercised: true,
    displayName: "Front",
    hosts: ["api2.frontapp.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API token you create in Front.",
    operationsPack: "anlyon/front",
    workflowPacks: [],
  },
  {
    id: "airtable",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Airtable, open the builder hub, Personal access tokens, and create a token with data.records:read, data.records:write, data.recordComments:read, data.recordComments:write and schema.bases:read. Add the bases your agent should reach and no others, because the token acts as you.",
      instructionsUrl: "https://airtable.com/developers/web/guides/personal-access-tokens",
      check: { url: "https://api.airtable.com/v0/meta/whoami" },
    },
    exercised: true,
    displayName: "Airtable",
    hosts: ["api.airtable.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal access token you create in Airtable.",
    operationsPack: "anlyon/airtable",
    workflowPacks: [],
  },
  {
    id: "mailchimp",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Mailchimp, open your profile, Extras, API keys, and create a key. A Mailchimp key can do anything your account can, so create it from a user whose access fits what your agent should reach.",
      instructionsUrl: "https://mailchimp.com/help/about-api-keys/",
      check: { url: "https://{{connection.host}}/3.0/ping" },
      account: { name: "dc", label: "Data center", hint: "The part after the dash at the end of your API key: us21 for a key ending in -us21." },
      fields: [
        { name: "apiKey", label: "API key", secret: true, pattern: "^[A-Za-z0-9]{16,64}-us[0-9]{1,3}$", hint: "The API key, as Mailchimp shows it once. It ends in -us and a number." },
      ],
    },
    exercised: true,
    displayName: "Mailchimp",
    hosts: { hostTemplate: "{dc}.api.mailchimp.com", from: "account.dc" },
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with your Mailchimp data center and an API key you create in Mailchimp.",
    operationsPack: "anlyon/mailchimp",
    workflowPacks: [],
  },
  {
    id: "clickup",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "",
      instructions: "In ClickUp, open your avatar, Settings, Apps, and generate an API token (it starts with pk_). It acts as you in every workspace you belong to, so create it from an account that is a member of the spaces your agent should reach.",
      instructionsUrl: "https://app.clickup.com/settings/apps",
      check: { url: "https://api.clickup.com/api/v2/user" },
    },
    exercised: true,
    displayName: "ClickUp",
    hosts: ["api.clickup.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal API token you create in ClickUp.",
    operationsPack: "anlyon/clickup",
    workflowPacks: [],
  },
  {
    id: "todoist",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Todoist, open Settings, Integrations, Developer, and copy your API token. It has no scopes and can do anything you can do in Todoist, so copy it from an account limited to the projects your agent should reach.",
      instructionsUrl: "https://app.todoist.com/app/settings/integrations/developer",
      check: { url: "https://api.todoist.com/api/v1/projects?limit=1" },
    },
    exercised: true,
    displayName: "Todoist",
    hosts: ["api.todoist.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API token you copy from Todoist.",
    operationsPack: "anlyon/todoist",
    workflowPacks: [],
  },
  {
    id: "calcom",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Cal.com, open Settings, Developer, API keys, and create a key. It acts as the user who made it, with no narrower permissions, so create it from the account whose calendar your agent should manage.",
      instructionsUrl: "https://app.cal.com/settings/developer/api-keys",
      check: { url: "https://api.cal.com/v2/me" },
    },
    exercised: true,
    displayName: "Cal.com",
    hosts: ["api.cal.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API key you create in Cal.com.",
    operationsPack: "anlyon/calcom",
    workflowPacks: [],
  },
  {
    id: "calendly",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Calendly, open Integrations & apps, API and webhooks, and create a personal access token. Give it users:read, event_types:read, availability:read, scheduled_events:read, scheduled_events:write and scheduling_links:write; leave out any your agent should not use.",
      instructionsUrl: "https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens",
      check: { url: "https://api.calendly.com/users/me" },
    },
    exercised: true,
    displayName: "Calendly",
    hosts: ["api.calendly.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal access token you create in Calendly.",
    operationsPack: "anlyon/calendly",
    workflowPacks: [],
  },
  {
    id: "gitlab",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In GitLab, open User settings, Access tokens, and create a personal access token with the api scope. For a narrower key, create a project access token in the project's Settings, Access tokens, with the api scope and the Developer role (Maintainer to merge into protected branches).",
      instructionsUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
      check: { url: "https://gitlab.com/api/v4/user", headers: { Accept: "application/json" } },
    },
    exercised: true,
    displayName: "GitLab",
    hosts: ["gitlab.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an access token you create in GitLab. gitlab.com; self-managed instances are not supported yet.",
    operationsPack: "anlyon/gitlab",
    workflowPacks: [],
  },
  {
    id: "vercel",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Bearer ",
      instructions: "In Vercel, open Account Settings, Tokens, and create a token scoped to the team your agent works in, with an expiration. It acts as you in that team, so create it from an account whose role fits what your agent should do.",
      instructionsUrl: "https://vercel.com/account/settings/tokens",
      check: { url: "https://api.vercel.com/v2/teams?limit=1" },
    },
    exercised: true,
    displayName: "Vercel",
    hosts: ["api.vercel.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an access token you create in Vercel.",
    operationsPack: "anlyon/vercel",
    workflowPacks: [],
  },

  {
    id: "jira",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Basic ",
      instructions: "In Atlassian, open id.atlassian.com, Security, API tokens, and create an API token (the kind without scopes). It acts as you on your Jira site, so create it from an account whose project permissions fit what your agent should do.",
      instructionsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
      check: { url: "https://{{connection.host}}/rest/api/3/myself", headers: { Accept: "application/json" } },
      account: { name: "site", label: "Site", hint: "The name before .atlassian.net in your Jira address: acme for acme.atlassian.net." },
      fields: [
        { name: "email", label: "Email", secret: false, pattern: "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,63}$", hint: "The email of the Atlassian account the token belongs to." },
        { name: "apiToken", label: "API token", secret: true, pattern: "^[A-Za-z0-9_=+/.-]{16,512}$", hint: "The API token, as Atlassian shows it once." },
      ],
      encoding: { kind: "basic", username: "{email}", password: "{apiToken}" },
    },
    exercised: true,
    displayName: "Jira",
    hosts: { hostTemplate: "{site}.atlassian.net", from: "account.site" },
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with your Jira site, your email and an API token you create in Atlassian.",
    operationsPack: "anlyon/jira",
    workflowPacks: [],
  },
  {
    id: "zendesk",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Basic ",
      instructions: "In Zendesk, open Admin Center, Apps and integrations, APIs, API tokens, and add an API token. The token acts as whichever agent's email it is sent with, so connect it with the email of an agent whose role fits what your agent should do.",
      instructionsUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
      check: { url: "https://{{connection.host}}/api/v2/groups.json?page%5Bsize%5D=1", headers: { Accept: "application/json" } },
      account: { name: "subdomain", label: "Subdomain", hint: "The name before .zendesk.com in your Zendesk address: acme for acme.zendesk.com." },
      fields: [
        { name: "email", label: "Agent email", secret: false, pattern: "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,63}$", hint: "The email of the agent the calls act as." },
        { name: "apiToken", label: "API token", secret: true, pattern: "^[A-Za-z0-9]{20,64}$", hint: "The API token, as Zendesk shows it once." },
      ],
      encoding: { kind: "basic", username: "{email}/token", password: "{apiToken}" },
    },
    exercised: true,
    displayName: "Zendesk",
    hosts: { hostTemplate: "{subdomain}.zendesk.com", from: "account.subdomain" },
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with your Zendesk subdomain, an agent's email and an API token you create in Zendesk.",
    operationsPack: "anlyon/zendesk",
    workflowPacks: [],
  },
  {
    id: "linear-key",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "",
      instructions: "In Linear, open Settings, Security and access, Personal API keys, and create a key with read and write access to the teams your agent works in. It acts as you, so create it from an account that is a member of those teams.",
      instructionsUrl: "https://linear.app/settings/account/security",
      check: { url: "https://api.linear.app/graphql", graphql: "query { viewer { id } }" },
    },
    exercised: true,
    displayName: "Linear (API key)",
    hosts: ["api.linear.app"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal API key you create in Linear.",
    operationsPack: "anlyon/linear-key",
    workflowPacks: [],
  },
  {
    id: "monday",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "",
      instructions: "In monday.com, open your profile picture, Developers, My access tokens, and copy your personal API token. It acts as you in every board you can reach, so copy it from an account that is a member of the boards your agent should work in.",
      instructionsUrl: "https://developer.monday.com/api-reference/docs/authentication",
      check: { url: "https://api.monday.com/v2", headers: { "API-Version": "2026-07" }, graphql: "query { me { id } }" },
    },
    exercised: true,
    displayName: "monday.com",
    hosts: ["api.monday.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a personal API token you copy from monday.com.",
    operationsPack: "anlyon/monday",
    workflowPacks: [],
  },
  {
    id: "trello",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "OAuth ",
      instructions: "In Trello, create a Power-Up at trello.com/apps/admin, generate its API key, and then use the key's Token link to create a token for your account. The token acts as you on every board you can reach, so create it from an account that is a member of the boards your agent should work in.",
      instructionsUrl: "https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/",
      check: { url: "https://api.trello.com/1/members/me?fields=id" },
      fields: [
        { name: "key", label: "API key", secret: false, pattern: "^[0-9a-f]{32}$", hint: "The 32-character API key of your Power-Up." },
        { name: "token", label: "Token", secret: true, pattern: "^[A-Za-z0-9]{32,256}$", hint: "The token you created with the key's Token link." },
      ],
      encoding: { kind: "template", template: 'oauth_consumer_key="{key}", oauth_token="{token}"' },
    },
    exercised: true,
    displayName: "Trello",
    hosts: ["api.trello.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with a Trello API key and a token you create for your account.",
    operationsPack: "anlyon/trello",
    workflowPacks: [],
  },
  {
    id: "close",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Basic ",
      instructions: "In Close, open Settings, Developer, API keys, and create a key with read, write and delete access (a read-only key refuses every write). It acts as you in your organization, so create it from a user whose role fits what your agent should do.",
      instructionsUrl: "https://help.close.com/docs/api-keys-oauth",
      check: { url: "https://api.close.com/api/v1/me/" },
      fields: [
        { name: "apiKey", label: "API key", secret: true, pattern: "^api_[A-Za-z0-9._-]{8,200}$", hint: "The key, which starts with api_." },
      ],
      encoding: { kind: "basic", username: "{apiKey}", password: "" },
    },
    exercised: true,
    displayName: "Close",
    hosts: ["api.close.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an API key you create in Close.",
    operationsPack: "anlyon/close",
    workflowPacks: [],
  },
  {
    id: "twilio",
    auth: {
      kind: "api_key",
      header: "Authorization",
      prefix: "Basic ",
      instructions: "In the Twilio Console, open Account, API keys and tokens, and copy your Account SID and Auth Token. The Auth Token can do anything your account can, so connect a subaccount limited to the phone numbers your agent should use.",
      instructionsUrl: "https://www.twilio.com/docs/usage/requests-to-twilio",
      check: { url: "https://api.twilio.com/2010-04-01/Accounts.json?PageSize=1" },
      fields: [
        { name: "accountSid", label: "Account SID", secret: false, pattern: "^AC[0-9a-f]{32}$", hint: "Starts with AC, 34 characters." },
        { name: "authToken", label: "Auth Token", secret: true, pattern: "^[0-9a-f]{32}$", hint: "The 32-character Auth Token of that account." },
      ],
      encoding: { kind: "basic", username: "{accountSid}", password: "{authToken}" },
    },
    exercised: true,
    displayName: "Twilio",
    hosts: ["api.twilio.com"],
    scopes: [],
    verificationStatus: "verified",
    reviewNote: "None. You connect with an Account SID and Auth Token from the Twilio Console.",
    operationsPack: "anlyon/twilio",
    workflowPacks: [],
  },
];

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isBareHostname(value: string): boolean {
  return HOSTNAME.test(value);
}

export function findIntegration(id: string): IntegrationEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === id);
}

export function keyAuthOf(entry: IntegrationEntry): ApiKeyAuth | null {
  return entry.auth.kind === "api_key" ? entry.auth : entry.auth.apiKey ?? null;
}

export const SIGNED_IN_MARK = "signedIn";

export function rowHoldsKey(row: { integrationKey: string; connectionConfig: Record<string, unknown> | null }): boolean {
  const entry = findIntegration(row.integrationKey);
  if (!entry) return false;
  if (entry.auth.kind === "api_key") return true;
  return entry.auth.apiKey !== undefined && row.connectionConfig?.[SIGNED_IN_MARK] !== true;
}

export function listedIntegrations(): IntegrationEntry[] {
  return CATALOGUE.filter((entry) => entry.verificationStatus === "verified" && entry.exercised);
}

export function connectableIntegration(id: string, allowUnverified: boolean): IntegrationEntry {
  const entry = findIntegration(id);
  const listed = entry?.verificationStatus === "verified" && entry.exercised;
  if (!entry || entry.verificationStatus === "paused" || (!listed && !allowUnverified)) {
    throw new ValidationError(`No integration named "${id}" can be connected. List the available ones with GET /api/v2/connections/integrations.`, { integration: id, reason: "integration_not_connectable" });
  }
  return entry;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveHosts(entry: IntegrationEntry, connectionConfig: Record<string, unknown>): string[] {
  if (Array.isArray(entry.hosts)) return [...entry.hosts];
  if (!entry.hosts.from.startsWith("connection_config.")) {
    throw new ValidationError(`${entry.displayName}'s host is given at connect, not reported by the provider.`);
  }
  const path = entry.hosts.from.replace(/^connection_config\./, "");
  const raw = readPath(connectionConfig, path);
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError(`The ${entry.displayName} account did not report its API host, so the connection cannot be bound to one.`);
  }
  let host = raw.trim().toLowerCase();
  if (/^https:\/\//.test(host)) {
    try {
      const url = new URL(host);
      if (url.port || url.username || url.password) throw new Error("not bare");
      host = url.hostname;
    } catch {
      host = "";
    }
  }
  const filled = entry.hosts.hostTemplate.replace("{instance}", host);
  if (!isBareHostname(filled)) {
    throw new ValidationError(`The ${entry.displayName} account reported an API host that is not a bare hostname, so the connection was refused.`);
  }
  return [filled];
}

export const ACCOUNT_HOST_PLACEHOLDER = "{{connection.host}}";

const ACCOUNT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function accountHostTemplate(entry: IntegrationEntry): { param: string; suffix: string } | null {
  if (Array.isArray(entry.hosts) || !entry.hosts.from.startsWith("account.")) return null;
  const param = entry.hosts.from.slice("account.".length);
  const head = `{${param}}`;
  const suffix = entry.hosts.hostTemplate.startsWith(head) ? entry.hosts.hostTemplate.slice(head.length) : "";
  if (!/^\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(suffix) || !isBareHostname(suffix.slice(1))) {
    throw new ValidationError(`${entry.displayName}'s host template must be {${param}} followed by a fixed domain of the provider's.`);
  }
  return { param, suffix };
}

function accountLabelOk(label: string): boolean {
  return ACCOUNT_LABEL.test(label) && !label.startsWith("xn--");
}

export function accountHostFor(entry: IntegrationEntry, raw: unknown): string {
  const template = accountHostTemplate(entry);
  if (!template) throw new ValidationError(`${entry.displayName} has fixed hosts; it takes no account.`);
  const name = keyAuthOf(entry)?.account?.label ?? template.param;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 253) {
    throw new ValidationError(`${name} is required to connect ${entry.displayName}.`);
  }
  let label = raw.trim().toLowerCase();
  if (label.endsWith(template.suffix)) label = label.slice(0, -template.suffix.length);
  if (!accountLabelOk(label)) {
    throw new ValidationError(
      `${name} must be the single name before ${template.suffix} (letters, digits and hyphens), for example acme for acme${template.suffix}.`,
    );
  }
  const host = `${label}${template.suffix}`;
  if (!isBareHostname(host)) throw new ValidationError(`${name} does not make a valid ${entry.displayName} host.`);
  return host;
}

export function assertAccountHost(entry: IntegrationEntry, host: unknown): string {
  const template = accountHostTemplate(entry);
  if (!template) throw new ValidationError(`${entry.displayName} has fixed hosts.`);
  if (typeof host !== "string" || !host.endsWith(template.suffix) || !accountLabelOk(host.slice(0, -template.suffix.length))) {
    throw new ValidationError(`This ${entry.displayName} account is bound to a host that is not a ${entry.displayName} host, so nothing was sent. Connect it again.`);
  }
  return host;
}

export interface CredentialInput {
  apiKey?: string;
  fields?: Record<string, string>;
}

export interface ReadCredential {
  stored: string;
  accountHost: string | null;
}

export function usesFields(auth: ApiKeyAuth): boolean {
  return (auth.fields?.length ?? 0) > 0 || auth.account !== undefined;
}

function fieldPattern(field: CredentialField): RegExp {
  return new RegExp(field.pattern);
}

const HEADER_SAFE = /^[\x21-\x7e]{1,4096}$/;

function checkField(entry: IntegrationEntry, field: CredentialField, value: unknown): string {
  if (typeof value !== "string" || !HEADER_SAFE.test(value) || value.includes('"') || !fieldPattern(field).test(value)) {
    throw new ValidationError(`${field.label} is not a valid ${entry.displayName} value${field.hint ? `: ${field.hint}` : "."}`);
  }
  return value;
}

export function readCredentialInput(entry: IntegrationEntry, input: CredentialInput): ReadCredential {
  const auth = keyAuthOf(entry);
  if (!auth) throw new ValidationError(`${entry.displayName} is connected by signing in, not with a key.`);
  if (!usesFields(auth)) {
    if (input.fields !== undefined) throw new ValidationError(`${entry.displayName} is connected with one key: send it as apiKey.`);
    if (typeof input.apiKey !== "string") throw new ValidationError(`${entry.displayName} needs apiKey.`);
    return { stored: input.apiKey, accountHost: null };
  }
  if (input.apiKey !== undefined) {
    const names = [...(auth.account ? [auth.account.name] : []), ...(auth.fields ?? []).map((f) => f.name)];
    throw new ValidationError(`${entry.displayName} is connected with fields: send ${names.join(", ")} in fields, not apiKey.`);
  }
  const given = input.fields ?? {};
  const declared = new Set([...(auth.account ? [auth.account.name] : []), ...(auth.fields ?? []).map((f) => f.name)]);
  const extra = Object.keys(given).filter((name) => !declared.has(name));
  if (extra.length > 0) throw new ValidationError(`${entry.displayName} does not take ${extra.join(", ")}.`);
  const values: Record<string, string> = {};
  for (const field of auth.fields ?? []) values[field.name] = checkField(entry, field, given[field.name]);
  const accountHost = auth.account ? accountHostFor(entry, given[auth.account.name]) : null;
  return { stored: JSON.stringify({ fields: values }), accountHost };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined) throw new ValidationError(`The credential template names a field that is not declared: ${name}.`);
    return value;
  });
}

export interface ComposedCredential {
  value: string;
  redact: string[];
}

export function composeCredential(entry: IntegrationEntry, stored: string): ComposedCredential {
  const auth = keyAuthOf(entry);
  if (!auth || !usesFields(auth)) return { value: stored, redact: [] };
  let values: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stored) as { fields?: unknown };
    if (!parsed || typeof parsed.fields !== "object" || parsed.fields === null || Array.isArray(parsed.fields)) throw new Error("shape");
    values = parsed.fields as Record<string, unknown>;
  } catch {
    throw new ValidationError(`This ${entry.displayName} credential is not stored in the form it needs. Connect it again with its fields.`);
  }
  const checked: Record<string, string> = {};
  for (const field of auth.fields ?? []) checked[field.name] = checkField(entry, field, values[field.name]);
  const redact = (auth.fields ?? []).filter((f) => f.secret).map((f) => checked[f.name]);
  if (!auth.encoding) {
    const [only] = auth.fields ?? [];
    if (!only) throw new ValidationError(`${entry.displayName} declares no credential field.`);
    return { value: checked[only.name], redact };
  }
  if (auth.encoding.kind === "basic") {
    const pair = `${fill(auth.encoding.username, checked)}:${fill(auth.encoding.password, checked)}`;
    return { value: Buffer.from(pair, "utf8").toString("base64"), redact: [...redact, pair] };
  }
  return { value: fill(auth.encoding.template, checked), redact };
}

function keyView(auth: ApiKeyAuth) {
  const fields = usesFields(auth)
    ? [
        ...(auth.account ? [{ name: auth.account.name, label: auth.account.label, secret: false, kind: "account" as const, ...(auth.account.hint ? { hint: auth.account.hint } : {}) }] : []),
        ...(auth.fields ?? []).map((f) => ({ name: f.name, label: f.label, secret: f.secret, kind: "credential" as const, ...(f.hint ? { hint: f.hint } : {}) })),
      ]
    : null;
  return { instructions: auth.instructions, instructionsUrl: auth.instructionsUrl, ...(fields ? { fields } : {}) };
}

export function integrationView(entry: IntegrationEntry, options: { signIn?: boolean } = {}) {
  const key = keyAuthOf(entry);
  const signsIn = entry.auth.kind === "oauth" && (options.signIn ?? true);
  const auth = !signsIn && key
    ? { kind: "api_key" as const, ...keyView(key) }
    : { kind: "oauth" as const, ...(key ? { apiKey: keyView(key) } : {}) };
  return {
    id: entry.id,
    name: entry.displayName,
    auth,
    hosts: Array.isArray(entry.hosts) ? [...entry.hosts] : null,
    hostsFromAccount: !Array.isArray(entry.hosts),
    ...(accountHostTemplate(entry) ? { hostTemplate: (entry.hosts as { hostTemplate: string }).hostTemplate } : {}),
    scopes: auth.kind === "oauth" ? [...entry.scopes] : [],
    operationsPack: entry.operationsPack,
    workflowPacks: [...entry.workflowPacks],
  };
}
