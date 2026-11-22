import type { Action, ApprovalPolicy, Budget, Client, ImpactLimit, McpToolChoice, McpUpstream, PackInstallOptions, PolicyFilePlan } from '@anlyonhq/sdk';
import { packShortName } from '@anlyonhq/sdk';
import { stringify } from 'yaml';
import { apiRequest, signOffFromError, type SignOff } from '../api';
import type { Connection } from '../context';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import type { Runtime } from '../runtime';
import { readManifest } from '../commands/packs';
import {
  BUDGET_DIMENSIONS, DEFAULT_POLICY_FILE,
  type ActionSpec, type BudgetSpec, type ConfigFile, type EnvironmentSpec, type LimitSpec, type McpServerSpec, type PackSpec, type PolicySpec,
} from './model';

/**
 * Plan, apply and pull for anlyon.yaml.
 *
 * Every change is marked with which way it moves the guardrails:
 *   tightening    the agent may do less, or a person sees more of what it does
 *   loosening     the agent may do more, or a person sees less
 *   neutral       nothing the agent may do changes (a description, a disabled policy)
 *   needs-person  the file cannot make it happen: a secret value a person stores
 *
 * The server decides for real: a loosening change sent by an API key or a CLI login is
 * not applied, it answers 202 with a sign-off link a workspace admin approves. This module's
 * reading follows the same rules so the plan says up front which changes will wait for a person;
 * when the two disagree the server's answer is the one that counts, and apply reports it.
 */
export type Direction = 'tightening' | 'loosening' | 'neutral' | 'needs-person';
export type Section = 'secrets' | 'packs' | 'actions' | 'policies' | 'limits' | 'budgets' | 'mcp';

export interface PlannedChange {
  section: Section;
  key: string;
  op: 'create' | 'update' | 'delete' | 'replace' | 'missing';
  direction: Direction;
  /** One line a reviewer reads. */
  reason: string;
  fields?: string[];
}

export interface Plan {
  file: string;
  environment: { id: string; slug: string };
  changes: PlannedChange[];
  summary: Record<Direction, number> & { unchanged: number };
  /** Problems that stop apply (from the server's policy plan). */
  errors: string[];
}

interface PolicyState {
  plan: PolicyFilePlan;
  /** Live policies the file owns, by key. */
  live: Map<string, ApprovalPolicy>;
}

interface Live {
  actions: Map<string, Action>;
  limits: Map<string, ImpactLimit>;
  budgets: Map<string, Budget>;
  secrets: Set<string>;
  upstreams: Map<string, McpUpstream>;
  policies?: PolicyState;
}

