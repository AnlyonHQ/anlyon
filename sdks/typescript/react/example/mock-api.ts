import type { Approval, Connection } from '../src/core/types';

export const API = 'https://api.example.test';

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const approvals: Approval[] = [
  {
    id: 'apr_reminder',
    kind: 'action',
    status: 'pending',
    title: 'Run action "e2e-reminder"',
    description: 'Set a reminder for you or your team.',
    actionName: 'e2e-reminder',
    input: { audience: 'team', text: 'Review the launch plan', when: 'Friday' },
    preview: {
      target: { account: null, display: {} },
      blocks: [],
      impact: [{ dimension: 'reminders', amount: 1, bound: 'exact' }],
      reversible: false,
      undo: "This can't be undone once it runs.",
      expiresAt: at(60 * 24),
    },
    decisionNote: null,
    expiresAt: at(60 * 24),
    decidedAt: null,
    createdAt: at(-1),
  },
  {
    id: 'apr_issue',
    kind: 'action',
    status: 'pending',
    title: 'Run action "github-create-issue"',
    description: null,
    actionName: 'github-create-issue',
    input: {
      repo: 'acme/web',
      title: 'Login redirect loops on Safari',
      body: 'Signing in with SSO on Safari 18 sends the user back to /login after the callback.\nSeen by 14 customers since Tuesday.',
      labels: ['bug', 'auth'],
    },
    preview: null,
    decisionNote: null,
    expiresAt: at(28),
    decidedAt: null,
    createdAt: at(-2),
  },
  {
    id: 'apr_refund',
    kind: 'action',
    status: 'pending',
    title: 'Run action "stripe-create-refund"',
    description: null,
    actionName: 'stripe-create-refund',
    input: { paymentIntent: 'pi_33wIcnawKfefYCfW', amount: 12900, currency: 'usd', reason: 'requested_by_customer' },
    preview: {
      target: { account: 'Acme Inc. (live mode)', display: {} },
      blocks: [
        {
          type: 'fields',
          title: 'Refund',
          fields: [
            { label: 'Payment intent', value: 'pi_33wIcnawKfefYCfW' },
            { label: 'Refund amount', value: '$129.00' },
            { label: 'Reason', value: 'Requested by customer' },
            { label: 'Refundable now', value: '$129.00' },
          ],
        },
      ],
      impact: [{ dimension: 'money', currency: 'usd', amount: 12900, bound: 'exact' }],
      reversible: false,
      undo: "This can't be undone once it runs.",
      expiresAt: at(4),
    },
    decisionNote: null,
    expiresAt: at(4),
    decidedAt: null,
    createdAt: at(-6),
  },
  {
    id: 'apr_slack',
    kind: 'action',
    status: 'approved',
    title: 'Run action "slack-post-message"',
    description: null,
    actionName: 'slack-post-message',
    input: { channel: '#launch', text: 'v2.4 is live. Changelog: acme.com/changelog' },
    preview: null,
    decisionNote: 'Ship it',
    expiresAt: at(20),
    decidedAt: at(-40),
    createdAt: at(-45),
  },
  {
    id: 'apr_gmail',
    kind: 'action',
    status: 'expired',
    title: 'Run action "gmail-send"',
    description: null,
    actionName: 'gmail-send',
    input: { to: 'dana@northwind.test', subject: 'Your renewal quote' },
    preview: null,
    decisionNote: null,
    expiresAt: at(-120),
    decidedAt: null,
    createdAt: at(-180),
  },
  {
    id: 'apr_report',
    kind: 'custom',
    status: 'denied',
    title: 'Send the weekly report to 12 customers',
    description: null,
    actionName: null,
    input: { recipients: 12, report: 'Weekly usage' },
    preview: null,
    decisionNote: 'Not before the numbers are checked.',
    expiresAt: at(-200),
    decidedAt: at(-300),
    createdAt: at(-320),
  },
  {
    id: 'apr_file',
    kind: 'action',
    status: 'pending',
    title: 'Run action "github-update-file"',
    description: 'Update the pricing page for the new Team plan.',
    actionName: 'github-update-file',
    input: { repo: 'acme/site', path: 'docs/pricing.md', branch: 'main' },
    preview: {
      target: { account: 'acme', display: { repository: 'acme/site', branch: 'main' } },
      blocks: [
        {
          type: 'text_diff',
          title: 'Change',
          path: 'docs/pricing.md',
          before: '# Pricing\n\nAll plans include unlimited projects.\n\n| Plan | Price |\n| --- | --- |\n| Starter | $19 |\n| Pro | $49 |\n\nQuestions? Email sales@acme.com.',
          after: '# Pricing\n\nAll plans include unlimited projects.\n\n| Plan | Price |\n| --- | --- |\n| Starter | $19 |\n| Pro | $49 |\n| Team | $199 |\n\nQuestions? Email sales@acme.com.',
          truncated: false,
        },
      ],
      impact: [{ dimension: 'resource_mutations', amount: 1, bound: 'exact' }],
      reversible: true,
      undo: 'This can be undone later.',
      expiresAt: at(55),
    },
    decisionNote: null,
    expiresAt: at(55),
    decidedAt: null,
    createdAt: at(-1),
  },
  {
    id: 'apr_hang',
    kind: 'action',
    status: 'pending',
    title: 'Run action "linear-create-issue"',
    description: null,
    actionName: 'linear-create-issue',
    input: { team: 'Platform', title: 'Rotate the staging database password' },
    preview: null,
    decisionNote: null,
    expiresAt: at(45),
    decidedAt: null,
    createdAt: at(-3),
  },
  {
    id: 'apr_fail',
    kind: 'action',
    status: 'pending',
    title: 'Run action "hubspot-update-deal"',
    description: null,
    actionName: 'hubspot-update-deal',
    input: { deal: 'Northwind renewal', stage: 'Closed won', amount: '$24,000' },
    preview: null,
    decisionNote: null,
    expiresAt: at(15),
    decidedAt: null,
    createdAt: at(-4),
  },
];

