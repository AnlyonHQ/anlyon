/** Names for people, by catalogue id. A connection carries its own `displayName`; this covers the rest. */
const NAMES: Record<string, string> = {
  airtable: 'Airtable',
  asana: 'Asana',
  attio: 'Attio',
  calcom: 'Cal.com',
  calendly: 'Calendly',
  clickup: 'ClickUp',
  close: 'Close',
  discord: 'Discord',
  front: 'Front',
  github: 'GitHub',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  hubspot: 'HubSpot',
  intercom: 'Intercom',
  jira: 'Jira',
  linear: 'Linear',
  'linear-key': 'Linear',
  mailchimp: 'Mailchimp',
  monday: 'monday.com',
  notion: 'Notion',
  pagerduty: 'PagerDuty',
  pipedrive: 'Pipedrive',
  postmark: 'Postmark',
  resend: 'Resend',
  salesforce: 'Salesforce',
  sendgrid: 'SendGrid',
  sentry: 'Sentry',
  slack: 'Slack',
  stripe: 'Stripe',
  todoist: 'Todoist',
  trello: 'Trello',
  twilio: 'Twilio',
  vercel: 'Vercel',
  zendesk: 'Zendesk',
};

/** `github` → `GitHub`. An id not in the catalogue is title-cased. */
export function integrationName(id: string): string {
  return NAMES[id] ?? id.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The id's catalogue prefix in an action name, e.g. `github` in `github-create-issue`. */
export function integrationOfAction(actionName: string): string | null {
  let best: string | null = null;
  for (const id of Object.keys(NAMES)) {
    if ((actionName === id || actionName.startsWith(`${id}-`)) && (best === null || id.length > best.length)) best = id;
  }
  return best;
}
