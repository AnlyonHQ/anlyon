export type ChangeDirection = "tightening" | "loosening" | "neutral";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  direction: ChangeDirection;
  reason: string;
}

export interface Classification {
  direction: "tightening" | "loosening";
  changes: FieldChange[];
}

export const GOVERNANCE_OPERATIONS = [
  "policy.create",
  "policy.update",
  "policy.delete",
  "policy_file.apply",
  "impact_limit.create",
  "impact_limit.update",
  "impact_limit.archive",
  "budget.put",
  "budget.delete",
  "environment.halt",
  "environment.resume",
  "action.create",
  "action.update",
  "action.delete",
  "action.import",
  "secret.put",
  "secret.delete",
  "secret_store.create",
  "secret_store.update",
  "secret_store.delete",
  "secret_store_settings.update",
  "oauth_app.put",
  "oauth_app.delete",
  "api_key.create",
  "environment.update",
  "workspace_defaults.update",
  "mcp_upstream.register",
  "mcp_upstream.refresh",
  "mcp_upstream.adopt",
  "mcp_upstream.archive",
  "mcp_upstream.connect",
] as const;

export type GovernanceOperation = (typeof GOVERNANCE_OPERATIONS)[number];

export const REDACTED = "(hidden)";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function classification(changes: FieldChange[]): Classification {
  return { direction: changes.some((c) => c.direction === "loosening") ? "loosening" : "tightening", changes };
}

export type FieldRule<V = unknown> = (from: V, to: V) => { direction: ChangeDirection; reason: string };

export type FieldRules<T> = { [K in keyof Required<T>]: FieldRule };

export const neutral = (reason: string): FieldRule => () => ({ direction: "neutral", reason });
export const loosens = (reason: string): FieldRule => () => ({ direction: "loosening", reason });

export const cap = (what: string): FieldRule => (from, to) => {
  const a = typeof from === "number" ? from : null;
  const b = typeof to === "number" ? to : null;
  if (b === null && a !== null) return { direction: "loosening", reason: `Removes the ${what}.` };
  if (a === null && b !== null) return { direction: "tightening", reason: `Adds a ${what}.` };
  if (a !== null && b !== null && b > a) return { direction: "loosening", reason: `Raises the ${what}.` };
  if (a !== null && b !== null && b < a) return { direction: "tightening", reason: `Lowers the ${what}.` };
  return { direction: "neutral", reason: `Leaves the ${what} as it is.` };
};

export const guardedWhen = (guarded: unknown, tighten: string, loosen: string): FieldRule => (_from, to) =>
  same(to, guarded) ? { direction: "tightening", reason: tighten } : { direction: "loosening", reason: loosen };

export const declaration = (what: string): FieldRule => (from, to) => {
  if ((from === null || from === undefined) && to !== null && to !== undefined) {
    return { direction: "tightening", reason: `Adds ${what}.` };
  }
  if (to === null || to === undefined) return { direction: "loosening", reason: `Removes ${what}.` };
  return { direction: "loosening", reason: `Changes ${what}; a different one can count or check less.` };
};

export function classifyFields<T extends object>(
  rules: FieldRules<T>,
  before: Partial<Record<keyof T, unknown>>,
  patch: Partial<T>,
  options: { ignore?: readonly string[] } = {},
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, to] of Object.entries(patch as Record<string, unknown>)) {
    if (to === undefined || options.ignore?.includes(field)) continue;
    const from = (before as Record<string, unknown>)[field];
    if (same(from, to)) continue;
    const rule = (rules as Record<string, FieldRule | undefined>)[field];
    if (!rule) {
      changes.push({ field, from, to, direction: "loosening", reason: "This field is not classified, so it counts as loosening." });
      continue;
    }
    changes.push({ field, from, to, ...rule(from, to) });
  }
  return changes;
}

export function hostCovers(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (!p.startsWith(".")) return false;
  const bare = p.slice(1);
  return h === bare || h.endsWith(p) || (h.startsWith(".") && h.slice(1).endsWith(p));
}

function hostsWithin(inner: string[] | null, outer: string[] | null): boolean {
  if (outer === null) return true;
  if (inner === null) return false;
  return inner.every((h) => outer.some((p) => hostCovers(p, h)));
}

export const hostList: FieldRule = (from, to) => {
  const a = Array.isArray(from) ? (from as string[]) : null;
  const b = Array.isArray(to) ? (to as string[]) : null;
  if (hostsWithin(b, a)) return { direction: "tightening", reason: "Narrows the hosts it may be sent to." };
  return {
    direction: "loosening",
    reason: b === null ? "Lets it be sent to any public host." : "Widens the hosts it may be sent to.",
  };
};

