import type { Finding, PostureTool, RemotePosture, RiskClass, ToolRisk } from "./types.ts";

export const MAX_POSTURE_TOOLS = 25;

const CHANGING: RiskClass[] = ["destructive", "irreversible", "write"];

export function postureTools(tools: Pick<ToolRisk, "tool" | "class">[]): NonNullable<RemotePosture["anonymousTools"]> {
  const counts: Record<RiskClass, number> = { read: 0, write: 0, irreversible: 0, destructive: 0 };
  for (const t of tools) counts[t.class]++;
  const changing = CHANGING.flatMap((c) => tools.filter((t) => t.class === c).map((t) => ({ tool: t.tool, class: t.class })));
  return { count: tools.length, counts, changing: changing.slice(0, MAX_POSTURE_TOOLS) };
}

export interface PostureFact {
  id: string;
  label: string;
  value: string;
}

export interface PostureChange {
  id: string;
  label: string;
  before: string | null;
  after: string | null;
}

const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? "not observed" : v ? "yes" : "no");

export function postureFacts(p: RemotePosture): PostureFact[] {
  const changing = p.anonymousTools ? CHANGING.reduce((n, c) => n + p.anonymousTools!.counts[c], 0) : 0;
  return [
    { id: "reachable", label: "Reachable", value: yesNo(p.reachable) },
    { id: "initialize-status", label: "HTTP status of an anonymous initialize", value: p.initializeStatus === null ? "none" : String(p.initializeStatus) },
    { id: "tools-list-anonymous", label: "tools/list served without credentials", value: yesNo(p.toolsListAnonymous) },
    { id: "changing-tools-anonymous", label: "Tools that change things, listed without credentials", value: String(changing) },
    { id: "protocol-version", label: "Protocol version", value: p.protocolVersion ?? "none" },
    { id: "www-authenticate", label: "WWW-Authenticate on 401", value: yesNo(p.wwwAuthenticate) },
    { id: "resource-metadata", label: "resource_metadata in WWW-Authenticate", value: p.resourceMetadataUrl ?? "none" },
    {
      id: "protected-resource",
      label: "RFC 9728 protected resource metadata",
      value: p.protectedResource ? p.protectedResource.url : "none",
    },
    {
      id: "authorization-servers",
      label: "Authorization servers",
      value: p.protectedResource?.authorizationServers.length ? [...p.protectedResource.authorizationServers].sort().join(", ") : "none",
    },
    { id: "legacy-sse", label: "Legacy HTTP+SSE transport", value: yesNo(p.legacySse) },
    { id: "dcr", label: "Dynamic client registration", value: p.registration?.metadataFound ? yesNo(p.registration.dcr) : "not observed" },
    { id: "cimd", label: "Client ID metadata documents", value: p.registration?.metadataFound ? yesNo(p.registration.cimd) : "not observed" },
  ];
}

export function postureChanges(before: RemotePosture | null, after: RemotePosture): PostureChange[] {
  const old = new Map((before ? postureFacts(before) : []).map((f) => [f.id, f.value]));
  const out: PostureChange[] = [];
  for (const f of postureFacts(after)) {
    const was = old.get(f.id) ?? null;
    if (was !== f.value) out.push({ id: f.id, label: f.label, before: was, after: f.value });
  }
  return out;
}

function names(list: PostureTool[], count: number): string {
  const shown = list.slice(0, 5).map((t) => `${t.tool} (${t.class})`);
  return `${shown.join(", ")}${count > shown.length ? ` and ${count - shown.length} more` : ""}`;
}

export function postureFindings(p: RemotePosture): Finding[] {
  const out: Finding[] = [];
  const tools = p.anonymousTools;
  if (p.toolsListAnonymous && tools) {
    const changing = CHANGING.reduce((n, c) => n + tools.counts[c], 0);
    if (changing > 0) {
      const parts = CHANGING.filter((c) => tools.counts[c] > 0).map((c) => `${tools.counts[c]} ${c}`);
      out.push({
        id: "unauth-remote-writes",
        severity: tools.counts.destructive + tools.counts.irreversible > 0 ? "high" : "warn",
        message: `The endpoint served tools/list without credentials, and the list has ${changing} tool${changing === 1 ? "" : "s"} that change${changing === 1 ? "s" : ""} things (${parts.join(", ")}). Whether a call also works without credentials was not tested: tools are never called.`,
        evidence: `${p.endpoint}: tools/list returned ${tools.count} tool${tools.count === 1 ? "" : "s"} to an anonymous client, including ${names(tools.changing, changing)}`,
      });
    }
  }
  if (p.authRequired && !p.resourceMetadataUrl && !p.protectedResource) {
    out.push({
      id: "remote-auth-metadata-missing",
      severity: "warn",
      message: `The endpoint asks for credentials (HTTP ${p.initializeStatus}) but publishes no RFC 9728 protected resource metadata: no resource_metadata in WWW-Authenticate and no document at /.well-known/oauth-protected-resource.`,
      evidence: `${p.endpoint}: initialize answered HTTP ${p.initializeStatus}, ${p.wwwAuthenticate ? "with" : "without"} a WWW-Authenticate header`,
    });
  }
  return out;
}
