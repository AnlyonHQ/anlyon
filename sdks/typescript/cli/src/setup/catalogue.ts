import airtable from '../../../../../packs/airtable/pack.json';
import asana from '../../../../../packs/asana/pack.json';
import attio from '../../../../../packs/attio/pack.json';
import calcom from '../../../../../packs/calcom/pack.json';
import calendly from '../../../../../packs/calendly/pack.json';
import clickup from '../../../../../packs/clickup/pack.json';
import close from '../../../../../packs/close/pack.json';
import discord from '../../../../../packs/discord/pack.json';
import front from '../../../../../packs/front/pack.json';
import github from '../../../../../packs/github/pack.json';
import gitlab from '../../../../../packs/gitlab/pack.json';
import gmail from '../../../../../packs/gmail/pack.json';
import googleCalendar from '../../../../../packs/google-calendar/pack.json';
import hubspot from '../../../../../packs/hubspot/pack.json';
import intercom from '../../../../../packs/intercom/pack.json';
import jira from '../../../../../packs/jira/pack.json';
import linear from '../../../../../packs/linear/pack.json';
import linearKey from '../../../../../packs/linear-key/pack.json';
import mailchimp from '../../../../../packs/mailchimp/pack.json';
import monday from '../../../../../packs/monday/pack.json';
import notion from '../../../../../packs/notion/pack.json';
import outboundSales from '../../../../../packs/outbound-sales/pack.json';
import pagerduty from '../../../../../packs/pagerduty/pack.json';
import pipedrive from '../../../../../packs/pipedrive/pack.json';
import postmark from '../../../../../packs/postmark/pack.json';
import resend from '../../../../../packs/resend/pack.json';
import sendgrid from '../../../../../packs/sendgrid/pack.json';
import sentry from '../../../../../packs/sentry/pack.json';
import slack from '../../../../../packs/slack/pack.json';
import stripe from '../../../../../packs/stripe/pack.json';
import supportRefunds from '../../../../../packs/support-refunds/pack.json';
import todoist from '../../../../../packs/todoist/pack.json';
import trello from '../../../../../packs/trello/pack.json';
import twilio from '../../../../../packs/twilio/pack.json';
import vercel from '../../../../../packs/vercel/pack.json';
import zendesk from '../../../../../packs/zendesk/pack.json';

/** Each bundled manifest by the pack's short name: `github` for `anlyon/github`. */
export const CATALOGUE_PACKS: Readonly<Record<string, unknown>> = {
  'airtable': airtable,
  'asana': asana,
  'attio': attio,
  'calcom': calcom,
  'calendly': calendly,
  'clickup': clickup,
  'close': close,
  'discord': discord,
  'front': front,
  'github': github,
  'gitlab': gitlab,
  'gmail': gmail,
  'google-calendar': googleCalendar,
  'hubspot': hubspot,
  'intercom': intercom,
  'jira': jira,
  'linear': linear,
  'linear-key': linearKey,
  'mailchimp': mailchimp,
  'monday': monday,
  'notion': notion,
  'outbound-sales': outboundSales,
  'pagerduty': pagerduty,
  'pipedrive': pipedrive,
  'postmark': postmark,
  'resend': resend,
  'sendgrid': sendgrid,
  'sentry': sentry,
  'slack': slack,
  'stripe': stripe,
  'support-refunds': supportRefunds,
  'todoist': todoist,
  'trello': trello,
  'twilio': twilio,
  'vercel': vercel,
  'zendesk': zendesk,
};

/** A bundled manifest by `github` or `anlyon/github`, or undefined. */
export function catalogueManifest(name: string): unknown {
  const short = name.startsWith('anlyon/') ? name.slice('anlyon/'.length) : name;
  return Object.prototype.hasOwnProperty.call(CATALOGUE_PACKS, short) ? CATALOGUE_PACKS[short] : undefined;
}

/** Resolves `ref: "anlyon/hubspot#add-note"` in a workflow pack against the bundled catalogue. */
export async function resolveCataloguePack(pack: string): Promise<unknown> {
  return catalogueManifest(pack);
}