export const placementList: FieldRule = (from, to) => {
  const a = Array.isArray(from) ? (from as string[]) : null;
  const b = Array.isArray(to) ? (to as string[]) : null;
  const within = a === null || (b !== null && b.every((p) => a.includes(p)));
  return within
    ? { direction: "tightening", reason: "Narrows where in a request it may appear." }
    : { direction: "loosening", reason: "Widens where in a request it may appear." };
};

export interface ImpactLimitPatch {
  name?: string;
  amount?: number;
}

export const IMPACT_LIMIT_UPDATE_RULES: FieldRules<ImpactLimitPatch> = {
  name: neutral("Renames the limit."),
  amount: cap("limit"),
};

export function classifyImpactLimitCreate(input: { name: string; amount: number }): Classification {
  return classification([{
    field: "limit", from: null, to: { name: input.name, amount: input.amount },
    direction: "tightening", reason: "Adds a limit. Every applicable limit must have room before an effect dispatches.",
  }]);
}

export function classifyImpactLimitUpdate(before: { name: string; amount: number; archived: boolean }, patch: ImpactLimitPatch): Classification {
  return classification(classifyFields(IMPACT_LIMIT_UPDATE_RULES, before, patch));
}

export function classifyImpactLimitArchive(before: { name: string; amount: number; archived: boolean }): Classification {
  if (before.archived) return classification([]);
  return classification([{
    field: "limit", from: { name: before.name, amount: before.amount }, to: null,
    direction: "loosening", reason: "Removes a limit: effects it counted are no longer capped by it.",
  }]);
}

export interface BudgetPatch {
  monthlyCostCentsCap?: number | null;
  dimensionCaps?: Record<string, number>;
  alertThreshold?: number;
  enabled?: boolean;
}

export interface BudgetState {
  monthlyCostCentsCap: number | null;
  dimensionCaps: Record<string, number>;
  alertThreshold: number;
  enabled: boolean;
}

const dimensionCaps: FieldRule = (from, to) => {
  const a = (from ?? {}) as Record<string, number>;
  const b = (to ?? {}) as Record<string, number>;
  const loosened = Object.keys(a).filter((d) => b[d] === undefined || b[d] > a[d]);
  if (loosened.length) return { direction: "loosening", reason: `Raises or removes the cap on ${loosened.join(", ")}.` };
  return { direction: "tightening", reason: "Adds or lowers per-dimension caps." };
};

export const BUDGET_PUT_RULES: FieldRules<BudgetPatch> = {
  monthlyCostCentsCap: cap("monthly cost cap"),
  dimensionCaps,
  alertThreshold: (from, to) => (Number(to) > Number(from)
    ? { direction: "loosening", reason: "Alerts later, when more of the budget is spent." }
    : { direction: "tightening", reason: "Alerts earlier." }),
  enabled: guardedWhen(true, "Turns the budget on.", "Turns the budget off: the key is no longer capped."),
};

const NO_BUDGET: BudgetState = { monthlyCostCentsCap: null, dimensionCaps: {}, alertThreshold: 1, enabled: false };

export function classifyBudgetPut(before: BudgetState | null, patch: BudgetPatch): Classification {
  const base = before ?? NO_BUDGET;
  const effective = before ? patch : { enabled: true, ...patch };
  return classification(classifyFields(BUDGET_PUT_RULES, base, effective));
}

export function classifyBudgetDelete(before: BudgetState | null): Classification {
  if (!before || !before.enabled) return classification([]);
  return classification([{
    field: "budget", from: before, to: null,
    direction: "loosening", reason: "Removes the key's budget: it is no longer capped.",
  }]);
}

export function classifyHalt(before: { halted: boolean }): Classification {
  if (before.halted) return classification([]);
  return classification([{ field: "halted", from: false, to: true, direction: "tightening", reason: "Halts the environment: agents stop acting." }]);
}

export function classifyResume(before: { halted: boolean }): Classification {
  if (!before.halted) return classification([]);
  return classification([{
    field: "halted", from: true, to: false,
    direction: "loosening", reason: "Resumes a halted environment: deferred work proceeds and agents act again.",
  }]);
}

export type PolicyEffect = "require_approval" | "auto_approve" | "auto_deny";

export interface PolicyOutcome {
  effect: PolicyEffect;
  requiredApprovals: number;
  decidedBy: "team" | "end_user";
}

export interface PolicyState extends PolicyOutcome {
  policyId: string;
  name: string;
  priority: number;
  enabled: boolean;
  createdAt: number;
  matchKind: "any" | "action" | "custom";
  matchActionName: string | null;
  matchAgentId: string | null;
  matchUserId: string | null;
  matchTags: string[] | null;
  minAmount: number | null;
  conditions: Record<string, unknown> | null;
  condition: string | null;
}