/** The changes a plan found, kept with what apply needs to make them. */
interface Work {
  plan: Plan;
  spec: EnvironmentSpec;
  live: Live;
  policyFile: string;
  /** Policy keys whose change loosens, so the first pass leaves them as they are live. */
  looseningPolicies: Set<string>;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const same = (a: unknown, b: unknown) => stable(a ?? null) === stable(b ?? null);

export function environmentSpec(config: ConfigFile, environment: { id: string; slug: string }, file: string): EnvironmentSpec {
  const names = Object.keys(config.environments);
  const key = names.find((name) => name === environment.slug || name === environment.id || name.toLowerCase() === environment.slug.toLowerCase());
  if (!key) {
    throw new CliError('ENVIRONMENT_NOT_IN_FILE', `${file} has no entry for environment ${environment.slug}, which this credential is bound to.`, EXIT.USAGE, {
      hint: names.length ? `It declares: ${names.join(', ')}. Use a credential for one of those, or add ${environment.slug} to the file (anlyon pull writes it).` : `Run \`anlyon pull\` to write ${environment.slug} to the file.`,
    });
  }
  return config.environments[key] ?? {};
}

/** The policy file the server keeps for this repository's policies: the same YAML, in its own format. */
export function policySource(policyFile: string, environmentSlug: string, policies: Record<string, PolicySpec>): string {
  return stringify({ apiVersion: 'anlyon.com/policies/v1', file: policyFile, environment: environmentSlug, policies });
}

async function readLive(client: Client, spec: EnvironmentSpec, policyFile: string, slug: string): Promise<Live> {
  const [actions, limits, budgets, secrets, upstreams] = await Promise.all([
    spec.actions || spec.packs ? client.actions.list().then((r) => r.data ?? []) : Promise.resolve([] as Action[]),
    spec.limits ? client.impactLimits.list().then((r) => r.data ?? []) : Promise.resolve([] as ImpactLimit[]),
    spec.budgets ? client.budgets.list().then((r) => r.data ?? []) : Promise.resolve([] as Budget[]),
    spec.secrets ? client.secrets.list().then((r) => r.data ?? []) : Promise.resolve([] as { name: string }[]),
    spec.mcp ? client.mcpUpstreams.list().then((r) => r.data ?? []) : Promise.resolve([] as McpUpstream[]),
  ]);
  const live: Live = {
    actions: new Map(actions.map((action) => [action.name, action])),
    limits: new Map(limits.filter((limit) => !limit.archived).map((limit) => [limit.name, limit])),
    budgets: new Map(budgets.map((budget) => [budget.apiKeyId, budget])),
    secrets: new Set(secrets.map((secret) => secret.name)),
    upstreams: new Map(upstreams.map((upstream) => [upstream.name, upstream])),
  };
  if (spec.policies) {
    const plan = (await client.approvalPolicies.planFile(policySource(policyFile, slug, spec.policies))).data!;
    const owned = plan.changes.filter((change) => change.policyId && change.op !== 'create');
    const fetched = await Promise.all(owned.map(async (change) => [change.key, (await client.approvalPolicies.get(change.policyId!)).data!] as const));
    live.policies = { plan, live: new Map(fetched) };
  }
  return live;
}

const ACTION_FIELDS: Record<keyof ActionSpec, keyof Action> = {
  description: 'description', method: 'method', url: 'urlTemplate', headers: 'headers', body: 'bodyTemplate', inputSchema: 'inputSchema',
  requiresApproval: 'requiresApproval', enabled: 'enabled', governed: 'governed', impact: 'impact', verify: 'verify',
};

function actionFieldDirection(field: keyof ActionSpec, from: unknown, to: unknown): { direction: Direction; reason: string } {
  switch (field) {
    case 'description': return { direction: 'neutral', reason: 'description' };
    case 'requiresApproval': return to === true ? { direction: 'tightening', reason: 'requires approval' } : { direction: 'loosening', reason: 'stops requiring approval' };
    case 'enabled': return to === false ? { direction: 'tightening', reason: 'disabled' } : { direction: 'loosening', reason: 'enabled: the agent can call it' };
    case 'governed': return to === true ? { direction: 'tightening', reason: 'governed' } : { direction: 'loosening', reason: 'ungoverned: its effects are no longer tracked' };
    case 'impact':
    case 'verify': {
      const what = field === 'impact' ? 'impact declaration' : 'read-back check';
      if ((from === null || from === undefined) && to !== null && to !== undefined) return { direction: 'tightening', reason: `adds ${field === 'impact' ? 'an' : 'a'} ${what}` };
      return { direction: 'loosening', reason: to === null || to === undefined ? `removes the ${what}` : `changes the ${what}` };
    }
    default: return { direction: 'loosening', reason: `changes ${field === 'url' ? 'where it sends' : field === 'body' ? 'the body it sends' : field === 'inputSchema' ? 'the input it accepts' : `its ${field}`}` };
  }
}

const RANK = { auto_approve: 0, require_approval: 1, auto_deny: 2 } as const;

function strictness(policy: { effect?: string; approvals?: number; enabled?: boolean }): number {
  return RANK[(policy.effect ?? 'require_approval') as keyof typeof RANK] * 100 + (policy.approvals ?? 1);
}

/** A live policy written the way the file writes it. */
export function policyToFile(policy: ApprovalPolicy): PolicySpec {
  const { match } = policy;
  const target: PolicySpec['target'] = match.kind === 'custom' ? { customRequests: true } : match.kind === 'any' ? { allRequests: true } : match.actionName ? { action: match.actionName } : { allActions: true };
  const out: PolicySpec = { name: policy.name, target };
  if (match.condition) out.when = match.condition;
  if (policy.effect !== 'require_approval') out.effect = policy.effect;
  if (policy.requiredApprovals !== 1) out.approvals = policy.requiredApprovals;
  out.priority = policy.priority;
  if (!policy.enabled) out.enabled = false;
  if (match.agentId) out.agent = match.agentId;
  if (match.userId) out.user = match.userId;
  if (match.tags?.length) out.tags = match.tags;
  if (!('action' in target)) out.acknowledgeBroadScope = true;
  return out;
}

function policyDirection(op: string, before: PolicySpec | undefined, after: PolicySpec | undefined): { direction: Direction; reason: string } {
  const enabled = (p?: PolicySpec) => p !== undefined && p.enabled !== false;
  if (op === 'create') {
    if (!enabled(after)) return { direction: 'neutral', reason: 'adds a disabled policy' };
    return after!.effect === 'auto_approve' ? { direction: 'loosening', reason: 'adds a policy that approves calls automatically' } : { direction: 'tightening', reason: `adds a policy that ${after!.effect === 'auto_deny' ? 'denies' : 'gates'} calls` };
  }
  if (op === 'delete') {
    if (!enabled(before)) return { direction: 'neutral', reason: 'deletes a disabled policy' };
    return before!.effect === 'auto_approve' ? { direction: 'tightening', reason: 'deletes a policy that approved calls automatically' } : { direction: 'loosening', reason: 'deletes a policy that gated calls' };
  }
  if (!before || !after) return { direction: 'loosening', reason: 'changes a policy the plan could not read' };
  if (enabled(before) !== enabled(after)) return policyDirection(enabled(after) ? 'create' : 'delete', before, after);
  if (!enabled(after)) return { direction: 'neutral', reason: 'edits a disabled policy' };
  const reasons: { direction: Direction; reason: string }[] = [];
  if (strictness(after) !== strictness(before)) {
    reasons.push(strictness(after) > strictness(before) ? { direction: 'tightening', reason: 'stricter outcome' } : { direction: 'loosening', reason: 'looser outcome' });
  }
  for (const field of ['target', 'when', 'agent', 'user', 'tags', 'priority'] as const) {
    if (!same(before[field], after[field])) reasons.push({ direction: 'loosening', reason: `changes ${field === 'target' || field === 'when' ? 'which calls it matches' : field}` });
  }
  if (before.name !== after.name) reasons.push({ direction: 'neutral', reason: 'renamed' });
  return combine(reasons);
}

function combine(parts: { direction: Direction; reason: string }[]): { direction: Direction; reason: string } {
  if (!parts.length) return { direction: 'neutral', reason: 'no change' };
  const direction: Direction = parts.some((p) => p.direction === 'loosening') ? 'loosening' : parts.some((p) => p.direction === 'tightening') ? 'tightening' : 'neutral';
  return { direction, reason: parts.map((p) => p.reason).join('; ') };
}

function capDirection(what: string, from: number | null | undefined, to: number | null | undefined): { direction: Direction; reason: string } | null {
  const a = typeof from === 'number' ? from : null;
  const b = typeof to === 'number' ? to : null;
  if (a === b) return null;
  if (b === null) return { direction: 'loosening', reason: `removes the ${what}` };
  if (a === null) return { direction: 'tightening', reason: `adds a ${what} of ${b}` };
  return b < a ? { direction: 'tightening', reason: `lowers the ${what} from ${a} to ${b}` } : { direction: 'loosening', reason: `raises the ${what} from ${a} to ${b}` };
}

/** A live limit as the file writes it. */
export function limitToFile(limit: ImpactLimit): LimitSpec {
  const out: LimitSpec = { dimension: limit.dimension, amount: limit.limit, period: limit.period };
  if (limit.currency) out.currency = limit.currency;
  if (limit.scope?.actionName) out.action = limit.scope.actionName;
  if (limit.scope?.resourcePrefix) out.resourcePrefix = limit.scope.resourcePrefix;
  if (limit.scope?.kind && limit.scope.kind !== 'environment') out.scope = limit.scope.kind;
  return out;
}

/** A live budget as the file writes it. */
export function budgetToFile(budget: Budget): BudgetSpec {
  const out: BudgetSpec = { monthlyCostCentsCap: budget.monthlyCostCentsCap };
  const caps = Object.fromEntries(Object.entries(budget.dimensionCaps ?? {}).filter(([, v]) => typeof v === 'number'));
  if (Object.keys(caps).length) out.dimensionCaps = caps;
  out.alertThreshold = budget.alertThreshold;
  if (!budget.enabled) out.enabled = false;
  return out;
}

/** A live action as the file writes it: only what differs from a new action's defaults. */
export function actionToFile(action: Action): ActionSpec {
  const out: ActionSpec = { url: action.urlTemplate };
  if (action.description) out.description = action.description;
  if (action.method) out.method = action.method as ActionSpec['method'];
  out.url = action.urlTemplate;
  if (action.headers && Object.keys(action.headers).length) out.headers = action.headers as Record<string, string>;
  if (action.bodyTemplate && Object.keys(action.bodyTemplate).length) out.body = action.bodyTemplate as Record<string, unknown>;
  if (action.inputSchema && Object.keys(action.inputSchema).length) out.inputSchema = action.inputSchema as Record<string, unknown>;
  if (action.requiresApproval) out.requiresApproval = true;
  if (action.enabled === false) out.enabled = false;
  if (action.governed) out.governed = true;
  if (action.impact) out.impact = action.impact as ActionSpec['impact'];
  if (action.verify) out.verify = action.verify as ActionSpec['verify'];
  return out;
}

function packOptions(spec: PackSpec | null | undefined): PackInstallOptions {
  const s = spec ?? {};
  return {
    ...(s.actions ? { actions: s.actions } : {}),
    ...(s.withLimits ? { withLimits: true } : {}),
    ...(s.secretNames ? { secretNames: s.secretNames } : {}),
    ...(s.params ? { params: s.params } : {}),
    ...(s.credential ? { credential: s.credential } : {}),
    ...(s.noPrefix ? { noPrefix: true } : {}),
  };
}

async function planPacks(client: Client, spec: EnvironmentSpec): Promise<PlannedChange[]> {
  const out: PlannedChange[] = [];
  for (const [name, pack] of Object.entries(spec.packs ?? {})) {
    const manifest = await readManifest(name);
    const planned = await client.packs.plan(manifest, packOptions(pack));
    const creates = planned.steps.filter((step) => step.outcome === 'create' || step.outcome === 'update');
    if (!creates.length) continue;
    const actions = creates.filter((step) => step.kind === 'action').map((step) => step.name);
    out.push({
      section: 'packs', key: name, op: 'create',
      direction: actions.length ? 'loosening' : 'tightening',
      reason: actions.length ? `adds ${actions.length} action${actions.length === 1 ? '' : 's'} the agent can call (${actions.join(', ')})` : 'adds the pack\'s policies or limits',
      fields: creates.map((step) => `${step.kind}:${step.name}`),
    });
  }
  return out;
}

/**
 * Servers and tools. Registering adds nothing an agent can call, so it reads as neutral unless it
 * signs people in; the server still asks a person when a secret it names may go to any host. Adopting
 * always waits for a person, and so does adopting again a tool the server changed.
 */
function planMcp(spec: EnvironmentSpec, live: Live): { changes: PlannedChange[]; errors: string[]; unchanged: number } {
  const changes: PlannedChange[] = [];
  const errors: string[] = [];
  let unchanged = 0;
  for (const [name, server] of Object.entries(spec.mcp ?? {})) {
    const upstream = live.upstreams.get(name);
    if (server === null) {
      if (upstream) changes.push({ section: 'mcp', key: name, op: 'delete', direction: 'tightening', reason: `archives the server and disables the ${upstream.adopted.length} action(s) adopted from it` });
      else unchanged++;
      continue;
    }
    if (!upstream) {
      changes.push(server.oauth
        ? { section: 'mcp', key: name, op: 'create', direction: 'loosening', reason: `registers ${server.url}, which signs people in. A person signs it off, then connects an account in the console.` }
        : { section: 'mcp', key: name, op: 'create', direction: 'neutral', reason: `registers ${server.url}. No agent can call it until a tool is adopted.` });
    } else {
      if (upstream.url !== server.url || !same(upstream.headers, server.headers ?? {})) {
        errors.push(`mcp.${name}: ${upstream.url !== server.url ? 'url' : 'headers'} differ from the registered server, and neither can change. Archive it (${name}: null), apply, then register it again.`);
      } else unchanged++;
    }
    const adopted = new Map(upstream?.adopted.map((entry) => [entry.tool, entry]));
    const listed = new Set(upstream?.tools.map((tool) => tool.name));
    for (const [tool, settings] of Object.entries(server.adopt ?? {})) {
      const key = `${name}/${tool}`;
      const entry = adopted.get(tool);
      if (upstream && !entry && !listed.has(tool)) {
        changes.push({ section: 'mcp', key, op: 'missing', direction: 'needs-person', reason: `the server does not list it. Check with: anlyon mcp tools ${name} --refresh` });
      } else if (!entry) {
        changes.push({ section: 'mcp', key, op: 'create', direction: 'loosening', reason: 'adopts the tool, so agents can call it. A person signs it off.' });
      } else if (entry.state === 'missing') {
        changes.push({ section: 'mcp', key, op: 'missing', direction: 'needs-person', reason: 'adopted, but the server no longer lists it, so it is not called' });
      } else if (entry.state === 'changed') {
        changes.push({ section: 'mcp', key, op: 'update', direction: 'loosening', reason: 'the server changed this tool, and it is not called until a person signs off adopting it again' });
      } else if (typeof settings?.requiresApproval === 'boolean' && settings.requiresApproval !== entry.requiresApproval) {
        changes.push({ section: 'mcp', key, op: 'update', fields: ['requiresApproval'], ...actionFieldDirection('requiresApproval', entry.requiresApproval, settings.requiresApproval) });
      } else unchanged++;
    }
  }
  return { changes, errors, unchanged };
}

export async function plan(connection: Connection, config: ConfigFile, file: string): Promise<{ plan: Plan; work: Work }> {
  const { client, environment } = connection;
  const env = { id: environment.id, slug: environment.slug };
  const spec = environmentSpec(config, env, file);
  const policyFile = config.policyFile ?? DEFAULT_POLICY_FILE;
  const live = await readLive(client, spec, policyFile, env.slug);
  const changes: PlannedChange[] = [];
  let unchanged = 0;

  for (const name of spec.secrets ?? []) {
    if (live.secrets.has(name)) unchanged++;
    else changes.push({ section: 'secrets', key: name, op: 'missing', direction: 'needs-person', reason: `store its value: anlyon connections add, or Secrets in the console. The file holds names only.` });
  }

  changes.push(...(await planPacks(client, spec)));

  for (const [name, action] of Object.entries(spec.actions ?? {})) {
    const current = live.actions.get(name);
    if (!current) {
      changes.push(action.enabled === false
        ? { section: 'actions', key: name, op: 'create', direction: 'neutral', reason: 'adds a disabled action' }
        : { section: 'actions', key: name, op: 'create', direction: 'loosening', reason: `adds an action the agent can call (${action.method ?? 'POST'} ${action.url})` });
      continue;
    }
    const parts: { direction: Direction; reason: string }[] = [];
    const fields: string[] = [];
    for (const field of Object.keys(action) as (keyof ActionSpec)[]) {
      const from = current[ACTION_FIELDS[field]];
      const to = action[field];
      if (same(from, to)) continue;
      fields.push(field);
      parts.push(actionFieldDirection(field, from, to));
    }
    if (!fields.length) unchanged++;
    else changes.push({ section: 'actions', key: name, op: 'update', ...combine(parts), fields });
  }

  const looseningPolicies = new Set<string>();
  const policyErrors: string[] = [];
  if (live.policies) {
    policyErrors.push(...live.policies.plan.errors);
    for (const change of live.policies.plan.changes) {
      if (change.op === 'unchanged') {
        unchanged++;
        continue;
      }
      const before = live.policies.live.get(change.key);
      const read = policyDirection(change.op, before ? policyToFile(before) : undefined, spec.policies?.[change.key]);
      if (read.direction === 'loosening') looseningPolicies.add(change.key);
      changes.push({ section: 'policies', key: change.key, op: change.op, ...read, ...(change.fields ? { fields: change.fields } : {}) });
    }
  }

  for (const [name, limit] of Object.entries(spec.limits ?? {})) {
    const current = live.limits.get(name);
    if (limit === null) {
      if (current) changes.push({ section: 'limits', key: name, op: 'delete', direction: 'loosening', reason: `archives the limit (${current.limit} ${current.unit} per ${current.period})` });
      else unchanged++;
      continue;
    }
    if (!current) {
      changes.push({ section: 'limits', key: name, op: 'create', direction: 'tightening', reason: `adds a limit of ${limit.amount} ${limit.currency ?? limit.dimension} per ${limit.period}` });
      continue;
    }
    const { amount: _wanted, ...shape } = limit;
    const { amount: _live, ...liveShape } = limitToFile(current);
    if (!same(shape, liveShape)) {
      changes.push({ section: 'limits', key: name, op: 'replace', direction: 'loosening', reason: 'changes what the limit counts: the old limit is archived and a new one created', fields: Object.keys({ ...shape, ...liveShape }).filter((k) => !same((shape as Record<string, unknown>)[k], (liveShape as Record<string, unknown>)[k])) });
      continue;
    }
    const amount = capDirection('limit', current.limit, limit.amount);
    if (amount) changes.push({ section: 'limits', key: name, op: 'update', ...amount, fields: ['amount'] });
    else unchanged++;
  }

  for (const [keyId, budget] of Object.entries(spec.budgets ?? {})) {
    const current = live.budgets.get(keyId);
    if (budget === null) {
      if (current) changes.push({ section: 'budgets', key: keyId, op: 'delete', direction: current.enabled ? 'loosening' : 'neutral', reason: 'removes the key\'s budget' });
      else unchanged++;
      continue;
    }
    const before = current ? budgetToFile(current) : { monthlyCostCentsCap: null, dimensionCaps: {}, alertThreshold: 1, enabled: false };
    const parts: { direction: Direction; reason: string }[] = [];
    const fields: string[] = [];
    if (budget.monthlyCostCentsCap !== undefined) {
      const c = capDirection('monthly cost cap', before.monthlyCostCentsCap, budget.monthlyCostCentsCap);
      if (c) (parts.push(c), fields.push('monthlyCostCentsCap'));
    }
    if (budget.dimensionCaps !== undefined) {
      for (const dimension of BUDGET_DIMENSIONS) {
        const c = capDirection(`${dimension} cap`, before.dimensionCaps?.[dimension], budget.dimensionCaps[dimension]);
        if (c) (parts.push(c), fields.push(`dimensionCaps.${dimension}`));
      }
    }
    if (budget.alertThreshold !== undefined && budget.alertThreshold !== before.alertThreshold) {
      parts.push(budget.alertThreshold > (before.alertThreshold ?? 1) ? { direction: 'loosening', reason: 'alerts later' } : { direction: 'tightening', reason: 'alerts earlier' });
      fields.push('alertThreshold');
    }
    const wantEnabled = budget.enabled ?? (current ? current.enabled : true);
    if (wantEnabled !== (current?.enabled ?? false)) {
      parts.push(wantEnabled ? { direction: 'tightening', reason: 'turns the budget on' } : { direction: 'loosening', reason: 'turns the budget off' });
      fields.push('enabled');
    }
    if (!fields.length) unchanged++;
    else changes.push({ section: 'budgets', key: keyId, op: current ? 'update' : 'create', ...combine(parts), fields });
  }

  const mcp = planMcp(spec, live);
  changes.push(...mcp.changes);
  policyErrors.push(...mcp.errors);
  unchanged += mcp.unchanged;

  const summary = { tightening: 0, loosening: 0, neutral: 0, 'needs-person': 0, unchanged };
  for (const change of changes) summary[change.direction]++;
  const result: Plan = { file, environment: env, changes, summary, errors: policyErrors };
  return { plan: result, work: { plan: result, spec, live, policyFile, looseningPolicies } };
}

export interface Applied {
  section: Section;
  key: string;
  outcome: 'applied' | 'sign-off' | 'skipped' | 'failed';
  signOff?: SignOff;
  error?: string;
}

/**
 * Apply a plan. Changes that tighten or change nothing go through at once. A loosening change is
 * sent too: with a person's console session the server would apply it, but a CLI login or an API
 * key gets a 202 and a sign-off link, collected here. Policies are applied in two passes so a
 * tightening policy never waits behind a loosening one in the same file.
 */
export async function apply(rt: Runtime, connection: Connection, work: Work): Promise<Applied[]> {
  const { client } = connection;
  const results: Applied[] = [];
  const { spec, live, plan: planned } = work;
  const wanted = (section: Section) => planned.changes.filter((change) => change.section === section);

  const send = async (section: Section, key: string, call: () => Promise<{ status: number; signoff?: SignOff }>) => {
    try {
      const response = await call();
      results.push(response.signoff ? { section, key, outcome: 'sign-off', signOff: response.signoff } : { section, key, outcome: 'applied' });
    } catch (error) {
      const signOff = signOffFromError(error);
      if (signOff) results.push({ section, key, outcome: 'sign-off', signOff });
      else results.push({ section, key, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };
  const request = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown) => () => apiRequest(rt, connection, method, path, body);

  for (const change of wanted('secrets')) results.push({ section: 'secrets', key: change.key, outcome: 'skipped', error: 'a person stores the value' });

  for (const change of wanted('limits').filter((c) => c.direction !== 'loosening')) {
    const limit = spec.limits![change.key]!;
    const current = live.limits.get(change.key);
    if (change.op === 'create') await send('limits', change.key, request('POST', '/api/v2/impact-limits', limitBody(change.key, limit)));
    else await send('limits', change.key, request('PATCH', `/api/v2/impact-limits/${encodeURIComponent(current!.id)}`, { amount: limit.amount }));
  }
  for (const change of wanted('budgets').filter((c) => c.direction !== 'loosening')) await sendBudget(change);

  for (const change of wanted('actions')) {
    const action = spec.actions![change.key]!;
    if (change.op === 'create') await send('actions', change.key, request('POST', '/api/v2/actions', { name: change.key, ...actionBody(action) }));
    else {
      const body = Object.fromEntries((change.fields ?? []).map((field) => [ACTION_FIELDS[field as keyof ActionSpec], action[field as keyof ActionSpec] ?? null]));
      await send('actions', change.key, request('PATCH', `/api/v2/actions/${encodeURIComponent(change.key)}`, body));
    }
  }

  for (const change of wanted('packs')) {
    const pack = spec.packs?.[change.key];
    await send('packs', change.key, async () => {
      await client.packs.install(await readManifest(change.key), packOptions(pack));
      return { status: 200 };
    });
  }

  const policyChanges = wanted('policies');
  if (policyChanges.length && live.policies) {
    const all = spec.policies ?? {};
    const keys = policyChanges.map((c) => c.key).join(', ');
    if (work.looseningPolicies.size && policyChanges.some((c) => !work.looseningPolicies.has(c.key))) {
      const held: Record<string, PolicySpec> = {};
      for (const [key, policy] of Object.entries(all)) {
        if (!work.looseningPolicies.has(key)) held[key] = policy;
        else if (live.policies.live.has(key)) held[key] = policyToFile(live.policies.live.get(key)!);
      }
      for (const [key, policy] of live.policies.live) if (!(key in all) && work.looseningPolicies.has(key)) held[key] = policyToFile(policy);
      await send('policies', `${keys} (tightening)`, () => applyPolicies(rt, connection, client, work, held));
    }
    await send('policies', keys, () => applyPolicies(rt, connection, client, work, all));
  }

  for (const change of wanted('limits').filter((c) => c.direction === 'loosening')) {
    const current = live.limits.get(change.key);
    const limit = spec.limits![change.key];
    if (change.op === 'update') await send('limits', change.key, request('PATCH', `/api/v2/impact-limits/${encodeURIComponent(current!.id)}`, { amount: limit!.amount }));
    else if (change.op === 'delete') await send('limits', change.key, request('DELETE', `/api/v2/impact-limits/${encodeURIComponent(current!.id)}`));
    else {
      await send('limits', `${change.key} (archive)`, request('DELETE', `/api/v2/impact-limits/${encodeURIComponent(current!.id)}`));
      await send('limits', change.key, request('POST', '/api/v2/impact-limits', limitBody(change.key, limit!)));
    }
  }
  for (const change of wanted('budgets').filter((c) => c.direction === 'loosening')) await sendBudget(change);
  await applyMcp();
  return results;

  async function applyMcp(): Promise<void> {
    const changes = wanted('mcp');
    for (const name of new Set(changes.map((change) => change.key.split('/')[0]!))) {
      const server = spec.mcp![name];
      let upstream = live.upstreams.get(name);
      if (server === null || server === undefined) {
        await send('mcp', name, request('POST', `/api/v2/mcp-upstreams/${encodeURIComponent(upstream!.id)}/archive`));
        continue;
      }
      const tools = changes.filter((change) => change.key.startsWith(`${name}/`));
      if (!upstream) {
        await send('mcp', name, async () => {
          const response = await apiRequest<McpUpstream>(rt, connection, 'POST', '/api/v2/mcp-upstreams', registerBody(name, server));
          if (!response.signoff) upstream = response.data;
          return response;
        });
      }
      for (const change of tools.filter((c) => c.op === 'missing')) results.push({ section: 'mcp', key: change.key, outcome: 'skipped', error: change.reason });
      const toAdopt = tools.filter((c) => c.op !== 'missing' && !c.fields);
      if (!upstream) {
        for (const change of toAdopt) results.push({ section: 'mcp', key: change.key, outcome: 'skipped', error: 'the server is not registered yet. Apply again once it is.' });
        continue;
      }
      for (const change of tools.filter((c) => c.fields)) {
        const tool = change.key.slice(name.length + 1);
        const action = upstream.adopted.find((entry) => entry.tool === tool)!.action;
        await send('mcp', change.key, request('PATCH', `/api/v2/actions/${encodeURIComponent(action)}`, { requiresApproval: server.adopt![tool]!.requiresApproval }));
      }
      if (!toAdopt.length) continue;
      const known = new Map(upstream.tools.map((tool) => [tool.name, tool]));
      const choices: Record<string, McpToolChoice> = {};
      for (const change of toAdopt) {
        const tool = change.key.slice(name.length + 1);
        const listed = known.get(tool);
        if (!listed) {
          results.push({ section: 'mcp', key: change.key, outcome: 'skipped', error: `the server does not list it. Check with: anlyon mcp tools ${name} --refresh` });
          continue;
        }
        const settings = server.adopt![tool];
        choices[tool] = {
          requiresApproval: settings?.requiresApproval ?? ['irreversible', 'destructive'].includes(listed.suggestedClass),
          ...(settings?.description ? { description: settings.description } : {}),
        };
      }
      const names = Object.keys(choices);
      if (names.length) await send('mcp', `${name}/${names.join(', ')}`, request('POST', `/api/v2/mcp-upstreams/${encodeURIComponent(upstream.id)}/adopt`, { tools: choices }));
    }
  }

  async function sendBudget(change: PlannedChange): Promise<void> {
    const budget = spec.budgets![change.key];
    const path = `/api/v2/budgets/${encodeURIComponent(change.key)}`;
    if (budget === null) await send('budgets', change.key, request('DELETE', path));
    else await send('budgets', change.key, request('PUT', path, budget));
  }
}

async function applyPolicies(rt: Runtime, connection: Connection, client: Client, work: Work, policies: Record<string, PolicySpec>) {
  const source = policySource(work.policyFile, work.plan.environment.slug, policies);
  const fresh = (await client.approvalPolicies.planFile(source)).data!;
  if (fresh.errors.length) throw new CliError('POLICY_FILE_INVALID', fresh.errors.join('; '), EXIT.REJECTED);
  if (fresh.changes.every((change) => change.op === 'unchanged')) return { status: 200 };
  return apiRequest(rt, connection, 'POST', '/api/v2/approval-policies/files/apply', { source, digest: fresh.digest, changeNote: `anlyon apply (${work.plan.file})` });
}

function limitBody(name: string, limit: LimitSpec): Record<string, unknown> {
  return {
    name, dimension: limit.dimension, period: limit.period, amount: limit.amount,
    ...(limit.currency ? { currency: limit.currency } : {}),
    ...(limit.action ? { actionName: limit.action } : {}),
    ...(limit.resourcePrefix ? { resourcePrefix: limit.resourcePrefix } : {}),
    ...(limit.scope ? { scope: limit.scope } : {}),
  };
}

function registerBody(name: string, server: McpServerSpec): Record<string, unknown> {
  return {
    name, url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
    ...(server.oauth ? { oauth: server.oauth } : {}),
  };
}

function actionBody(action: ActionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(action)) if (value !== undefined) body[ACTION_FIELDS[field as keyof ActionSpec]] = value;
  return body;
}

/** A live server as the file writes it. A client secret is not read back: put its reference in by hand. */
export function upstreamToFile(upstream: McpUpstream): McpServerSpec {
  const out: McpServerSpec = { url: upstream.url };
  if (Object.keys(upstream.headers ?? {}).length) out.headers = upstream.headers;
  if (upstream.oauth) {
    out.oauth = {
      ...(upstream.oauth.clientRegistration === 'pre_registered' ? { clientId: upstream.oauth.clientId } : {}),
      ...(upstream.oauth.scopes.length ? { scopes: upstream.oauth.scopes } : {}),
    };
  }
  if (upstream.adopted.length) {
    out.adopt = Object.fromEntries([...upstream.adopted].sort((a, b) => a.tool.localeCompare(b.tool)).map((entry) => [entry.tool, { requiresApproval: entry.requiresApproval }]));
  }
  return out;
}

/** The live environment as an anlyon.yaml environment entry. Secret names only, never values. */
export async function pull(connection: Connection, config: ConfigFile | undefined): Promise<EnvironmentSpec> {
  const { client, environment } = connection;
  const existing = config?.environments?.[environment.slug] ?? {};
  const policyFile = config?.policyFile ?? DEFAULT_POLICY_FILE;
  const [actions, limits, budgets, upstreams] = await Promise.all([
    client.actions.list().then((r) => r.data ?? []),
    client.impactLimits.list().then((r) => r.data ?? []),
    client.budgets.list().then((r) => r.data ?? []).catch((error: unknown) => {
      if ((error as { status?: number }).status === 403) return null;
      throw error;
    }),
    client.mcpUpstreams.list().then((r) => r.data ?? []).catch((error: unknown) => {
      if ([403, 404].includes((error as { status?: number }).status ?? 0)) return null;
      throw error;
    }),
  ]);
  const adoptedActions = new Set((upstreams ?? []).flatMap((upstream) => upstream.adopted.map((entry) => entry.action)));
  const packPrefixes = Object.keys(existing.packs ?? {}).map((name) => `${packShortName(name.includes('/') ? name : `anlyon/${name}`)}-`);
  const out: EnvironmentSpec = {};
  const secretNames = new Set<string>(existing.secrets ?? []);
  const pulledActions: Record<string, ActionSpec> = {};
  for (const action of actions.sort((a, b) => a.name.localeCompare(b.name))) {
    if (packPrefixes.some((prefix) => action.name.startsWith(prefix))) continue;
    for (const name of action.secrets ?? []) secretNames.add(name);
    if (!adoptedActions.has(action.name)) pulledActions[action.name] = actionToFile(action);
  }
  for (const upstream of upstreams ?? []) {
    for (const match of JSON.stringify(upstream.headers ?? {}).matchAll(/\{\{\s*secret:([A-Z0-9_]+)\s*\}\}/g)) secretNames.add(match[1]!);
  }
  if (secretNames.size) out.secrets = [...secretNames].sort();
  if (existing.packs) out.packs = existing.packs;
  if (Object.keys(pulledActions).length) out.actions = pulledActions;

  const empty = (await client.approvalPolicies.planFile(policySource(policyFile, environment.slug, {}))).data!;
  const owned = empty.changes.filter((change) => change.op === 'delete' && change.policyId);
  if (owned.length) {
    const policies: Record<string, PolicySpec> = {};
    for (const change of owned.sort((a, b) => a.key.localeCompare(b.key))) policies[change.key] = policyToFile((await client.approvalPolicies.get(change.policyId!)).data!);
    out.policies = policies;
  } else if (existing.policies && Object.keys(existing.policies).length === 0) out.policies = {};

  const pulledLimits: Record<string, LimitSpec> = {};
  for (const limit of limits.filter((l) => !l.archived).sort((a, b) => a.name.localeCompare(b.name))) pulledLimits[limit.name] = limitToFile(limit);
  if (Object.keys(pulledLimits).length) out.limits = pulledLimits;

  if (budgets === null) {
    if (existing.budgets) out.budgets = existing.budgets;
  } else if (budgets.length) {
    out.budgets = Object.fromEntries(budgets.map((budget) => [budget.apiKeyId, budgetToFile(budget)]));
  }

  if (upstreams === null) {
    if (existing.mcp) out.mcp = existing.mcp;
  } else if (upstreams.length) {
    out.mcp = Object.fromEntries([...upstreams].sort((a, b) => a.name.localeCompare(b.name)).map((upstream) => [upstream.name, upstreamToFile(upstream)]));
  }
  return out;
}
