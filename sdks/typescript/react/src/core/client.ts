import type { TokenSource } from './token';
import type { Approval, ApprovalDecision, ApprovalStatus, Connection, ConnectLink } from './types';

export const DEFAULT_BASE_URL = 'https://api.anlyon.com';

/** An answer the API refused, or one that never arrived. `message` is the API's own. */
export class AnlyonUIError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AnlyonUIError';
    this.status = status;
    this.code = code;
  }
}

/** Codes after which a new token is fetched and the request sent once more. */
const REFRESH_CODES = new Set(['END_USER_SESSION_EXPIRED', 'END_USER_SESSION_INVALID']);

export interface ApprovalPage {
  approvals: Approval[];
  total: number;
  hasMore: boolean;
}

/** The routes an end-user session token may call. */
export interface SessionClient {
  listConnections(): Promise<Connection[]>;
  createConnectLink(integration: string, redirectUrl?: string): Promise<ConnectLink>;
  deleteConnection(integration: string): Promise<void>;
  listApprovals(params?: { status?: ApprovalStatus; limit?: number }): Promise<ApprovalPage>;
  getApproval(approvalId: string): Promise<Approval>;
  decideApproval(approvalId: string, decision: 'approve' | 'deny', reason?: string): Promise<ApprovalDecision>;
}

export interface SessionClientOptions {
  baseUrl?: string;
  tokens: TokenSource;
  fetch?: typeof fetch;
}

interface Envelope<T> {
  success?: boolean;
  data?: T;
  pagination?: { total?: number; hasMore?: boolean };
  error?: { code?: string; message?: string };
}

export function createSessionClient(options: SessionClientOptions): SessionClient {
  const base = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/api/v2/end-user-session`;
  const doFetch = (input: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(input, init);

  async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<Envelope<T>> {
    let token: string;
    try {
      token = await options.tokens.get();
    } catch (error) {
      throw new AnlyonUIError(0, 'SESSION_UNAVAILABLE', "Couldn't start a session. Sign in again, then reload the page.", { cause: error });
    }
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new AnlyonUIError(0, 'NETWORK_ERROR', "Couldn't reach Anlyon. Check your connection and try again.");
    }
    let json: Envelope<T> = {};
    try {
      json = (await response.json()) as Envelope<T>;
    } catch {
    }
    if (response.ok) return json;
    const code = json.error?.code ?? `HTTP_${response.status}`;
    if (response.status === 401 && REFRESH_CODES.has(code) && !retried) {
      options.tokens.invalidate(token);
      return request<T>(method, path, body, true);
    }
    throw new AnlyonUIError(response.status, code, json.error?.message ?? `Anlyon answered ${response.status}.`);
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    async listConnections() {
      return (await request<Connection[]>('GET', '/connections')).data ?? [];
    },
    async createConnectLink(integration, redirectUrl) {
      const body = redirectUrl === undefined ? { integration } : { integration, redirectUrl };
      return (await request<ConnectLink>('POST', '/connect-links', body)).data as ConnectLink;
    },
    async deleteConnection(integration) {
      await request('DELETE', `/connections/${id(integration)}`);
    },
    async listApprovals(params = {}) {
      const query = new URLSearchParams();
      if (params.status) query.set('status', params.status);
      if (params.limit) query.set('limit', String(params.limit));
      const qs = query.toString();
      const json = await request<Approval[]>('GET', `/approvals${qs ? `?${qs}` : ''}`);
      const approvals = json.data ?? [];
      return { approvals, total: json.pagination?.total ?? approvals.length, hasMore: json.pagination?.hasMore ?? false };
    },
    async getApproval(approvalId) {
      return (await request<Approval>('GET', `/approvals/${id(approvalId)}`)).data as Approval;
    },
    async decideApproval(approvalId, decision, reason) {
      const body = reason ? { decision, reason } : { decision };
      return (await request<ApprovalDecision>('POST', `/approvals/${id(approvalId)}/decide`, body)).data as ApprovalDecision;
    },
  };
}