export function atLeastAsStrict(a: PolicyOutcome, b: PolicyOutcome): boolean {
  if (a.effect === "auto_deny") return true;
  if (b.effect === "auto_deny") return false;
  if (b.effect === "auto_approve") return true;
  if (a.effect === "auto_approve") return false;
  return a.decidedBy === b.decidedBy && a.requiredApprovals >= b.requiredApprovals;
}

const FLAG_FLOOR: PolicyOutcome = { effect: "require_approval", requiredApprovals: 1, decidedBy: "team" };

const sortKey = (p: Pick<PolicyState, "priority" | "createdAt" | "policyId">) => [p.priority, p.createdAt, p.policyId] as const;
function evaluatedBefore(a: Pick<PolicyState, "priority" | "createdAt" | "policyId">, b: Pick<PolicyState, "priority" | "createdAt" | "policyId">): boolean {
  const [ap, ac, ai] = sortKey(a);
  const [bp, bc, bi] = sortKey(b);
  return ap !== bp ? ap < bp : ac !== bc ? ac < bc : ai < bi;
}

function weakerThanSomethingItShadows(p: PolicyState, others: readonly PolicyState[]): PolicyState | "flag" | null {
  if (!atLeastAsStrict(p, FLAG_FLOOR)) return "flag";
  for (const q of others) {
    if (q.policyId === p.policyId || !q.enabled) continue;
    if (evaluatedBefore(p, q) && !atLeastAsStrict(p, q)) return q;
  }
  return null;
}

function describeOutcome(o: PolicyOutcome): string {
  if (o.effect !== "require_approval") return o.effect;
  return `require_approval (${o.requiredApprovals}, ${o.decidedBy})`;
}

function insertion(p: PolicyState, others: readonly PolicyState[], verb: string): FieldChange {
  const shadowed = weakerThanSomethingItShadows(p, others);
  if (!shadowed) {
    return { field: "policy", from: null, to: describeOutcome(p), direction: "tightening", reason: `${verb} a policy at least as strict as anything it can take precedence over.` };
  }
  return {
    field: "policy", from: null, to: describeOutcome(p), direction: "loosening",
    reason: shadowed === "flag"
      ? `${verb} a policy that is looser than requiring the team's approval for what it matches.`
      : `${verb} a policy that runs before the stricter policy "${shadowed.name}" and can take over its calls.`,
  };
}

export interface PolicyCreateInput {
  name: string;
  changeNote?: string;
  effect?: PolicyEffect;
  requiredApprovals?: number;
  decidedBy?: "team" | "end_user";
  priority?: number;
  enabled?: boolean;
  acknowledgeBroadScope?: boolean;
  matchKind: "any" | "action" | "custom";
  matchActionName?: string;
  matchAgentId?: string;
  matchUserId?: string;
  matchTags?: string[];
  minAmount?: number;
  conditions?: Record<string, unknown>;
  condition?: string;
}

export interface PolicyUpdateInput {
  name?: string;
  changeNote?: string;
  effect?: PolicyEffect;
  requiredApprovals?: number;
  decidedBy?: "team" | "end_user";
  priority?: number;
  enabled?: boolean;
  acknowledgeBroadScope?: boolean;
  matchKind?: "any" | "action" | "custom";
  matchActionName?: string | null;
  matchAgentId?: string | null;
  matchUserId?: string | null;
  matchTags?: string[] | null;
  minAmount?: number | null;
  conditions?: Record<string, unknown> | null;
  condition?: string | null;
}

export const POLICY_CREATE_FIELDS: { [K in keyof Required<PolicyCreateInput>]: "outcome" | "position" | "matcher" | "meta" } = {
  name: "meta", changeNote: "meta", acknowledgeBroadScope: "meta",
  effect: "outcome", requiredApprovals: "outcome", decidedBy: "outcome",
  priority: "position", enabled: "position",
  matchKind: "matcher", matchActionName: "matcher", matchAgentId: "matcher", matchUserId: "matcher",
  matchTags: "matcher", minAmount: "matcher", conditions: "matcher", condition: "matcher",
};

export const POLICY_UPDATE_FIELDS: { [K in keyof Required<PolicyUpdateInput>]: "outcome" | "position" | "matcher" | "meta" } = {
  ...POLICY_CREATE_FIELDS,
};

export function policyFromCreate(input: PolicyCreateInput, createdAt: number): PolicyState {
  return {
    policyId: "(new)", name: input.name,
    effect: input.effect ?? "require_approval", requiredApprovals: input.requiredApprovals ?? 1, decidedBy: input.decidedBy ?? "team",
    priority: input.priority ?? 100, enabled: input.enabled ?? true, createdAt,
    matchKind: input.matchKind, matchActionName: input.matchActionName ?? null, matchAgentId: input.matchAgentId ?? null,
    matchUserId: input.matchUserId ?? null, matchTags: input.matchTags ?? null, minAmount: input.minAmount ?? null,
    conditions: input.conditions ?? null, condition: input.condition ?? null,
  };
}

