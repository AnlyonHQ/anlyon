import type { McpToolChange, McpToolChanges, McpToolSnapshot, McpUpstream } from "../../db/schema/mcp-upstreams.ts";

export const CHECK_LEASE_MS = 15 * 60_000;
export const BASE_BACKOFF_MS = 30 * 60_000;
export const MAX_BACKOFF_MS = 7 * 24 * 60 * 60_000;
export const JITTER = 0.1;
export const ADDED_SHOWN_FOR_MS = 14 * 24 * 60 * 60_000;
export const ALERT_RETRY_AFTER_MS = 10 * 60_000;
export const MAX_KEPT_DEFINITION_BYTES = 16 * 1024;
const MAX_KEPT_DEFINITIONS = 50;
const MAX_NAMES_IN_MESSAGE = 5;

export type ListingCredential = "operator" | "headers" | "anonymous" | "none";

export function listingCredential(upstream: Pick<McpUpstream, "oauth" | "operatorConnectionId" | "headers" | "listedWith">): ListingCredential {
  if (upstream.oauth) {
    if (upstream.operatorConnectionId) return "operator";
    return upstream.listedWith === "anonymous" ? "anonymous" : "none";
  }
  return Object.keys(upstream.headers).length > 0 ? "headers" : "anonymous";
}

export function nextCheckDelayMs(intervalMs: number, failures: number, random: () => number = Math.random): number {
  const base = failures <= 0 ? intervalMs : Math.min(BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 20), MAX_BACKOFF_MS);
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

export interface AdoptedPin {
  tool: string;
  action: string;
  actionId: string;
  toolHash: string;
}

export function changeKey(change: Pick<McpToolChange, "kind" | "tool" | "currentHash" | "pinnedHash">): string {
  switch (change.kind) {
    case "changed":
      return `changed:${change.tool}:${change.pinnedHash}:${change.currentHash}`;
    case "removed":
      return `removed:${change.tool}:${change.pinnedHash}`;
    case "added":
      return `added:${change.tool}`;
  }
}

function keepDefinition(definition: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!definition) return null;
  return Buffer.byteLength(JSON.stringify(definition)) <= MAX_KEPT_DEFINITION_BYTES ? definition : null;
}

export interface ListingDiff {
  changes: McpToolChanges | null;
  fresh: McpToolChange[];
  alert: McpToolChange[];
}

export function diffListing(input: {
  pins: readonly AdoptedPin[];
  previousTools: readonly McpToolSnapshot[];
  compareAdded: boolean;
  listed: readonly McpToolSnapshot[];
  stored: McpToolChanges | null;
  now: Date;
}): ListingDiff {
  const { pins, previousTools, compareAdded, listed, stored, now } = input;
  const at = now.toISOString();
  const listedByName = new Map(listed.map((tool) => [tool.name, tool]));
  const previousByName = new Map(previousTools.map((tool) => [tool.name, tool]));
  const storedByKey = new Map((stored?.items ?? []).map((item) => [changeKey(item), item]));
  const storedBefore = new Map((stored?.items ?? []).filter((item) => item.kind !== "added").map((item) => [`${item.tool}:${item.pinnedHash}`, item.before]));
  const pinned = new Set(pins.map((pin) => pin.tool));

  const items: McpToolChange[] = [];
  let kept = 0;
  const withBefore = (pin: AdoptedPin): Record<string, unknown> | null => {
    if (kept >= MAX_KEPT_DEFINITIONS) return null;
    const known = storedBefore.get(`${pin.tool}:${pin.toolHash}`);
    const previous = previousByName.get(pin.tool);
    const before = known ?? (previous?.hash === pin.toolHash ? keepDefinition(previous.definition) : null);
    if (before) kept++;
    return before;
  };
  for (const pin of pins) {
    const current = listedByName.get(pin.tool);
    if (current && current.hash === pin.toolHash) continue;
    const change: McpToolChange = {
      tool: pin.tool,
      kind: current ? "changed" : "removed",
      action: pin.action,
      actionId: pin.actionId,
      pinnedHash: pin.toolHash,
      currentHash: current?.hash ?? null,
      suggestedClass: current?.suggestedClass ?? null,
      before: withBefore(pin),
      detectedAt: at,
    };
    items.push({ ...change, detectedAt: storedByKey.get(changeKey(change))?.detectedAt ?? at });
  }
  const added = new Map<string, McpToolChange>();
  for (const item of stored?.items ?? []) {
    if (item.kind !== "added" || pinned.has(item.tool)) continue;
    const tool = listedByName.get(item.tool);
    if (!tool || now.getTime() - new Date(item.detectedAt).getTime() >= ADDED_SHOWN_FOR_MS) continue;
    added.set(item.tool, { ...item, currentHash: tool.hash, suggestedClass: tool.suggestedClass });
  }
  if (compareAdded) {
    for (const tool of listed) {
      if (pinned.has(tool.name) || previousByName.has(tool.name) || added.has(tool.name)) continue;
      added.set(tool.name, {
        tool: tool.name, kind: "added", action: null, actionId: null, pinnedHash: null, currentHash: tool.hash,
        suggestedClass: tool.suggestedClass, before: null, detectedAt: at,
      });
    }
  }
  items.push(...added.values());

  const fresh = items.filter((item) => !storedByKey.has(changeKey(item)));
  const pendingBefore = stored?.pending ?? {};
  const pending: Record<string, string> = {};
  for (const item of items) {
    const key = changeKey(item);
    const since = pendingBefore[key];
    if (since) pending[key] = since;
  }
  for (const item of fresh) pending[changeKey(item)] = at;
  const alert = items.filter((item) => {
    const since = pendingBefore[changeKey(item)];
    return fresh.includes(item) || (since !== undefined && now.getTime() - new Date(since).getTime() >= ALERT_RETRY_AFTER_MS);
  });
  return { changes: items.length > 0 ? { items, pending } : null, fresh, alert };
}

