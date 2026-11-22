import { apiRequest } from '../api';
import { parseDuration } from '../args';
import { connect } from '../context';
import { CliError, toCliError, withHint } from '../errors';
import { EXIT } from '../exit-codes';
import type { Runtime } from '../runtime';
import type { CommandSpec } from './types';

/**
 * `anlyon billing status` and `anlyon billing upgrade`. Payment itself happens on the checkout
 * page of the merchant of record: the CLI only asks for the link and, with --wait, notices when the
 * plan changes. No card or billing detail passes through it.
 */

export const PLAN_CHOICES = ['starter', 'production', 'growth'] as const;
const PLAN_NAMES: Record<string, string> = { free: 'Free', starter: 'Starter', production: 'Pro', growth: 'Team', paygo: 'Pay as you go', enterprise: 'Enterprise' };
const POLL_MS = 3_000;

const planName = (plan: string | null | undefined) => (plan ? PLAN_NAMES[plan] ?? plan : 'unknown');

interface PlanView {
  plan: string;
  pendingPlan?: string | null;
  access?: { paidPlansAvailable?: boolean; mode?: string };
  subscription?: { status: string | null; hasSubscription: boolean; trialEndsAt: string | null };
}

interface QuotaView {
  actionInvokes?: { usedUnits: number; includedUnits: number | null; reservedUnits?: number };
  projectedOverageCents?: number;
}

function sleep(rt: Runtime, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    rt.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CliError('CANCELLED', 'Cancelled.', EXIT.CANCELLED));
    }, { once: true });
  });
}

const status: CommandSpec = {
  path: ['billing', 'status'],
  summary: "Show the workspace's plan and this month's usage.",
  async run(ctx) {
    const connection = await connect(ctx.globals, ctx.rt);
    const [plan, quota] = await Promise.all([
      apiRequest<PlanView>(ctx.rt, connection, 'GET', '/api/v2/billing/plan').then((r) => r.data),
      apiRequest<QuotaView>(ctx.rt, connection, 'GET', '/api/v2/billing/quota').then((r) => r.data).catch(() => undefined),
    ]);
    const invokes = quota?.actionInvokes;
    const data = {
      plan: plan.plan,
      planName: planName(plan.plan),
      pendingPlan: plan.pendingPlan ?? null,
      subscription: plan.subscription?.status ?? null,
      paidPlansAvailable: plan.access?.paidPlansAvailable ?? null,
      usage: invokes ? { actionInvokes: invokes.usedUnits, included: invokes.includedUnits } : null,
    };
    if (ctx.out.json) {
      ctx.out.result({ data });
      return;
    }
    ctx.out.fields([
      ['plan', `${data.planName} (${data.plan})`],
      ['pending', data.pendingPlan ? `${planName(data.pendingPlan)} at the end of the period` : undefined],
      ['subscription', data.subscription ?? 'none'],
      ['action calls', invokes ? `${invokes.usedUnits}${invokes.includedUnits === null ? '' : ` of ${invokes.includedUnits} included`} this month` : undefined],
    ]);
    if (plan.plan === 'free') ctx.out.info('Upgrade: anlyon billing upgrade --plan starter (opens the checkout page).');
  },
};

const upgrade: CommandSpec = {
  path: ['billing', 'upgrade'],
  summary: 'Get the checkout link for a paid plan and open it. Payment happens on the checkout page, never in the terminal.',
  timeoutFor: (options) => (typeof options.wait === 'string' ? parseDuration(options.wait) + 60_000 : undefined),
  options: {
    plan: { type: 'string', choices: PLAN_CHOICES, description: 'starter (Starter), production (Pro) or growth (Team).' },
    interval: { type: 'string', choices: ['month', 'year'], description: 'Billed monthly (default) or yearly.' },
    wait: { type: 'string', description: 'Wait this long (e.g. 10m) for the payment to finish, then show the new plan.' },
    'no-browser': { type: 'boolean', description: 'Print the link without opening a browser.' },
  },
  async run(ctx) {
    const plan = typeof ctx.options.plan === 'string' ? ctx.options.plan : undefined;
    if (!plan) throw new CliError('USAGE', 'Choose a plan: --plan starter, production or growth.', EXIT.USAGE, { hint: 'Compare plans at https://anlyon.com/pricing.' });
    const interval = typeof ctx.options.interval === 'string' ? ctx.options.interval : 'month';
    const waitMs = typeof ctx.options.wait === 'string' ? parseDuration(ctx.options.wait) : undefined;
    const connection = await connect(ctx.globals, ctx.rt);
    if (connection.target.authType === 'api_key') {
      throw new CliError('LOGIN_REQUIRED', 'An API key cannot start a purchase. Log in as yourself first.', EXIT.PERMISSION_DENIED, { hint: 'Run `anlyon auth login`, then `anlyon billing upgrade` again.' });
    }
    let checkoutUrl: string;
    try {
      checkoutUrl = (await apiRequest<{ checkoutUrl: string }>(ctx.rt, connection, 'POST', '/api/v2/billing/checkout', { plan, interval })).data.checkoutUrl;
    } catch (error) {
      const failure = toCliError(error, ctx.rt.abortState);
      if (failure.code === 'SUBSCRIPTION_EXISTS') throw withHint(failure, 'This workspace already has a subscription. Change its plan under Billing in the console.');
      if (failure.code === 'PAID_PLANS_UNAVAILABLE') throw withHint(failure, 'Paid plans are not on sale for this workspace yet.');
      throw failure;
    }
    const noBrowser = ctx.options['no-browser'] === true || ctx.globals.noInput || ctx.rt.env.ANLYON_NO_BROWSER === '1';
    if (!ctx.out.json) {
      ctx.out.info(`Checkout for ${planName(plan)}, billed ${interval === 'year' ? 'yearly' : 'monthly'}. Pay on this page:`);
      ctx.out.line(checkoutUrl);
    }
    if (!noBrowser) ctx.rt.openBrowser(checkoutUrl);
    if (waitMs === undefined) {
      if (ctx.out.json) ctx.out.result({ data: { plan, interval, checkoutUrl, status: 'checkout_open' } });
      return;
    }
    ctx.out.info('Waiting for the payment to finish (Ctrl-C to stop waiting)…');
    const deadline = Date.now() + waitMs;
    while (Date.now() + POLL_MS <= deadline) {
      await sleep(ctx.rt, POLL_MS);
      const current = (await apiRequest<PlanView>(ctx.rt, connection, 'GET', '/api/v2/billing/plan')).data;
      if (current.plan === plan) {
        if (ctx.out.json) ctx.out.result({ data: { plan, interval, checkoutUrl, status: 'active' } });
        else ctx.out.line(`You are on ${planName(plan)}.`);
        return;
      }
    }
    if (ctx.out.json) ctx.out.result({ data: { plan, interval, checkoutUrl, status: 'checkout_open' } });
    else ctx.out.info('The plan has not changed yet. Check later with anlyon billing status.');
    return EXIT.TIMEOUT;
  },
};

export const billingCommands: CommandSpec[] = [status, upgrade];