function unknownFields(input: object, table: Record<string, unknown>): FieldChange[] {
  return Object.keys(input)
    .filter((field) => (input as Record<string, unknown>)[field] !== undefined && !(field in table))
    .map((field) => ({ field, from: null, to: (input as Record<string, unknown>)[field], direction: "loosening" as const, reason: "This field is not classified, so it counts as loosening." }));
}

export function classifyPolicyCreate(input: PolicyCreateInput, existing: readonly PolicyState[]): Classification {
  const later = Math.max(0, ...existing.map((p) => p.createdAt)) + 1;
  const policy = policyFromCreate(input, later);
  const extra = unknownFields(input, POLICY_CREATE_FIELDS);
  if (!policy.enabled) {
    return classification([...extra, { field: "policy", from: null, to: describeOutcome(policy), direction: "neutral", reason: "Creates a disabled policy. It decides nothing until it is enabled." }]);
  }
  return classification([...extra, insertion(policy, existing, "Adds")]);
}

const MATCHERS = ["matchKind", "matchActionName", "matchAgentId", "matchUserId", "matchTags", "minAmount", "conditions", "condition"] as const;
type Matcher = (typeof MATCHERS)[number];

function matcherShift(field: Matcher, from: unknown, to: unknown): "narrower" | "wider" | "unknown" {
  const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  if (field === "matchKind") {
    if (from === "any" && to !== "any") return "narrower";
    if (to === "any" && from !== "any") return "wider";
    return "unknown";
  }
  if (field === "minAmount") {
    if (empty(from) && !empty(to)) return "narrower";
    if (!empty(from) && empty(to)) return "wider";
    return Number(to) > Number(from) ? "narrower" : "wider";
  }
  if (empty(from) && !empty(to)) return "narrower";
  if (!empty(from) && empty(to)) return "wider";
  return "unknown";
}

export function classifyPolicyUpdate(before: PolicyState, patch: PolicyUpdateInput, others: readonly PolicyState[]): Classification {
  const changes: FieldChange[] = [...unknownFields(patch, POLICY_UPDATE_FIELDS)];
  const after: PolicyState = { ...before };
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined && field in POLICY_UPDATE_FIELDS && field !== "changeNote" && field !== "acknowledgeBroadScope") {
      (after as unknown as Record<string, unknown>)[field] = value;
    }
  }
  const rest = others.filter((p) => p.policyId !== before.policyId);
  const changed = (field: keyof PolicyState) => !same(before[field], after[field]);
  const record = (field: string, direction: ChangeDirection, reason: string) =>
    changes.push({ field, from: (before as unknown as Record<string, unknown>)[field], to: (after as unknown as Record<string, unknown>)[field], direction, reason });

  if (changed("name")) record("name", "neutral", "Renames the policy.");

  if (changed("enabled")) {
    if (!after.enabled) {
      const removal = classifyPolicyDelete(before);
      record("enabled", removal.direction, before.effect === "auto_approve"
        ? "Disables a policy that approved calls automatically: they fall to stricter rules."
        : "Disables a policy: the calls it gated are decided by looser rules or the action's flag.");
    } else {
      const added = insertion(after, rest, "Enables");
      record("enabled", added.direction, added.reason);
    }
    return classification(changes);
  }
  if (!after.enabled) {
    for (const field of Object.keys(patch)) {
      if (field !== "name" && field in POLICY_UPDATE_FIELDS && POLICY_UPDATE_FIELDS[field as keyof PolicyUpdateInput] !== "meta" && changed(field as keyof PolicyState)) {
        record(field, "neutral", "Edits a disabled policy. It decides nothing until it is enabled.");
      }
    }
    return classification(changes);
  }

  const outcomeChanged = (["effect", "requiredApprovals", "decidedBy"] as const).filter(changed);
  if (outcomeChanged.length) {
    const tighter = atLeastAsStrict(after, before);
    for (const field of outcomeChanged) {
      record(field, tighter ? "tightening" : "loosening", tighter
        ? `Makes the policy stricter: ${describeOutcome(before)} becomes ${describeOutcome(after)}.`
        : `Makes the policy looser, or changes who decides: ${describeOutcome(before)} becomes ${describeOutcome(after)}.`);
    }
  }

  if (changed("priority")) {
    const earlier = after.priority < before.priority;
    const tighter = after.effect === "auto_deny" ? earlier : after.effect === "auto_approve" ? !earlier : false;
    record("priority", tighter ? "tightening" : "loosening", tighter
      ? "Moves the policy so it takes precedence in the stricter direction."
      : "Reorders the policy, which changes which policy decides the calls it shares with others.");
  }

  const matcherChanges = MATCHERS.filter((f) => changed(f));
  if (matcherChanges.length) {
    const shifts = new Set(matcherChanges.map((f) => matcherShift(f, before[f], after[f])));
    const shift = shifts.size === 1 ? [...shifts][0] : "unknown";
    let direction: ChangeDirection = "loosening";
    let reason = "Changes which calls the policy matches in a way that cannot be shown to be stricter.";
    if (after.effect === "auto_approve" && shift === "narrower") {
      direction = "tightening"; reason = "Narrows what is approved automatically.";
    } else if (after.effect === "auto_deny" && shift === "wider") {
      direction = "tightening"; reason = "Widens what is denied.";
    } else if (after.effect === "require_approval" && shift === "wider" && !weakerThanSomethingItShadows(after, rest)) {
      direction = "tightening"; reason = "Widens what needs approval, and nothing stricter is taken over.";
    } else if (shift === "narrower" && after.effect !== "auto_approve") {
      reason = "Narrows what the policy gates: calls it no longer matches are decided by looser rules.";
    } else if (shift === "wider" && after.effect === "auto_approve") {
      reason = "Widens what is approved automatically.";
    }
    for (const field of matcherChanges) record(field, direction, reason);
  }
  return classification(changes);
}

