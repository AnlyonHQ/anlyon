export const WORKSPACE_ID: string;
export const ENVIRONMENTS: Record<'production' | 'staging', { id: string; slug: string; name: string }>;
export interface FakeState {
  accessTtlSeconds: number;
  apiDelayMs: number;
  dispatches: number;
  declared: { ref: string; body: Record<string, unknown> }[];
  invocations: Map<string, { id: string; status: string; approvalId: string | null; input?: unknown }>;
  approvals: Map<string, { id: string; status: string }>;
  accessTokens: Map<string, unknown>;
  environment: 'production' | 'staging';
  counts: { register: number; token: number; refresh: number; revoke: number; reuseDetected: number };
  requests: { method: string; path: string; query: Record<string, string>; headers: Record<string, string | string[] | undefined> }[];
  refreshTokens: Map<string, { revoked: boolean; familyId: string }>;
  connectSessions: Map<string, { sessionId: string; polls: number }>;
  keyConnects: Array<Record<string, unknown>>;
  checkAnswer: 'accepted' | 'rejected';
  checks: string[];
  reconnects: Array<{ secretName: string; apiKey?: string }>;
  secrets: Array<Record<string, unknown> & { name: string }>;
  actions: Record<string, unknown>[];
  policies?: Record<string, unknown>[];
  impactLimits: Record<string, unknown>[];
  mintedKeys: Array<{ id: string; name: string; scopes: string[]; environmentId: string; key: string }>;
  filePolicies: Map<string, { id: string; file: string; key: string; version: number; spec: Record<string, unknown> }>;
  budgets: Array<Record<string, unknown> & { apiKeyId: string }>;
  signOff: boolean;
  gateSignOffs: Map<string, { id: string; status: string; operation: string; signOffUrl: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpUpstreams: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastMcpRegistration?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastMcpAdoption?: any;
  changeMcpTool: (name: string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpListing: any[];
  autoApproveGate: boolean;
  plan: string;
  checkouts: Array<{ plan: string; interval: string }>;
  apiKeys: Map<string, { scopes: string[]; environment?: string; id?: string }>;
  signOffs: Map<string, { request: Record<string, unknown> & { id: string; status: string }; polls: number }>;
}
export interface FakeAnlyon {
  origin: string;
  state: FakeState;
  close(): Promise<void>;
}
export function startFakeAnlyon(options?: {
  accessTtlSeconds?: number;
  environment?: 'production' | 'staging';
  apiKeys?: Record<string, { scopes: string[]; environment?: 'production' | 'staging'; id?: string }>;
  denyConsent?: boolean;
  refreshDelayMs?: number;
  apiDelayMs?: number;
  consentAfterPolls?: number;
  checkAnswer?: 'accepted' | 'rejected';
  secrets?: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
  invokeBodies?: Record<string, string>;
  impactLimits?: Record<string, unknown>[];
  budgets?: Record<string, unknown>[];
  holdSignOffs?: boolean;
  plan?: string;
  signOff?: true | { decision?: 'applied' | 'rejected' | 'expired' | 'cancelled' | 'failed'; afterPolls?: number; note?: string };
  scopeFix?: boolean;
}): Promise<FakeAnlyon>;
export function completeBrowserLogin(url: string): Promise<{ status: number; location: string }>;
