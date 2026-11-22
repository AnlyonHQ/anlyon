import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AnlyonProvider, type AnlyonProviderProps } from '../src/provider';
import type { Approval, Connection } from '../src/core/types';

export const BASE = 'https://api.test';

export function fakeToken(expSeconds: number, id = 'a'): string {
  const claims = Buffer.from(JSON.stringify({ v: 1, exp: expSeconds, jti: id })).toString('base64url');
  return `eus_v1.${claims}.sig-${id}`;
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const agoMinutes = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'apr_1',
    kind: 'action',
    status: 'pending',
    title: 'Run action "github-create-issue"',
    description: null,
    actionName: 'github-create-issue',
    input: { repo: 'acme/web', title: 'Fix login redirect', labels: ['bug', 'auth'] },
    preview: null,
    decisionNote: null,
    expiresAt: inMinutes(30),
    decidedAt: null,
    createdAt: agoMinutes(2),
    ...overrides,
  };
}

export function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    integration: 'github',
    displayName: 'GitHub',
    kind: 'oauth',
    status: 'active',
    scopes: ['repo'],
    connectedAt: agoMinutes(60 * 24 * 3),
    updatedAt: agoMinutes(60),
    ...overrides,
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
  token: string | null;
}

type Override = (call: Call) => { status: number; body: unknown } | undefined;

export function fakeApi(initial: { approvals?: Approval[]; connections?: Connection[] } = {}) {
  const state = {
    approvals: [...(initial.approvals ?? [])],
    connections: [...(initial.connections ?? [])],
  };
  const calls: Call[] = [];
  let override: Override | undefined;

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (status: number, code: string, message: string) => reply(status, { success: false, error: { code, message } });

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v2/end-user-session', '') + url.search;
    const auth = new Headers(init.headers).get('Authorization');
    const call: Call = {
      method: init.method ?? 'GET',
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      token: auth ? auth.replace(/^Bearer /, '') : null,
    };
    calls.push(call);
    const forced = override?.(call);
    if (forced) return reply(forced.status, forced.body);

    const { method } = call;
    if (method === 'GET' && url.pathname.endsWith('/connections')) return reply(200, { success: true, data: state.connections });
    if (method === 'POST' && url.pathname.endsWith('/connect-links')) {
      const { integration } = call.body as { integration: string };
      return reply(201, { success: true, data: { url: `https://connect.test/${integration}`, expiresAt: inMinutes(10), integration } });
    }
    const conn = /\/connections\/([^/]+)$/.exec(url.pathname);
    if (method === 'DELETE' && conn) {
      state.connections = state.connections.filter((c) => c.integration !== conn[1]);
      return reply(200, { success: true, data: { deleted: true } });
    }
    if (method === 'GET' && url.pathname.endsWith('/approvals')) {
      const status = url.searchParams.get('status');
      const list = state.approvals.filter((a) => !status || a.status === status);
      return reply(200, { success: true, data: list, pagination: { total: list.length, hasMore: false } });
    }
    const one = /\/approvals\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && one) {
      const found = state.approvals.find((a) => a.id === one[1]);
      return found ? reply(200, { success: true, data: found }) : fail(404, 'APPROVAL_NOT_FOUND', `Approval not found: ${one[1]}`);
    }
    const decide = /\/approvals\/([^/]+)\/decide$/.exec(url.pathname);
    if (method === 'POST' && decide) {
      const index = state.approvals.findIndex((a) => a.id === decide[1]);
      if (index < 0) return fail(404, 'APPROVAL_NOT_FOUND', 'Approval not found');
      const current = state.approvals[index];
      if (current.status !== 'pending') return fail(409, 'APPROVAL_ALREADY_DECIDED', `Approval ${current.id} is already ${current.status}`);
      const { decision, reason } = call.body as { decision: 'approve' | 'deny'; reason?: string };
      const next: Approval = {
        ...current,
        status: decision === 'approve' ? 'approved' : 'denied',
        decisionNote: reason ?? null,
        decidedAt: new Date().toISOString(),
      };
      state.approvals[index] = next;
      return reply(200, { success: true, data: { approval: next, ...(decision === 'approve' ? { result: { status: 'succeeded' } } : {}) } });
    }
    return fail(404, 'NOT_FOUND', 'No such route');
  };

  return {
    state,
    calls,
    fetch,
    setOverride(next: Override | undefined) {
      override = next;
    },
  };
}

export type FakeApi = ReturnType<typeof fakeApi>;

export function renderWithApi(ui: ReactElement, api: FakeApi, props: Partial<AnlyonProviderProps> = {}): RenderResult {
  globalThis.fetch = api.fetch as typeof fetch;
  return render(
    <AnlyonProvider baseUrl={BASE} getToken={async () => fakeToken(Math.floor(Date.now() / 1000) + 900)} {...props}>
      {ui}
    </AnlyonProvider>,
  );
}