export function classifyPolicyDelete(before: PolicyState): Classification {
  if (!before.enabled) {
    return classification([{ field: "policy", from: before.name, to: null, direction: "neutral", reason: "Deletes a disabled policy, which decided nothing." }]);
  }
  if (before.effect === "auto_approve") {
    return classification([{ field: "policy", from: before.name, to: null, direction: "tightening", reason: "Deletes a policy that approved calls automatically: they fall to stricter rules." }]);
  }
  return classification([{
    field: "policy", from: before.name, to: null,
    direction: "loosening", reason: "Deletes a policy that gated calls: they are decided by looser rules or the action's flag.",
  }]);
}

export type PolicyFileChange =
  | { op: "create"; name: string; after: PolicyCreateInput }
  | { op: "update"; name: string; policyId: string; after: PolicyUpdateInput }
  | { op: "delete"; name: string; policyId: string }
  | { op: "unchanged"; name: string };

export function classifyPolicyFile(changes: readonly PolicyFileChange[], current: readonly PolicyState[]): Classification {
  const out: FieldChange[] = [];
  const byId = new Map(current.map((p) => [p.policyId, p]));
  for (const change of changes) {
    const prefix = (c: FieldChange): FieldChange => ({ ...c, field: `${change.name}.${c.field}` });
    if (change.op === "unchanged") continue;
    if (change.op === "create") {
      out.push(...classifyPolicyCreate(change.after, current).changes.map(prefix));
      continue;
    }
    const before = byId.get(change.policyId);
    if (!before) {
      out.push({ field: change.name, from: null, to: change.op, direction: "loosening", reason: "The policy this change names is not in the environment, so it counts as loosening." });
      continue;
    }
    if (change.op === "delete") out.push(...classifyPolicyDelete(before).changes.map(prefix));
    else out.push(...classifyPolicyUpdate(before, change.after, current).changes.map(prefix));
  }
  return classification(out);
}

export interface ActionInput {
  name?: string;
  description?: string;
  method?: string;
  urlTemplate?: string;
  headers?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
  enabled?: boolean;
  adapter?: unknown;
  impact?: unknown;
  verify?: unknown;
  governed?: boolean;
}

export const ACTION_UPDATE_RULES: FieldRules<ActionInput> = {
  name: loosens("Renames the action. Policies and limits that name it would stop applying to it."),
  description: neutral("Changes the description."),
  method: loosens("Changes the HTTP method the action sends."),
  urlTemplate: loosens("Changes where the action sends its request."),
  headers: loosens("Changes the headers the action sends."),
  bodyTemplate: loosens("Changes the body the action sends."),
  inputSchema: loosens("Changes what input the action accepts."),
  requiresApproval: guardedWhen(true, "Requires approval for every call.", "Stops requiring approval: calls run without a human."),
  enabled: guardedWhen(false, "Disables the action.", "Enables the action: the agent can call it."),
  adapter: loosens("Changes the adapter that performs the action."),
  impact: declaration("an impact declaration (what limits count)"),
  verify: declaration("a read-back check"),
  governed: guardedWhen(true, "Makes the action governed.", "Makes the action ungoverned: its effects are no longer tracked."),
};

export function classifyActionCreate(input: ActionInput & { name: string }): Classification {
  const extra = unknownFields(input, ACTION_UPDATE_RULES);
  if (input.enabled === false) {
    return classification([...extra, { field: "action", from: null, to: input.name, direction: "neutral", reason: "Creates a disabled action. Enabling it needs a person's sign-off." }]);
  }
  const write = input.adapter !== undefined || (input.method ?? "POST").toUpperCase() !== "GET";
  return classification([...extra, {
    field: "action", from: null, to: { name: input.name, method: input.adapter ? "adapter" : (input.method ?? "POST"), urlTemplate: input.urlTemplate ?? null },
    direction: "loosening",
    reason: write
      ? "Adds a write action: the agent can change something it could not change before."
      : "Adds an action: a new call the agent can make, which can reach a new host or change state.",
  }]);
}

