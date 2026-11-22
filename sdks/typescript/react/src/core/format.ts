import { integrationName, integrationOfAction } from './integrations';
import type { Approval, ImpactQuantity } from './types';

/** `paymentIntent`, `payment_intent` → `Payment intent`. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The line a person reads first. A custom approval's own title; for an action, its name in words:
 * `github-create-issue` → `GitHub: Create issue`.
 */
export function approvalHeadline(approval: Pick<Approval, 'title' | 'actionName'>): string {
  const name = approval.actionName;
  if (!name) return approval.title;
  const integration = integrationOfAction(name);
  if (!integration) return humanizeKey(name);
  const rest = name.slice(integration.length + 1);
  return rest ? `${integrationName(integration)}: ${humanizeKey(rest)}` : integrationName(integration);
}

/** Money in minor units, e.g. 1250 usd → `$12.50`. */
export function formatMoney(amount: number, currency: string, locale?: string): string {
  const code = currency.toUpperCase();
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

const UNITS: Record<string, [string, string]> = {
  resource_mutations: ['change', 'changes'],
  emails: ['email', 'emails'],
};

/**
 * A declared unit's singular and plural. Units are named in the plural (`reminders`), so one of them
 * drops the final `s`: `1 reminder`, `2 reminders`. A unit that is not a plain plural stays as is.
 */
function unitWords(dimension: string): [string, string] {
  const many = humanizeKey(dimension).toLowerCase();
  return [/[^s]s$/.test(many) ? many.slice(0, -1) : many, many];
}

/** One impact quantity in words: `$12.50`, `Up to 3 emails`. */
export function formatImpact(quantity: ImpactQuantity, locale?: string): string {
  let text: string;
  if (quantity.dimension === 'money' && quantity.currency) {
    text = formatMoney(quantity.amount, quantity.currency, locale);
  } else {
    const [one, many] = UNITS[quantity.dimension] ?? unitWords(quantity.dimension);
    text = `${new Intl.NumberFormat(locale).format(quantity.amount)} ${quantity.amount === 1 ? one : many}`;
  }
  return quantity.bound === 'upper_bound' ? `Up to ${text}` : text;
}

/** A duration in words: `less than a minute`, `14 min`, `3 hours`, `2 days`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** `Expires in 14 min`, or `Expired`. */
export function formatExpiry(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  return left > 0 ? `Expires in ${formatDuration(left)}` : 'Expired';
}

/** `2 min ago`, `just now`. */
export function formatAgo(at: string, now: number): string {
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago) || ago < 60_000) return 'just now';
  return `${formatDuration(ago)} ago`;
}

/** A date and time in the reader's locale, for a `title` tooltip. */
export function formatDateTime(at: string, locale?: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A primitive input value as text; null for objects and arrays of objects, which are shown as JSON. */
export function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value) && value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
    return value.map((v) => formatValue(v)).join(', ');
  }
  return null;
}