const connections: Connection[] = [
  { integration: 'github', displayName: 'GitHub', kind: 'oauth', status: 'active', scopes: ['repo'], connectedAt: at(-60 * 24 * 12), updatedAt: at(-60) },
  { integration: 'slack', displayName: 'Slack', kind: 'oauth', status: 'needs_reconnect', scopes: ['chat:write'], connectedAt: at(-60 * 24 * 40), updatedAt: at(-60 * 5) },
  { integration: 'linear', displayName: 'Linear', kind: 'oauth', status: 'active', scopes: ['write'], connectedAt: at(-60 * 3), updatedAt: at(-60 * 3) },
  { integration: 'stripe', displayName: 'Stripe', kind: 'api_key', status: 'active', scopes: [], connectedAt: at(-60 * 24 * 2), updatedAt: at(-60 * 24 * 2) },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function installMockApi() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== API) return realFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const path = url.pathname.replace('/api/v2/end-user-session', '');
    const method = init.method ?? 'GET';

    if (method === 'GET' && path === '/connections') return json(200, { success: true, data: connections });
    if (method === 'POST' && path === '/connect-links') {
      const { integration } = JSON.parse(String(init.body)) as { integration: string };
      return json(201, { success: true, data: { url: `${API}/connect/${integration}`, expiresAt: at(10), integration } });
    }
    const disconnect = /^\/connections\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && disconnect) {
      const index = connections.findIndex((c) => c.integration === disconnect[1]);
      if (index === -1) return json(404, { success: false, error: { code: 'CONNECTION_NOT_FOUND', message: 'Not connected' } });
      connections.splice(index, 1);
      return json(200, { success: true, data: { deleted: true } });
    }
    if (method === 'GET' && path === '/approvals') {
      const status = url.searchParams.get('status');
      const list = approvals.filter((a) => !status || a.status === status);
      return json(200, { success: true, data: list, pagination: { total: list.length, hasMore: false } });
    }
    const one = /^\/approvals\/([^/]+)$/.exec(path);
    if (method === 'GET' && one) {
      const found = approvals.find((a) => a.id === one[1]);
      return found ? json(200, { success: true, data: found }) : json(404, { success: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found' } });
    }
    const decide = /^\/approvals\/([^/]+)\/decide$/.exec(path);
    if (method === 'POST' && decide) {
      if (decide[1] === 'apr_hang') return new Promise<Response>(() => {});
      if (decide[1] === 'apr_fail') {
        return json(502, { success: false, error: { code: 'PROVIDER_UNAVAILABLE', message: "HubSpot didn't answer, so nothing changed. Try again in a minute." } });
      }
      const found = approvals.find((a) => a.id === decide[1])!;
      const { decision, reason } = JSON.parse(String(init.body)) as { decision: string; reason?: string };
      Object.assign(found, { status: decision === 'approve' ? 'approved' : 'denied', decisionNote: reason ?? null, decidedAt: new Date().toISOString() });
      return json(200, { success: true, data: { approval: found, ...(decision === 'approve' ? { result: { status: 'succeeded' } } : {}) } });
    }
    return json(404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  };

  window.open = () => ({ closed: false, location: { href: '' }, focus() {}, close() {} }) as unknown as Window;
}

export function mockToken() {
  const claims = btoa(JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + 900 })).replace(/=+$/, '');
  return { token: `eus_v1.${claims}.mock`, expiresAt: at(15) };
}