export function classifyActionUpdate(before: ActionInput, patch: ActionInput): Classification {
  return classification(classifyFields(ACTION_UPDATE_RULES, before, patch));
}

export function classifyActionDelete(before: { name: string }): Classification {
  return classification([{ field: "action", from: before.name, to: null, direction: "tightening", reason: "Deletes the action: the agent can no longer call it." }]);
}

export function classifyActionImport(created: readonly { name: string; method?: string; urlTemplate?: string }[]): Classification {
  return classification(created.map((a) => ({
    field: `action:${a.name}`, from: null, to: { method: a.method ?? null, urlTemplate: a.urlTemplate ?? null },
    direction: "loosening" as const, reason: "Adds an action the agent can call.",
  })));
}

export interface McpUpstreamRegisterInput {
  name: string;
  url: string;
  headers?: Record<string, string> | null;
  registryName?: string | null;
  oauth?: { clientId?: string | null; clientSecret?: string | null } | null;
  endUserKey?: { header: string } | null;
}

export const MCP_UPSTREAM_REGISTER_FIELDS: { [K in keyof Required<McpUpstreamRegisterInput>]: true } = {
  name: true, url: true, headers: true, registryName: true, oauth: true, endUserKey: true,
};

export interface RegisterSecretFact {
  name: string;
  allowedHosts: readonly string[] | null;
}

export function classifyMcpUpstreamRegister(input: McpUpstreamRegisterInput, facts: { host: string; secrets: readonly RegisterSecretFact[] }): Classification {
  const changes: FieldChange[] = [...unknownFields(input, MCP_UPSTREAM_REGISTER_FIELDS), {
    field: "mcp_upstream", from: null, to: { name: input.name, url: input.url }, direction: "neutral",
    reason: "Registers an MCP server and lists its tools. No agent can call a tool until a person signs off adopting it.",
  }];
  for (const secret of facts.secrets) {
    const anyHost = !secret.allowedHosts || secret.allowedHosts.length === 0;
    changes.push({
      field: `secret:${secret.name}`, from: null, to: { sentTo: facts.host, address: input.url },
      direction: "loosening",
      reason: anyHost
        ? `Sends secret ${secret.name}, which may go to any host, to ${facts.host} as soon as this is registered, to list its tools. Approve only if this server should hold it.`
        : `Sends secret ${secret.name} to ${input.url} as soon as this is registered, to list its tools. The secret allows ${facts.host}, but a request to this address acts with it, with no approval or limit. Approve only if this is the server's real MCP endpoint.`,
    });
  }
  if (input.oauth) {
    changes.push({
      field: "oauth", from: null,
      to: { client: input.oauth.clientId ?? "(this deployment's, or registered at the server)", clientSecret: input.oauth.clientSecret ?? null },
      direction: "loosening",
      reason: "Registers a server that signs people in with OAuth: Anlyon may register a client at it, and its own metadata names where a client secret and people's sign-ins go. No account is connected and no agent can call a tool yet.",
    });
  }
  if (input.endUserKey) {
    changes.push({
      field: "endUserKey", from: null, to: { header: input.endUserKey.header },
      direction: "neutral",
      reason: `Each end user brings their own key, sent in the ${input.endUserKey.header} header in place of the stored secret, to this server only and only for calls made for them. Calls made for no end user keep using the stored secret.`,
    });
  }
  return classification(changes);
}

export function classifyMcpUpstreamRefresh(upstream: { name: string }): Classification {
  return classification([{
    field: "mcp_upstream", from: upstream.name, to: upstream.name, direction: "neutral",
    reason: "Lists the server's tools again. Adopted tools keep the definition they were adopted at.",
  }]);
}

export interface McpToolAdoption {
  tool: string;
  action: string;
  readopted: boolean;
  hash?: string;
  fromHash?: string | null;
  suggestedClass?: string;
  reasons?: readonly unknown[];
  schemaCheck?: "full" | "loose";
  schemaCheckReason?: string | null;
  requiresApproval?: boolean;
  impact?: unknown;
  description?: string | null;
  requestedDescription?: string | null;
  parameters?: readonly string[];
}

const APPROVAL_SUGGESTED = new Set(["irreversible", "destructive"]);

