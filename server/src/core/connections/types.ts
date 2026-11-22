export interface ConnectionRef {
  integrationKey: string;
  connectionId: string;
}

export interface ConnectionDetails extends ConnectionRef {
  tags: Record<string, string>;
  connectionConfig: Record<string, unknown>;
}

export interface ConsentSubject {
  endUserId: string;
  redirectUrl: string | null;
  confirm: boolean;
  flowId: string;
}

export interface ConsentSubjectResult extends ConsentSubject {
  workspaceId: string;
  environmentId: string;
  integrationKey: string;
  pendingUntil: Date | null;
}

export interface ConsentOutcome {
  operation: "creation" | "override";
  integrationKey: string;
  connectionId: string;
  endUserId: string;
  subject?: ConsentSubjectResult;
}

export type ConsentResult =
  | { ok: true; outcome: ConsentOutcome }
  | { ok: false; reason: "expired"; endUserId: null }
  | { ok: false; reason: "declined" | "provider_error"; endUserId: string; subject?: ConsentSubjectResult };

export interface ConsentPeek {
  integrationKey: string;
  workspaceId: string;
  environmentId: string;
  subject: ConsentSubject | null;
  ownApp: boolean;
  expiresAt: Date;
}

export interface ConnectionProvider {
  readonly id: "anlyon";
  supports(integrationKey: string): boolean;
  supportsIn(integrationKey: string, environmentId: string): Promise<boolean>;
  createConnectSession(input: {
    endUserId: string;
    integrationKey: string;
    subject?: ConsentSubject;
    ttlMs?: number;
  }): Promise<{ sessionToken: string; expiresAt: Date }>;
  createReconnectSession(input: { endUserId: string; integrationKey: string; connectionId: string }): Promise<{ sessionToken: string; expiresAt: Date }>;
  connectUrl(sessionToken: string): string;
  redirectUri(): string;
  clientMetadataUrl(): string;
  consentPageUrl(sessionToken: string): string;
  peekConsent(sessionToken: string): Promise<ConsentPeek | null>;
  beginConsent(sessionToken: string): Promise<string | null>;
  finishConsent(params: { state: string | null; code: string | null; error: string | null; iss?: string | null }): Promise<ConsentResult>;
  getConnection(ref: ConnectionRef): Promise<ConnectionDetails>;
  getAccessToken(ref: ConnectionRef, options?: { forceRefresh?: boolean }): Promise<string>;
  deleteConnection(ref: ConnectionRef): Promise<void>;
}

export class ConnectionRevokedError extends Error {
  constructor() {
    super("The connection can no longer produce a token.");
    this.name = "ConnectionRevokedError";
  }
}

export class ConnectionProviderFailure extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "ConnectionProviderFailure";
  }
}

export function endUserIdFor(workspaceId: string, environmentId: string, sessionId: string): string {
  return `ws_${workspaceId}:env_${environmentId}:${sessionId}`;
}

export function parseEndUserId(value: unknown): { workspaceId: string; environmentId: string; sessionId: string } | null {
  if (typeof value !== "string") return null;
  const m = /^ws_([0-9a-f-]{36}):env_([0-9a-f-]{36}):((?:csn|eul|mco)_[A-Za-z0-9]{8,64})$/.exec(value);
  return m ? { workspaceId: m[1], environmentId: m[2], sessionId: m[3] } : null;
}