export function markAlerted(changes: McpToolChanges | null, sent: readonly McpToolChange[]): McpToolChanges | null {
  if (!changes) return null;
  const pending = { ...changes.pending };
  for (const item of sent) delete pending[changeKey(item)];
  return { ...changes, pending };
}

export function openChanges(
  changes: McpToolChanges | null,
  adopted: ReadonlyArray<{ tool: string; state: "current" | "changed" | "missing" }>,
): McpToolChange[] {
  const state = new Map(adopted.map((tool) => [tool.tool, tool.state]));
  return (changes?.items ?? []).filter((item) => {
    const now = state.get(item.tool);
    return item.kind === "added" ? now === undefined : now === "changed" || now === "missing";
  });
}

export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unnamed";
}

function namesIn(items: readonly McpToolChange[]): string {
  const names = items.slice(0, MAX_NAMES_IN_MESSAGE).map((item) => safeName(item.tool));
  const more = items.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

export interface ChangeAlert {
  title: string;
  message: string;
  priority: "high" | "medium";
  actionUrl: string;
  actionLabel: string;
  metadata: Record<string, unknown>;
}

export function changeAlert(
  upstream: { upstreamId: string; name: string; environmentId: string },
  environment: string,
  items: readonly McpToolChange[],
): ChangeAlert {
  const changed = items.filter((item) => item.kind === "changed");
  const removed = items.filter((item) => item.kind === "removed");
  const added = items.filter((item) => item.kind === "added");
  const blocked = changed.length + removed.length;
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

  const heads: string[] = [];
  if (changed.length === 1) heads.push(`${safeName(changed[0]!.tool)} changed`);
  else if (changed.length > 1) heads.push(`${changed.length} tools changed`);
  if (removed.length === 1) heads.push(`${safeName(removed[0]!.tool)} removed`);
  else if (removed.length > 1) heads.push(`${removed.length} tools removed`);
  if (added.length > 0) heads.push(`${added.length} new ${plural(added.length, "tool", "tools")}`);

  const lines: string[] = [];
  if (changed.length > 0) lines.push(`Changed since you adopted ${plural(changed.length, "it", "them")}: ${namesIn(changed)}.`);
  if (removed.length > 0) lines.push(`No longer listed: ${namesIn(removed)}.`);
  if (blocked > 0) lines.push(`Anlyon refuses calls to ${plural(blocked, "this tool", "these tools")} until someone reviews ${plural(blocked, "it", "them")} and re-adopts.`);
  if (added.length > 0) lines.push(`New on the server, not adopted, so no agent can reach ${plural(added.length, "it", "them")}: ${namesIn(added)}.`);
  lines.push(`Environment: ${safeName(environment)}.`);

  return {
    title: `MCP server ${upstream.name}: ${heads.join(", ")}`,
    message: lines.join(" "),
    priority: blocked > 0 ? "high" : "medium",
    actionUrl: `/mcp-servers/${upstream.name}${blocked > 0 ? "?filter=review" : ""}`,
    actionLabel: blocked > 0 ? "Review" : "See the tools",
    metadata: {
      kind: "mcp_tool_change",
      upstreamId: upstream.upstreamId,
      upstreamName: upstream.name,
      environmentId: upstream.environmentId,
      changed: changed.map((item) => safeName(item.tool)).slice(0, 50),
      removed: removed.map((item) => safeName(item.tool)).slice(0, 50),
      added: added.map((item) => safeName(item.tool)).slice(0, 50),
    },
  };
}