export function classifyMcpToolAdopt(tools: readonly McpToolAdoption[]): Classification {
  return classification(tools.map((t) => {
    const loose = t.schemaCheck === "loose";
    const unguarded = t.requiresApproval === false && (loose || (t.suggestedClass !== undefined && APPROVAL_SUGGESTED.has(t.suggestedClass)));
    return {
      field: `action:${t.action}`,
      from: t.readopted ? { tool: t.tool, hash: t.fromHash ?? null } : null,
      to: {
        tool: t.tool,
        ...(t.hash !== undefined ? { hash: t.hash } : {}),
        ...(t.suggestedClass !== undefined ? { suggestedClass: t.suggestedClass } : {}),
        ...(t.reasons?.length ? { reasons: t.reasons } : {}),
        ...(loose ? { schemaCheck: "loose", schemaCheckReason: t.schemaCheckReason ?? null } : {}),
        ...(t.requiresApproval !== undefined ? { requiresApproval: t.requiresApproval } : {}),
        ...(t.impact ? { impact: t.impact } : {}),
        ...(t.description ? { description: t.description } : {}),
        ...(t.requestedDescription ? { requestedDescription: t.requestedDescription } : {}),
        ...(t.parameters?.length ? { parameters: t.parameters } : {}),
      },
      direction: "loosening" as const,
      reason: `${t.readopted
        ? "Re-adopts a tool whose definition changed: the agent can call the new definition."
        : "Adopts a tool from an MCP server: the agent can call it."}${loose
        ? " Anlyon cannot check its input schema in full, so its arguments are sent as the agent writes them."
        : ""}${unguarded
        ? loose
          ? " Approval is suggested for a loosely checked tool, and this request does not require approval."
          : ` The risk engine suggests ${t.suggestedClass} and approval, and this request does not require approval.`
        : ""} Its name, description and class come from what the server says, which is untrusted.`,
    };
  }));
}

export function classifyMcpUpstreamArchive(upstream: { name: string; archived: boolean }): Classification {
  if (upstream.archived) return classification([]);
  return classification([{
    field: "mcp_upstream", from: upstream.name, to: null, direction: "tightening",
    reason: "Archives the server and disables every action adopted from it.",
  }]);
}

export interface SecretPutInput {
  value?: string;
  external?: unknown;
  description?: string;
  allowedHosts?: string[] | null;
  allowedPlacements?: string[] | null;
}

export const SECRET_PUT_RULES: FieldRules<SecretPutInput> = {
  value: neutral("Replaces the stored value with one the caller supplied."),
  external: loosens("Points the secret at a value in a secret store, read with the store's credential."),
  description: neutral("Changes the description."),
  allowedHosts: hostList,
  allowedPlacements: placementList,
};

export function classifySecretPut(
  before: { allowedHosts: string[] | null; allowedPlacements: string[] | null; external: boolean; description: string | null } | null,
  input: SecretPutInput,
): Classification {
  const shown = { ...input, ...(input.value !== undefined ? { value: REDACTED } : {}) };
  if (!before) {
    if (input.external === undefined) {
      return classification([...unknownFields(input, SECRET_PUT_RULES), {
        field: "secret", from: null, to: { allowedHosts: input.allowedHosts ?? null }, direction: "neutral",
        reason: "Stores a new secret with a value the caller supplied.",
      }]);
    }
    return classification([{ field: "external", from: null, to: input.external, direction: "loosening", reason: "Creates a secret read from a secret store with the store's credential." }]);
  }
  const changes = classifyFields(SECRET_PUT_RULES, { ...before, value: REDACTED, external: before.external ? "(store reference)" : undefined }, shown);
  return classification(changes.map((c) => (c.field === "value" ? { ...c, from: REDACTED, to: REDACTED } : c)));
}

export function classifySecretDelete(before: { name: string }): Classification {
  return classification([{ field: "secret", from: before.name, to: null, direction: "tightening", reason: "Deletes the secret: no action can use it." }]);
}

export function classifySecretStoreCreate(input: { name: string }): Classification {
  return classification([{
    field: "secret_store", from: null, to: input.name,
    direction: "loosening", reason: "Connects a secret store: its credential can read every secret its policy allows.",
  }]);
}

export function classifySecretStoreUpdate(fields: readonly string[]): Classification {
  return classification(fields.map((field) => ({
    field, from: REDACTED, to: REDACTED,
    direction: "loosening" as const, reason: "Changes how Anlyon reads a secret store, which can widen what it reads.",
  })));
}

export function classifySecretStoreDelete(before: { name: string }): Classification {
  return classification([{ field: "secret_store", from: before.name, to: null, direction: "tightening", reason: "Removes a secret store." }]);
}

export function classifySecretStoreSettings(before: { allowPrivateNetwork: boolean }, input: { allowPrivateNetwork: boolean }): Classification {
  if (before.allowPrivateNetwork === input.allowPrivateNetwork) return classification([]);
  return classification([{
    field: "allowPrivateNetwork", from: before.allowPrivateNetwork, to: input.allowPrivateNetwork,
    ...guardedWhen(false, "Stops store requests reaching private addresses.", "Lets store requests reach private addresses.")(before.allowPrivateNetwork, input.allowPrivateNetwork),
  }]);
}

