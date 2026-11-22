import { parseDocument } from 'yaml';
import { usageError } from '../errors';

/**
 * anlyon.yaml: an environment's guardrails, kept in the repository and changed by review.
 *
 *   version: 1
 *   environments:
 *     production:                 # an environment slug; a credential acts on its own environment only
 *       secrets: [GITHUB]         # names that must exist. Values never go in this file.
 *       packs:
 *         github: { actions: [get-issue, create-issue], withLimits: true }
 *       actions:
 *         send-receipt: { method: POST, url: https://..., headers: { Authorization: "Bearer {{secret:POSTMARK}}" },
 *                         impact: { dimension: emails, amount: count(input.to), bound: exact } }
 *       policies:                 # the policies block of an anlyon.com/policies/v1 policy file
 *         big-refunds: { name: Big refunds need two approvers, target: { action: refund }, when: input.amount >= 50000, approvals: 2 }
 *       limits:
 *         Emails per day: { dimension: emails, amount: 500, period: day }
 *         Old limit: null         # archive it
 *       budgets:
 *         <api key id>: { monthlyCostCentsCap: 5000, dimensionCaps: { actionInvokes: 10000 } }
 *       mcp:                      # remote MCP servers, and the tools adopted from them
 *         tracker:
 *           url: https://mcp.tracker.example/mcp
 *           headers: { Authorization: "Bearer {{secret:TRACKER}}" }
 *           adopt:                # a person signs each adoption off; the file only asks for it
 *             list_issues:
 *             delete_issue: { requiresApproval: true }
 *         old-server: null        # archive it
 *
 * The file is the source of truth for what it names. Policies are owned server-side by the file
 * (`policyFile`, default `anlyon.yaml`), so removing one from the file deletes it. Actions, limits
 * and budgets the file does not name are left alone; `null` archives a limit or removes a budget.
 */
export const CONFIG_FILE = 'anlyon.yaml';
export const CONFIG_VERSION = 1;
export const DEFAULT_POLICY_FILE = 'anlyon.yaml';

export type ActionMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ImpactSpec { dimension: string; unit?: string; amount: string | number; bound: 'exact' | 'upper_bound' }
export interface VerifySpec { url: string; status: number; match?: { path: string; equals: string | number | boolean | null }[] }

export interface ActionSpec {
  description?: string;
  method?: ActionMethod;
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
  enabled?: boolean;
  governed?: boolean;
  impact?: ImpactSpec | null;
  verify?: VerifySpec | null;
}

export interface PolicySpec {
  name: string;
  target: { action?: string; allActions?: true; customRequests?: true; allRequests?: true };
  when?: string;
  effect?: 'require_approval' | 'auto_approve' | 'auto_deny';
  approvals?: number;
  priority?: number;
  enabled?: boolean;
  agent?: string;
  user?: string;
  tags?: string[];
  acknowledgeBroadScope?: boolean;
}

export interface LimitSpec {
  dimension: string;
  currency?: string;
  amount: number;
  period: 'day' | 'month' | 'total';
  action?: string;
  resourcePrefix?: string;
  scope?: 'environment' | 'end_user';
}

export interface BudgetSpec {
  monthlyCostCentsCap?: number | null;
  dimensionCaps?: Partial<Record<BudgetDimension, number>>;
  alertThreshold?: number;
  enabled?: boolean;
}

export const BUDGET_DIMENSIONS = ['messages', 'eventPublishes', 'actionInvokes'] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export interface PackSpec {
  actions?: string[];
  withLimits?: boolean;
  secretNames?: Record<string, string>;
  params?: Record<string, string>;
  credential?: 'connection' | 'secret';
  noPrefix?: boolean;
}

export interface McpToolSpec {
  /** Default on adoption: what the risk engine suggests, so irreversible and destructive tools wait for approval. */
  requiresApproval?: boolean;
  /** What agents read, instead of the tool's own text. Used when the tool is adopted. */
  description?: string;
}

export interface McpServerSpec {
  url: string;
  headers?: Record<string, string>;
  /** The server signs people in with OAuth. A person signs the registration off and connects an account in the console. */
  oauth?: { clientId?: string; clientSecret?: string; scopes?: string[] };
  /** The tools adopted, by name. An empty entry takes the defaults. */
  adopt?: Record<string, McpToolSpec | null>;
}

