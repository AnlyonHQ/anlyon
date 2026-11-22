export type RiskClass = "read" | "write" | "irreversible" | "destructive";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

export interface Finding {
  id: string;
  severity: "info" | "warn" | "high";
  tool?: string;
  message: string;
  evidence?: string;
}

export type CapabilityTag = "private-data" | "untrusted-input" | "outbound";

export interface ToolTag {
  tag: CapabilityTag;
  reasons: string[];
}

export interface ToolRisk {
  tool: string;
  class: RiskClass;
  reasons: string[];
  tags: ToolTag[];
  findings: Finding[];
}

export interface ScanResult {
  version: 1;
  tools: ToolRisk[];
  serverFindings: Finding[];
  counts: Record<RiskClass, number>;
  hash: string;
}

export interface ScanOptions {
  serverName?: string;
  packageJson?: unknown;
}

export interface ToolsDiff {
  added: string[];
  removed: string[];
  changed: { tool: string; fields: string[] }[];
}

export interface ClaudeCodePermissions {
  permissions: { allow: string[]; ask: string[]; deny: string[] };
}

export interface ExfilTool {
  server: string;
  tool: string;
  rule: string;
}

export interface ExfilPath {
  privateData: ExfilTool;
  untrustedInput: ExfilTool;
  outbound: ExfilTool;
}

export interface ExfilReport {
  tools: Record<CapabilityTag, ExfilTool[]>;
  pathCount: number;
  paths: ExfilPath[];
  truncated: boolean;
  breakWith: { tag: CapabilityTag; tools: ExfilTool[] } | null;
}

export interface PostureTool {
  tool: string;
  class: RiskClass;
}

export interface RemotePosture {
  version: 1;
  endpoint: string;
  transport: "streamable-http" | "sse";
  reachable: boolean;
  initializeStatus: number | null;
  authRequired: boolean;
  toolsListAnonymous: boolean;
  protocolVersion: string | null;
  wwwAuthenticate: boolean | null;
  resourceMetadataUrl: string | null;
  protectedResource: { url: string; authorizationServers: string[] } | null;
  legacySse: boolean;
  registration: {
    authorizationServer: string;
    metadataFound: boolean;
    dcr: boolean;
    cimd: boolean;
  } | null;
  anonymousTools: { count: number; counts: Record<RiskClass, number>; changing: PostureTool[] } | null;
  error: string | null;
}

export interface MethodologyEntry {
  id: string;
  title: string;
  description: string;
}