export function classifyOAuthAppPut(before: { clientId: string } | null, input: { clientId: string }): Classification {
  return classification([{
    field: "oauth_app", from: before ? { clientId: before.clientId } : null, to: { clientId: input.clientId, clientSecret: REDACTED },
    direction: "loosening",
    reason: before
      ? "Replaces the OAuth app end users sign in to: every new grant goes to the new app."
      : "Sets the OAuth app end users sign in to: its owner decides what the grants allow.",
  }]);
}

export function classifyOAuthAppDelete(before: { clientId: string } | null): Classification {
  if (!before) return classification([]);
  return classification([{ field: "oauth_app", from: { clientId: before.clientId }, to: null, direction: "tightening", reason: "Removes the environment's own OAuth app." }]);
}

export function classifyApiKeyCreate(
  input: { name: string; scopes?: string[]; endUserRequired?: boolean; expiresAt?: string; environmentId?: string },
  privileged: readonly string[],
): Classification {
  const granted = (input.scopes ?? []).filter((s) => privileged.includes(s));
  return classification([{
    field: "api_key", from: null, to: { name: input.name, scopes: input.scopes ?? "default", endUserRequired: input.endUserRequired ?? false },
    direction: "loosening",
    reason: granted.length
      ? `Creates a credential holding privileged scopes: ${granted.join(", ")}.`
      : "Creates a credential.",
  }]);
}

export interface EnvironmentPatch {
  name?: string;
  kind?: string;
  isDefault?: true;
  isProtected?: boolean;
  confirmProtected?: boolean;
  allowedRedirectUrls?: string[];
  defaultRedirectUrl?: string | null;
  connectConfirmation?: "required" | "off";
}

export const ENVIRONMENT_UPDATE_RULES: FieldRules<EnvironmentPatch> = {
  name: neutral("Renames the environment."),
  kind: (from, to) => (to === "production"
    ? { direction: "tightening", reason: "Marks the environment as production." }
    : { direction: "loosening", reason: from === "production" ? "Stops treating the environment as production." : "Changes the environment's kind." }),
  isDefault: neutral("Makes it the default environment."),
  isProtected: guardedWhen(true, "Protects the environment.", "Removes the environment's protection."),
  confirmProtected: neutral("Confirms a change to a protected environment."),
  allowedRedirectUrls: (from, to) => {
    const a = (from ?? []) as string[];
    const b = (to ?? []) as string[];
    return b.every((u) => a.includes(u))
      ? { direction: "tightening", reason: "Narrows where connect links may return." }
      : { direction: "loosening", reason: "Adds places connect links may return to." };
  },
  defaultRedirectUrl: loosens("Changes where connect links return by default."),
  connectConfirmation: guardedWhen("required", "Requires the developer's server to confirm each end-user grant.", "Stops requiring confirmation of end-user grants."),
};

export function classifyEnvironmentUpdate(before: EnvironmentPatch, patch: EnvironmentPatch): Classification {
  return classification(classifyFields(ENVIRONMENT_UPDATE_RULES, before, patch, { ignore: ["confirmProtected"] }));
}

export interface WorkspaceDefaultsPatch {
  actingFor?: string | null;
  endUserDecider?: string | null;
  approvalWindowHours?: number | null;
  setupStatus?: string;
  source?: string;
}

export const WORKSPACE_DEFAULTS_RULES: FieldRules<WorkspaceDefaultsPatch> = {
  actingFor: loosens("Changes whose accounts the agent acts in."),
  endUserDecider: loosens("Changes who decides calls made for end users that no policy matched."),
  approvalWindowHours: (from, to) => (Number(to ?? 0) > Number(from ?? 0)
    ? { direction: "loosening", reason: "Lets an approval request stay answerable for longer." }
    : { direction: "tightening", reason: "Shortens how long an approval request stays answerable." }),
  setupStatus: neutral("Records the setup journey's progress."),
  source: neutral("Says which console page made the change."),
};

export function classifyWorkspaceDefaults(before: WorkspaceDefaultsPatch, patch: WorkspaceDefaultsPatch): Classification {
  return classification(classifyFields(WORKSPACE_DEFAULTS_RULES, before, patch, { ignore: ["source"] }));
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function renderDiff(changes: readonly FieldChange[]): string {
  if (!changes.length) return "(no change)";
  return changes.map((c) => {
    const label = c.direction === "loosening" ? "loosens" : c.direction === "tightening" ? "tightens" : "no effect";
    return `${c.field} (${label}): ${c.reason}\n- ${show(c.from)}\n+ ${show(c.to)}`;
  }).join("\n\n");
}