export interface EnvironmentSpec {
  secrets?: string[];
  packs?: Record<string, PackSpec>;
  actions?: Record<string, ActionSpec>;
  policies?: Record<string, PolicySpec>;
  limits?: Record<string, LimitSpec | null>;
  budgets?: Record<string, BudgetSpec | null>;
  mcp?: Record<string, McpServerSpec | null>;
}

export interface ConfigFile {
  version: 1;
  policyFile?: string;
  environments: Record<string, EnvironmentSpec>;
}

const SECRET_NAME = /^[A-Z0-9_]+$/;
const ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const POLICY_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const POLICY_FILE_ID = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
const API_KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SECTIONS = ['secrets', 'packs', 'actions', 'policies', 'limits', 'budgets', 'mcp'];

/**
 * Strings that look like a credential rather than a reference to one. The file is committed, so a
 * value here is a leaked key: refuse it and say where it belongs.
 */
const CREDENTIAL_SHAPES = [
  /\banlyon_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)$/i;

export class ConfigProblems {
  readonly list: string[] = [];
  add(where: string, message: string): void {
    this.list.push(`${where}: ${message}`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(problems: ConfigProblems, where: string, value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.add(where, `unknown field "${key}" (allowed: ${allowed.join(', ')})`);
}

function noCredentials(problems: ConfigProblems, where: string, value: unknown): void {
  if (typeof value === 'string') {
    if (CREDENTIAL_SHAPES.some((shape) => shape.test(value))) {
      problems.add(where, 'looks like a credential. Store it as a secret and reference it as {{secret:NAME}}; secret values never go in this file.');
    }
  } else if (Array.isArray(value)) value.forEach((item, i) => noCredentials(problems, `${where}[${i}]`, item));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) noCredentials(problems, `${where}.${key}`, item);
}

function checkHeaders(problems: ConfigProblems, where: string, headers: unknown): void {
  if (headers === undefined) return;
  if (!isObject(headers)) return problems.add(`${where}.headers`, 'must be a mapping of header to value');
  for (const [header, text] of Object.entries(headers)) {
    if (typeof text !== 'string') problems.add(`${where}.headers.${header}`, 'must be a string');
    else if (CREDENTIAL_HEADERS.test(header) && !/\{\{\s*(secret|connection)[:.]/.test(text)) {
      problems.add(`${where}.headers.${header}`, 'carries a credential in the clear. Reference a stored secret instead: "Bearer {{secret:NAME}}".');
    }
  }
}

function checkMcpServer(problems: ConfigProblems, where: string, value: unknown): void {
  if (value === null) return;
  if (!isObject(value)) return problems.add(where, 'must be a mapping, or null to archive the server');
  onlyKeys(problems, where, value, ['url', 'headers', 'oauth', 'adopt']);
  if (typeof value.url !== 'string' || !value.url.startsWith('https://')) problems.add(where, "url is required: the server's Streamable HTTP endpoint, https");
  checkHeaders(problems, where, value.headers);
  if (value.oauth !== undefined && value.oauth !== null) {
    if (!isObject(value.oauth)) problems.add(`${where}.oauth`, 'must be a mapping (or empty)');
    else {
      onlyKeys(problems, `${where}.oauth`, value.oauth, ['clientId', 'clientSecret', 'scopes']);
      if (value.oauth.clientSecret !== undefined && !/^\{\{\s*secret:[A-Z0-9_]+\s*\}\}$/.test(String(value.oauth.clientSecret))) {
        problems.add(`${where}.oauth.clientSecret`, 'must be a reference to a stored secret: "{{secret:NAME}}".');
      }
    }
  }
  if (value.adopt === undefined || value.adopt === null) return;
  if (!isObject(value.adopt)) return problems.add(`${where}.adopt`, 'must be a mapping of tool name to its settings (or empty)');
  for (const [tool, settings] of Object.entries(value.adopt)) {
    const at = `${where}.adopt.${tool}`;
    if (settings === null) continue;
    if (!isObject(settings)) {
      problems.add(at, 'must be a mapping (or empty)');
      continue;
    }
    onlyKeys(problems, at, settings, ['requiresApproval', 'description']);
    if (settings.requiresApproval !== undefined && typeof settings.requiresApproval !== 'boolean') problems.add(`${at}.requiresApproval`, 'must be true or false');
  }
}

function checkAction(problems: ConfigProblems, where: string, value: unknown): void {
  if (!isObject(value)) return problems.add(where, 'must be a mapping');
  onlyKeys(problems, where, value, ['description', 'method', 'url', 'headers', 'body', 'inputSchema', 'requiresApproval', 'enabled', 'governed', 'impact', 'verify']);
  if (typeof value.url !== 'string' || !value.url) problems.add(where, 'url is required');
  if (value.method !== undefined && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(value.method))) problems.add(where, 'method is GET, POST, PUT, PATCH or DELETE');
  checkHeaders(problems, where, value.headers);
  for (const flag of ['requiresApproval', 'enabled', 'governed']) if (value[flag] !== undefined && typeof value[flag] !== 'boolean') problems.add(`${where}.${flag}`, 'must be true or false');
  if (value.impact !== undefined && value.impact !== null) {
    const impact = value.impact;
    if (!isObject(impact)) problems.add(`${where}.impact`, 'must be a mapping or null');
    else {
      onlyKeys(problems, `${where}.impact`, impact, ['dimension', 'unit', 'amount', 'bound']);
      if (typeof impact.dimension !== 'string') problems.add(`${where}.impact`, 'dimension is required');
      if (typeof impact.amount !== 'string' && typeof impact.amount !== 'number') problems.add(`${where}.impact`, 'amount is required');
      if (impact.bound !== 'exact' && impact.bound !== 'upper_bound') problems.add(`${where}.impact`, 'bound is exact or upper_bound');
      if (impact.dimension === 'money' && typeof impact.unit !== 'string') problems.add(`${where}.impact`, 'money needs unit, the currency (e.g. usd)');
    }
  }
  if (value.verify !== undefined && value.verify !== null) {
    const verify = value.verify;
    if (!isObject(verify)) problems.add(`${where}.verify`, 'must be a mapping or null');
    else {
      onlyKeys(problems, `${where}.verify`, verify, ['url', 'status', 'match']);
      if (typeof verify.url !== 'string') problems.add(`${where}.verify`, 'url is required');
      if (typeof verify.status !== 'number') problems.add(`${where}.verify`, 'status is required, e.g. 200');
    }
  }
}

function checkPolicy(problems: ConfigProblems, where: string, value: unknown): void {
  if (!isObject(value)) return problems.add(where, 'must be a mapping');
  onlyKeys(problems, where, value, ['name', 'target', 'when', 'effect', 'approvals', 'priority', 'enabled', 'agent', 'user', 'tags', 'acknowledgeBroadScope']);
  if (typeof value.name !== 'string' || !value.name) problems.add(where, 'name is required');
  if (!isObject(value.target) || Object.keys(value.target).length !== 1) problems.add(where, 'target needs exactly one of: action, allActions, customRequests, allRequests');
  if (value.effect !== undefined && !['require_approval', 'auto_approve', 'auto_deny'].includes(String(value.effect))) problems.add(where, 'effect is require_approval, auto_approve or auto_deny');
  if (value.approvals !== undefined && !(Number.isInteger(value.approvals) && (value.approvals as number) >= 1 && (value.approvals as number) <= 20)) problems.add(where, 'approvals is 1 to 20');
}

function checkLimit(problems: ConfigProblems, where: string, value: unknown): void {
  if (value === null) return;
  if (!isObject(value)) return problems.add(where, 'must be a mapping, or null to archive the limit');
  onlyKeys(problems, where, value, ['dimension', 'currency', 'amount', 'period', 'action', 'resourcePrefix', 'scope']);
  if (typeof value.dimension !== 'string') problems.add(where, 'dimension is required (money, resource_mutations, or a unit such as emails)');
  if (!(Number.isInteger(value.amount) && (value.amount as number) >= 0)) problems.add(where, 'amount is a whole number, 0 or more');
  if (!['day', 'month', 'total'].includes(String(value.period))) problems.add(where, 'period is day, month or total');
  if (value.dimension === 'money' && typeof value.currency !== 'string') problems.add(where, 'money needs currency, e.g. usd');
  if (value.scope !== undefined && value.scope !== 'environment' && value.scope !== 'end_user') problems.add(where, 'scope is environment or end_user');
}

function checkBudget(problems: ConfigProblems, where: string, key: string, value: unknown): void {
  if (!API_KEY_ID.test(key)) problems.add(where, 'a budget is keyed by the API key id it caps (a UUID; see `anlyon pull`)');
  if (value === null) return;
  if (!isObject(value)) return problems.add(where, 'must be a mapping, or null to remove the budget');
  onlyKeys(problems, where, value, ['monthlyCostCentsCap', 'dimensionCaps', 'alertThreshold', 'enabled']);
  if (value.dimensionCaps !== undefined) {
    if (!isObject(value.dimensionCaps)) problems.add(`${where}.dimensionCaps`, 'must be a mapping');
    else onlyKeys(problems, `${where}.dimensionCaps`, value.dimensionCaps, [...BUDGET_DIMENSIONS]);
  }
}

function checkPack(problems: ConfigProblems, where: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) return problems.add(where, 'must be a mapping (or empty)');
  onlyKeys(problems, where, value, ['actions', 'withLimits', 'secretNames', 'params', 'credential', 'noPrefix']);
  if (value.secretNames !== undefined && isObject(value.secretNames)) {
    for (const [from, to] of Object.entries(value.secretNames)) if (!SECRET_NAME.test(from) || typeof to !== 'string' || !SECRET_NAME.test(to)) problems.add(`${where}.secretNames`, 'maps secret names to secret names, e.g. GITHUB: GITHUB_BOT');
  }
}

/** Parse and check the file. Every problem is reported at once, with where it is. */
export function parseConfig(source: string, file = CONFIG_FILE): ConfigFile {
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: true });
  if (document.errors.length) throw usageError(`${file} is not valid YAML: ${document.errors[0]!.message.split('\n')[0]}`);
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw usageError(`${file} uses YAML aliases, which it does not allow.`);
  }
  const problems = new ConfigProblems();
  if (!isObject(raw)) throw usageError(`${file} must be a mapping with version and environments.`);
  onlyKeys(problems, file, raw, ['version', 'policyFile', 'environments']);
  if (raw.version !== CONFIG_VERSION) problems.add(file, `version must be ${CONFIG_VERSION}`);
  if (raw.policyFile !== undefined && (typeof raw.policyFile !== 'string' || !POLICY_FILE_ID.test(raw.policyFile))) {
    problems.add(`${file}.policyFile`, "is a stable id: lowercase letters, digits, '.', '_', '-', '/'");
  }
  if (!isObject(raw.environments)) problems.add(file, 'environments is required: one mapping per environment slug');
  else for (const [slug, env] of Object.entries(raw.environments)) {
    const where = `environments.${slug}`;
    if (env === null) continue;
    if (!isObject(env)) {
      problems.add(where, 'must be a mapping');
      continue;
    }
    onlyKeys(problems, where, env, SECTIONS);
    if (env.secrets !== undefined && (!Array.isArray(env.secrets) || env.secrets.some((name) => typeof name !== 'string' || !SECRET_NAME.test(name)))) {
      problems.add(`${where}.secrets`, 'is a list of secret names (uppercase letters, digits, _). Never values.');
    }
    for (const [section, check] of [
      ['packs', (w: string, _k: string, v: unknown) => checkPack(problems, w, v)],
      ['actions', (w: string, k: string, v: unknown) => (ACTION_NAME.test(k) ? checkAction(problems, w, v) : problems.add(w, 'is not a valid action name'))],
      ['policies', (w: string, k: string, v: unknown) => (POLICY_KEY.test(k) ? checkPolicy(problems, w, v) : problems.add(w, "policy keys use lowercase letters, digits, '-' and '_'"))],
      ['limits', (w: string, _k: string, v: unknown) => checkLimit(problems, w, v)],
      ['budgets', (w: string, k: string, v: unknown) => checkBudget(problems, w, k, v)],
      ['mcp', (w: string, k: string, v: unknown) => (MCP_SERVER_NAME.test(k) ? checkMcpServer(problems, w, v) : problems.add(w, 'a server name is 1 to 32 lowercase letters, digits and hyphens, starting with a letter'))],
    ] as const) {
      const value = env[section];
      if (value === undefined || value === null) continue;
      if (!isObject(value)) {
        problems.add(`${where}.${section}`, 'must be a mapping');
        continue;
      }
      for (const [key, item] of Object.entries(value)) check(`${where}.${section}.${key}`, key, item);
    }
    noCredentials(problems, where, env);
  }
  if (problems.list.length) {
    throw usageError(`${file} has ${problems.list.length} problem${problems.list.length === 1 ? '' : 's'}:\n  ${problems.list.join('\n  ')}`);
  }
  return raw as unknown as ConfigFile;
}
