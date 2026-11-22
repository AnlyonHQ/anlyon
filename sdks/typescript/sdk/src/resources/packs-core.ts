/**
 * Action Packs: install a governed workflow from a declarative manifest (`anlyon-pack/v1`).
 *
 * A pack is a file of secrets, declared actions, default approval policies and suggested impact
 * limits. Installing one is a batch of the API calls you could make by hand (secrets, actions,
 * approval policies, impact limits). There is no pack endpoint: the CLI and the console install the
 * same way, through this module.
 *
 * Rules the installer enforces (packs/README.md is the reference):
 *
 * - Every action's host must be among the hosts of the secrets it references. Checked before any call.
 * - Policies are created disabled whatever the manifest says, and an `auto_approve` policy is refused.
 * - Limits are created only with `withLimits`; otherwise they are returned as suggestions.
 * - An action that sends `{{connection:<integration>}}` needs nothing in the workspace at install:
 *   each call uses its end user's own account, or the environment's connected account when the call
 *   names no end user. With `credential: 'secret'`, or a renamed secret, it is bound to a named
 *   workspace secret instead (`{{secret:NAME}}`).
 * - A connected account an action names (`{{secret:NAME}}`, an adapter's credential) that does not
 *   exist yet stops the install with the command that connects it. A static secret takes its value
 *   from `secrets`, or from `resolveSecret`.
 * - Installing twice changes nothing: an identical action is skipped, a different one is refused
 *   unless `update` is set, which creates a new action version.
 * - Action names are prefixed with the pack's short name unless `noPrefix` is set.
 *
 * `plan` runs exactly the same code with writes disabled: it reads, decides, and sends nothing.
 *
 * This file has no runtime imports: the console imports it directly and supplies its own
 * transport (session-authenticated), and the SDK's PacksResource (packs.ts) supplies one built
 * from its resources.
 */

import type { Action, ApprovalPolicy, CreateApprovalPolicyRequest, PutSecretRequest, Secret } from '../types/agent';
import type { ActionAdapter, ActionImpactDeclarationInput, ActionVerifyDeclarationInput, CreateImpactLimitRequest, ImpactLimit } from '../types/effects';

export const PACK_FORMAT = 'anlyon-pack/v1';

export interface PackSecret {
  /**
   * Referenced from templates as {{secret:NAME}}. ^[A-Z0-9_]+$. A connected account may instead be
   * referenced as {{connection:<integrationId>}}; this name is then the workspace secret it binds to
   * when installed with `credential: 'secret'`.
   */
  name: string;
  /**
   * `connection`: an account connected for `integrationId`, by signing in or with an API key.
   * Referenced as {{connection:<integrationId>}}, nothing needs to exist at install. Referenced by
   * name, it must exist before the pack is installed. `static`: a value you store, which install writes.
   */
  kind: 'connection' | 'static';
  /** For a connected account: the integration id, e.g. `hubspot`. */
  integrationId?: string;
  /** The API hosts the secret may be sent to. Every action using it must address one of these. */
  hosts: string[];
  /**
   * For a connected account of an integration whose host differs per account: the catalogue's host
   * template, e.g. `{subdomain}.zendesk.com`. `hosts` is then empty, and every action using it
   * addresses `https://{{connection.host}}/…`, which the API fills per call with the account's own
   * host, checked against this template.
   */
  accountHost?: string;
  description?: string;
}

export interface PackParameter {
  /** Referenced as {{param:NAME}} in an action's URL path, body, read-back or adapter config (never a header). ^[a-z][a-z0-9_]*$ */
  name: string;
  description: string;
  default?: string;
  /** Allowed values. */
  enum?: string[];
  /** A regular expression the value must match. */
  pattern?: string;
}

interface PackActionBase {
  /** Unprefixed; the installer adds the pack's short name. ^[a-z0-9][a-z0-9-]{0,59}$ */
  name: string;
  /**
   * `read`: the provider's response goes back to the caller; it changes nothing, so it declares no
   * impact and no read-back. `write` (the default): governed, with a declared impact.
   */
  kind?: 'read' | 'write';
  /** What a reviewer reads in the preview. Limitations belong here too. */
  description: string;
  requiresApproval?: boolean;
}

export interface PackDeclaredAction extends PackActionBase {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  /** Required on a write; absent on a read. */
  impact?: ActionImpactDeclarationInput;
  /**
   * A write's read-back. Absent on a read, and on a write the provider gives no way to read back,
   * whose receipt is then graded acknowledged.
   */
  verify?: ActionVerifyDeclarationInput;
  /**
   * A GraphQL operation: a POST whose body is `{ query, variables }`, with the query a fixed literal
   * (no placeholder) and only the variables taken from the input. A read's query must be read-only:
   * no mutation and no subscription. Checked by the installer; not sent to the API.
   */
  graphql?: true;
  adapter?: never;
}

export interface PackAdapterAction extends PackActionBase {
  /** An existing Anlyon adapter. Its config may use {{param:NAME}}. */
  adapter: ActionAdapter;
  method?: never;
  urlTemplate?: never;
}

/**
 * An action taken from another pack, by `<pack>#<action>`. Workflow packs use this to reuse a
 * catalogue pack's operations instead of copying them. Expanded before validation through
 * `resolvePack`; the referenced action keeps its definition and takes this entry's name.
 */
export interface PackActionRef {
  name: string;
  ref: string;
}

export type PackAction = PackDeclaredAction | PackAdapterAction;

/** Whether an action reads (changes nothing) or writes. An adapter always writes. */
export function packActionKind(action: PackAction): 'read' | 'write' {
  return action.kind === 'read' ? 'read' : 'write';
}

export interface PackPolicy {
  name: string;
  matchKind: 'action';
  /** Unprefixed action name from this manifest. */
  matchActionName: string;
  condition?: string;
  effect: 'require_approval' | 'auto_deny';
  requiredApprovals?: number;
  /** Ignored: a pack's policies always install disabled. */
  enabled?: boolean;
}

export interface PackLimit {
  name: string;
  dimension: string;
  currency?: string;
  period: 'day' | 'month' | 'total';
  amount: number;
  /** Unprefixed action name from this manifest, or omitted for every action in the dimension. */
  actionName?: string;
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  /** `<publisher>/<short-name>`, e.g. `anlyon/outbound-sales`. */
  pack: string;
  version: string;
  description: string;
  parameters?: PackParameter[];
  secrets: PackSecret[];
  actions: PackAction[];
  policies?: PackPolicy[];
  limits?: PackLimit[];
}

export type PackErrorCode =
  | 'PACK_INVALID'
  | 'PACK_HOST_MISMATCH'
  | 'PACK_AUTO_APPROVE_REFUSED'
  | 'PACK_CONNECTION_MISSING'
  | 'PACK_SECRET_MISMATCH'
  | 'PACK_SECRET_VALUE_MISSING'
  | 'PACK_PARAMETER_MISSING'
  | 'PACK_ACTION_CONFLICT';

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message: string,
    /** For a missing connected account, the command that creates it. */
    readonly command?: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'PackError';
  }
}

/** `connection`: a `{{connection:<integration>}}` the pack's actions use, chosen at each call. Nothing is written for it. */
export type PackStepKind = 'secret' | 'connection' | 'action' | 'policy' | 'limit';

/**
 * How a pack's `{{connection:<integration>}}` references are installed.
 * `connection` (the default): as they are. Each call uses its end user's own account, or the
 * environment's connected account when the call names no end user.
 * `secret`: bound to the workspace secret the manifest declares for that integration, as
 * `{{secret:NAME}}`. That connected account must exist; calls for an end user still use theirs.
 */
export type PackCredentialMode = 'connection' | 'secret';
export type PackStepOutcome = 'create' | 'created' | 'skip' | 'update' | 'updated' | 'suggest';

export interface PackStep {
  kind: PackStepKind;
  /** The name as installed (prefixed for actions). */
  name: string;
  outcome: PackStepOutcome;
  detail: string;
}

export interface PackInstallResult {
  pack: string;
  version: string;
  /** False for `plan`: nothing was written. */
  applied: boolean;
  steps: PackStep[];
  /** Policies installed (or to be installed) disabled, for the operator to review and enable. */
  disabledPolicies: string[];
  /** Limits not created because `withLimits` was not set. */
  suggestedLimits: PackLimit[];
}

export interface PackInstallOptions {
  /** Create the manifest's limits. Needs `impact-limits:write`. */
  withLimits?: boolean;
  /** Replace an action whose definition differs, as a new action version. */
  update?: boolean;
  /** Keep the manifest's action names as they are. */
  noPrefix?: boolean;
  /** Values for static secrets that do not exist yet. */
  secrets?: Record<string, string>;
  /** Values for the manifest's parameters. */
  params?: Record<string, string>;
  /** Asked for a static secret's value when `secrets` has none. Return undefined to refuse. */
  resolveSecret?: (secret: PackSecret) => Promise<string | undefined>;
  /**
   * Install only these actions (manifest names, unprefixed), with the secrets, parameters,
   * policies and limits they use. The console's operations toggles install one at a time this way.
   */
  actions?: string[];
  /**
   * Use a different secret for one the manifest names, e.g. `{ HUBSPOT: 'HUBSPOT_SALES' }` when the
   * account was connected under another name. Every reference is rewritten before any check, and a
   * renamed connected account is always used by name: its `{{connection:<integration>}}` references
   * become `{{secret:<new name>}}`.
   */
  secretNames?: Record<string, string>;
  /** How `{{connection:<integration>}}` references are installed. Default `connection`. See PackCredentialMode. */
  credential?: PackCredentialMode;
  /** Loads another pack's manifest by id, for actions that reference one (`ref: "anlyon/hubspot#add-note"`). */
  resolvePack?: (pack: string) => unknown | Promise<unknown>;
}

const SECRET_NAME = /^[A-Z0-9_]+$/;
const ACTION_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]*$/;
const PACK_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]{0,39}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SECRET_REF = /\{\{\s*secret:([A-Z0-9_]+)\s*\}\}/g;
/** The API's own form (server core/actions/template.ts): an integration id after `connection:`. */
const CONNECTION_REF = /\{\{\s*connection:([a-z][a-z0-9-]{0,63})\s*\}\}/g;
const PARAM_REF = /\{\{\s*param:([a-z][a-z0-9_]*)\s*\}\}/g;

/** The hosts each built-in adapter sends to. An adapter not listed here cannot be used by a pack. */
export const ADAPTER_HOSTS: Record<string, string[]> = {
  'stripe.refund': ['api.stripe.com'],
  'github.file_update': ['api.github.com'],
  'resend.email_send': ['api.resend.com'],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The host an action on a per-account integration addresses: the calling account's own (server core/actions/template.ts). */
export const ACCOUNT_HOST = '{{connection.host}}';
const ACCOUNT_HOST_ANYWHERE = /\{\{\s*connection\.host\s*\}\}/;
/** `{x}.<provider domain>`: one parameter label, then a fixed suffix of at least two labels. */
const ACCOUNT_HOST_TEMPLATE = /^\{[a-z][a-zA-Z0-9]{0,31}\}(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?){2,}$/;

/**
 * The fixed host of an https URL template, `{{connection.host}}` when it addresses the calling
 * account's own host, or null when the host is otherwise templated or the scheme is not https.
 */
export function templateHost(urlTemplate: string): string | null {
  const m = /^https:\/\/([^/?#]+)/.exec(urlTemplate);
  if (!m) return null;
  if (/^\{\{\s*connection\.host\s*\}\}$/.test(m[1]!)) return ACCOUNT_HOST;
  if (m[1]!.includes('{{')) return null;
  const host = m[1]!.toLowerCase();
  return HOSTNAME.test(host) ? host : null;
}

/**
 * A GraphQL query that reads and nothing else: a literal with no placeholder, starting with `query`
 * or `{`, and without the words mutation or subscription anywhere. Mirrors the API's rule
 * (server core/effects/graphql.ts).
 */
export function isReadOnlyGraphqlQuery(query: unknown): boolean {
  if (typeof query !== 'string' || query.length === 0 || query.length > 10_000) return false;
  if (query.includes('{{')) return false;
  if (/\b(mutation|subscription)\b/i.test(query)) return false;
  return /^(query\b|\{)/.test(query.replace(/#[^\n\r]*/g, '').trim());
}

function refsOf(pattern: RegExp, values: unknown[]): string[] {
  const names = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') for (const m of value.matchAll(pattern)) names.add(m[1]!);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isObject(value)) Object.values(value).forEach(walk);
  };
  values.forEach(walk);
  return [...names];
}

/** Every `{{secret:NAME}}` name in the values. */
function secretRefs(...values: unknown[]): string[] {
  return refsOf(SECRET_REF, values);
}

/** Every integration a `{{connection:<integration>}}` in the values names. */
export function packConnectionRefs(...values: unknown[]): string[] {
  return refsOf(CONNECTION_REF, values);
}

/** The parts of a declared action a credential can appear in. */
function templateParts(action: PackAction): unknown[] {
  return action.adapter ? [] : [action.urlTemplate, action.headers, action.bodyTemplate, action.verify];
}

/**
 * Check a manifest's shape and its internal consistency, including the host rule, before anything
 * is sent. Throws PackError with every problem found.
 */
export function validatePackManifest(input: unknown): PackManifest {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  if (!isObject(input)) throw new PackError('PACK_INVALID', 'A pack manifest must be a JSON object.');
  const m = input as Record<string, unknown>;

  if (m.format !== PACK_FORMAT) fail(`format must be "${PACK_FORMAT}".`);
  if (typeof m.pack !== 'string' || !PACK_ID.test(m.pack)) fail('pack must be "<publisher>/<name>" in lowercase, e.g. "anlyon/outbound-sales".');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) fail('version must be a semantic version such as 0.1.0.');
  if (typeof m.description !== 'string' || m.description.length === 0) fail('description is required.');
  for (const key of Object.keys(m)) {
    if (!['$schema', 'format', 'pack', 'version', 'description', 'parameters', 'secrets', 'actions', 'policies', 'limits'].includes(key)) {
      fail(`Unknown top-level field "${key}".`);
    }
  }

  const params = new Map<string, PackParameter>();
  for (const [i, p] of (Array.isArray(m.parameters) ? m.parameters : m.parameters === undefined ? [] : (fail('parameters must be an array.'), [])).entries()) {
    if (!isObject(p) || typeof p.name !== 'string' || !PARAM_NAME.test(p.name)) { fail(`parameters[${i}].name must match ${PARAM_NAME}.`); continue; }
    if (typeof p.description !== 'string') fail(`parameters[${i}].description is required.`);
    if (p.enum !== undefined && !(Array.isArray(p.enum) && p.enum.every((v) => typeof v === 'string'))) fail(`parameters[${i}].enum must be strings.`);
    if (params.has(p.name)) fail(`Parameter ${p.name} is declared twice.`);
    params.set(p.name, p as unknown as PackParameter);
  }

  const secrets = new Map<string, PackSecret>();
  if (!Array.isArray(m.secrets)) fail('secrets must be an array.');
  for (const [i, s] of (Array.isArray(m.secrets) ? m.secrets : []).entries()) {
    const at = `secrets[${i}]`;
    if (!isObject(s) || typeof s.name !== 'string' || !SECRET_NAME.test(s.name)) { fail(`${at}.name must be uppercase letters, digits and underscores.`); continue; }
    if (s.kind !== 'connection' && s.kind !== 'static') fail(`${at}.kind must be "connection" or "static".`);
    if (s.kind === 'connection' && (typeof s.integrationId !== 'string' || !/^[a-z0-9-]+$/.test(s.integrationId))) fail(`${at}.integrationId is required for a connected account.`);
    if (s.accountHost !== undefined) {
      if (s.kind !== 'connection') fail(`${at}.accountHost is only for a connected account.`);
      if (typeof s.accountHost !== 'string' || !ACCOUNT_HOST_TEMPLATE.test(s.accountHost)) fail(`${at}.accountHost must be the catalogue's template, e.g. {subdomain}.zendesk.com.`);
      if (!Array.isArray(s.hosts) || s.hosts.length !== 0) fail(`${at}.hosts must be empty when accountHost is set: the host is the account's own.`);
    } else if (!Array.isArray(s.hosts) || s.hosts.length === 0 || !s.hosts.every((h) => typeof h === 'string' && HOSTNAME.test(h))) {
      fail(`${at}.hosts must list at least one bare lowercase hostname.`);
    }
    if ('needsCustomerApp' in s) fail(`${at}.needsCustomerApp is not supported: every integration ships under Anlyon's own app.`);
    if (secrets.has(s.name)) fail(`Secret ${s.name} is declared twice.`);
    secrets.set(s.name, s as unknown as PackSecret);
  }

  const actions = new Map<string, PackAction>();
  if (!Array.isArray(m.actions) || m.actions.length === 0) fail('actions must list at least one action.');
  for (const [i, a] of (Array.isArray(m.actions) ? m.actions : []).entries()) {
    const at = `actions[${i}]`;
    if (!isObject(a) || typeof a.name !== 'string' || !ACTION_NAME.test(a.name)) { fail(`${at}.name must match ${ACTION_NAME}.`); continue; }
    const label = `Action ${a.name}`;
    if (actions.has(a.name)) fail(`${label} is declared twice.`);
    if ('ref' in a) { fail(`${label}: references ${String(a.ref)}, which was not expanded. Install with resolvePack.`); continue; }
    actions.set(a.name, a as unknown as PackAction);
    if (typeof a.description !== 'string' || a.description.length === 0) fail(`${label}: description is required.`);
    if (a.kind !== undefined && a.kind !== 'read' && a.kind !== 'write') fail(`${label}: kind must be "read" or "write".`);
    const reads = a.kind === 'read';

    if (a.adapter !== undefined) {
      if (reads) fail(`${label}: an adapter action writes; kind may not be "read".`);
      const adapter = a.adapter;
      if (!isObject(adapter) || typeof adapter.type !== 'string' || !isObject(adapter.config) || typeof adapter.credentialSecret !== 'string') {
        fail(`${label}: adapter needs type, config and credentialSecret.`);
        continue;
      }
      const hosts = ADAPTER_HOSTS[adapter.type];
      if (!hosts) { fail(`${label}: adapter ${adapter.type} cannot be used in a pack.`); continue; }
      const secret = secrets.get(adapter.credentialSecret);
      if (!secret) fail(`${label}: credentialSecret ${adapter.credentialSecret} is not declared in secrets.`);
      else for (const host of hosts) if (!secret.hosts.includes(host)) fail(`${label}: adapter ${adapter.type} sends to ${host}, which is not a host of ${secret.name}.`);
      for (const ref of JSON.stringify(adapter.config).matchAll(PARAM_REF)) {
        if (!params.has(ref[1]!)) fail(`${label}: {{param:${ref[1]}}} is not a declared parameter.`);
      }
      continue;
    }

    if (typeof a.method !== 'string' || !METHODS.has(a.method)) fail(`${label}: method must be GET, POST, PUT, PATCH or DELETE.`);
    if (typeof a.urlTemplate !== 'string') { fail(`${label}: urlTemplate is required.`); continue; }
    const host = templateHost(a.urlTemplate);
    if (!host) fail(`${label}: urlTemplate must be https with a fixed host.`);
    if (!isObject(a.inputSchema)) fail(`${label}: inputSchema is required.`);
    if (reads) {
      if (a.method !== 'GET' && a.method !== 'POST') fail(`${label}: a read must be GET, or POST for a search that changes nothing.`);
      if (a.impact !== undefined) fail(`${label}: a read changes nothing, so it declares no impact.`);
      if (a.verify !== undefined) fail(`${label}: a read has no read-back.`);
    } else {
      if (!isObject(a.impact)) fail(`${label}: impact is required; every write declares one.`);
      if (a.verify !== undefined) {
        if (!isObject(a.verify) || typeof a.verify.url !== 'string') fail(`${label}: verify needs a url.`);
        else if (host && templateHost(a.verify.url) !== host) fail(`${label}: verify.url must use the action's own host ${host}.`);
      }
    }
    if (a.headers !== undefined && !(isObject(a.headers) && Object.values(a.headers).every((v) => typeof v === 'string'))) fail(`${label}: headers must map names to strings.`);
    if (JSON.stringify(a.headers ?? {}).match(PARAM_REF)) fail(`${label}: {{param:...}} may not be used in headers.`);
    for (const ref of JSON.stringify([a.urlTemplate, a.bodyTemplate, a.verify]).matchAll(PARAM_REF)) {
      if (!params.has(ref[1]!)) fail(`${label}: {{param:${ref[1]}}} is not a declared parameter.`);
    }

    if (ACCOUNT_HOST_ANYWHERE.test(JSON.stringify([a.headers ?? null, a.bodyTemplate ?? null]))) fail(`${label}: {{connection.host}} may only be the URL's host.`);
    if (a.graphql !== undefined) {
      if (a.graphql !== true) fail(`${label}: graphql must be true.`);
      if (a.method !== 'POST') fail(`${label}: a GraphQL operation is a POST.`);
      const body = isObject(a.bodyTemplate) ? a.bodyTemplate : {};
      const extra = Object.keys(body).filter((k) => !['query', 'variables', 'operationName'].includes(k));
      if (extra.length > 0) fail(`${label}: a GraphQL body is query and variables only, not ${extra.join(', ')}.`);
      if (typeof body.query !== 'string' || body.query.includes('{{')) fail(`${label}: the GraphQL query must be fixed text; only variables take inputs.`);
      else if (reads && !isReadOnlyGraphqlQuery(body.query)) fail(`${label}: a read's GraphQL query must be read-only (no mutation or subscription).`);
      if (body.variables !== undefined && !isObject(body.variables)) fail(`${label}: GraphQL variables must be an object.`);
    }
    if (isObject(a.verify) && a.verify.graphql !== undefined) {
      const g = a.verify.graphql as unknown;
      if (!isObject(g) || !isReadOnlyGraphqlQuery(g.query)) fail(`${label}: verify.graphql.query must be a fixed, read-only GraphQL query (no placeholder, mutation or subscription).`);
    }

    const credentialParts = [a.urlTemplate, a.headers, a.bodyTemplate, isObject(a.verify) ? a.verify.url : undefined];
    const refs = secretRefs(...credentialParts);
    const connections = packConnectionRefs(...credentialParts);
    if (refs.length === 0 && connections.length === 0) fail(`${label}: references no secret or connection.`);
    const reaches = (secret: PackSecret) => (host === ACCOUNT_HOST ? secret.accountHost !== undefined : !!host && secret.hosts.includes(host));
    const where = (secret: PackSecret) => (secret.accountHost !== undefined ? `{{connection.host}} (${secret.accountHost})` : secret.hosts.join(', '));
    let accountCredentials = 0;
    for (const name of refs) {
      const secret = secrets.get(name);
      if (!secret) fail(`${label}: {{secret:${name}}} is not declared in secrets.`);
      else if (host && !reaches(secret)) fail(`${label}: sends ${name} to ${host}, which is not one of its hosts (${where(secret)}).`);
      else if (secret.accountHost !== undefined) accountCredentials++;
    }
    for (const integration of connections) {
      const declared = [...secrets.values()].filter((s) => s.kind === 'connection' && s.integrationId === integration);
      if (declared.length === 0) fail(`${label}: {{connection:${integration}}} needs a secret of kind "connection" with integrationId "${integration}".`);
      else if (declared.length > 1) fail(`${label}: {{connection:${integration}}} is ambiguous: ${declared.map((s) => s.name).join(' and ')} are both ${integration} accounts.`);
      else if (host && !reaches(declared[0]!)) fail(`${label}: sends the ${integration} connection to ${host}, which is not one of its hosts (${where(declared[0]!)}).`);
      else if (declared[0]!.accountHost !== undefined) accountCredentials++;
    }
    if (host === ACCOUNT_HOST && accountCredentials !== 1) fail(`${label}: an action on {{connection.host}} sends exactly one per-account connection.`);
    if (secretRefs(a.urlTemplate, a.bodyTemplate).length > 0 || packConnectionRefs(a.urlTemplate, a.bodyTemplate).length > 0) {
      fail(`${label}: a secret may only appear in a header.`);
    }
  }

  for (const [i, p] of (Array.isArray(m.policies) ? m.policies : m.policies === undefined ? [] : (fail('policies must be an array.'), [])).entries()) {
    const at = `policies[${i}]`;
    if (!isObject(p) || typeof p.name !== 'string' || p.name.length === 0) { fail(`${at}.name is required.`); continue; }
    if (p.effect === 'auto_approve') {
      throw new PackError('PACK_AUTO_APPROVE_REFUSED', `Policy "${p.name}" auto-approves. A pack may not install a policy that approves on anyone's behalf.`);
    }
    if (p.effect !== 'require_approval' && p.effect !== 'auto_deny') fail(`Policy "${p.name}": effect must be require_approval or auto_deny.`);
    if (p.matchKind !== 'action' || typeof p.matchActionName !== 'string' || !actions.has(p.matchActionName)) {
      fail(`Policy "${p.name}": matchKind must be "action" and matchActionName one of this pack's actions.`);
    }
  }

  for (const [i, l] of (Array.isArray(m.limits) ? m.limits : m.limits === undefined ? [] : (fail('limits must be an array.'), [])).entries()) {
    const at = `limits[${i}]`;
    if (!isObject(l) || typeof l.name !== 'string') { fail(`${at}.name is required.`); continue; }
    if (typeof l.dimension !== 'string') fail(`Limit "${l.name}": dimension is required.`);
    if (!['day', 'month', 'total'].includes(String(l.period))) fail(`Limit "${l.name}": period must be day, month or total.`);
    if (typeof l.amount !== 'number' || !Number.isInteger(l.amount) || l.amount <= 0) fail(`Limit "${l.name}": amount must be a positive integer.`);
    if (l.actionName !== undefined && (typeof l.actionName !== 'string' || !actions.has(l.actionName))) fail(`Limit "${l.name}": actionName must be one of this pack's actions.`);
  }

  if (problems.length > 0) {
    throw new PackError('PACK_INVALID', `The pack manifest is not valid:\n- ${problems.join('\n- ')}`, undefined, problems);
  }
  return input as unknown as PackManifest;
}


const ACTION_REF = /^([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]{0,39})#([a-z0-9][a-z0-9-]{0,59})$/;

/** Replace every `{ name, ref }` action with the referenced pack's action, renamed. */
export async function expandPackRefs(input: unknown, resolvePack?: PackInstallOptions['resolvePack']): Promise<unknown> {
  const ids = referencedPacks(input);
  if (ids.length === 0) return input;
  if (!resolvePack) throw new PackError('PACK_INVALID', 'This pack reuses actions from other packs. Install it with resolvePack (the CLI and the console do this for you).');
  const loaded = new Map<string, unknown>();
  for (const id of ids) loaded.set(id, await resolvePack(id));
  return expandPackRefsSync(input, (id) => loaded.get(id));
}

/** The pack ids a manifest's `ref` actions name, each once. */
function referencedPacks(input: unknown): string[] {
  if (!isObject(input) || !Array.isArray(input.actions)) return [];
  const ids = new Set<string>();
  for (const action of input.actions) {
    if (!isObject(action) || !('ref' in action)) continue;
    const m = typeof action.ref === 'string' ? ACTION_REF.exec(action.ref) : null;
    if (!m || typeof action.name !== 'string') throw new PackError('PACK_INVALID', `Action ${String(action.name)}: ref must be "<publisher>/<pack>#<action>".`);
    ids.add(m[1]!);
  }
  return [...ids];
}

/** `expandPackRefs` with packs already in hand, for callers that bundle them (the console). */
export function expandPackRefsSync(input: unknown, resolvePack: (pack: string) => unknown): unknown {
  if (referencedPacks(input).length === 0) return input;
  const record = input as Record<string, unknown> & { actions: unknown[] };
  const cache = new Map<string, PackManifest>();
  const actions = record.actions.map((action) => {
    if (!isObject(action) || !('ref' in action)) return action;
    const [, packId, actionName] = ACTION_REF.exec(action.ref as string)!;
    let source = cache.get(packId!);
    if (!source) {
      const loaded = resolvePack(packId!);
      if (!loaded) throw new PackError('PACK_INVALID', `Action ${String(action.name)}: pack ${packId} was not found.`);
      source = validatePackManifest(loaded);
      cache.set(packId!, source);
    }
    const found = source.actions.find((a) => a.name === actionName);
    if (!found) throw new PackError('PACK_INVALID', `Action ${String(action.name)}: ${packId} has no action ${actionName}.`);
    return { ...found, name: action.name as string };
  });
  return { ...record, actions };
}

function rewrite(value: unknown, swap: (text: string) => string): unknown {
  if (typeof value === 'string') return swap(value);
  if (Array.isArray(value)) return value.map((v) => rewrite(v, swap));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, swap)]));
  return value;
}

/** Use the workspace's secret names for the manifest's. */
export function renamePackSecrets(manifest: PackManifest, names: Record<string, string>): PackManifest {
  const entries = Object.entries(names).filter(([from, to]) => from !== to);
  if (entries.length === 0) return manifest;
  for (const [from, to] of entries) {
    if (!manifest.secrets.some((s) => s.name === from)) throw new PackError('PACK_INVALID', `secretNames: the pack has no secret ${from}.`);
    if (!SECRET_NAME.test(to)) throw new PackError('PACK_INVALID', `secretNames: ${to} is not a secret name.`);
  }
  const map = new Map(entries);
  const swap = (text: string) => text.replace(SECRET_REF, (whole, name: string) => (map.has(name) ? `{{secret:${map.get(name)}}}` : whole));
  return {
    ...manifest,
    secrets: manifest.secrets.map((s) => (map.has(s.name) ? { ...s, name: map.get(s.name)! } : s)),
    actions: manifest.actions.map((a) => {
      if (a.adapter) {
        const credentialSecret = map.get(a.adapter.credentialSecret) ?? a.adapter.credentialSecret;
        return { ...a, adapter: { ...a.adapter, credentialSecret } };
      }
      return rewrite(a, swap) as PackAction;
    }),
  };
}

/**
 * Bind `{{connection:<integration>}}` to the workspace secret the manifest declares for that
 * integration, as `{{secret:NAME}}`, for the integrations given. The others are left as they are.
 */
export function bindPackConnections(manifest: PackManifest, integrations: Iterable<string>): PackManifest {
  const names = new Map<string, string>();
  for (const integration of integrations) {
    const secret = manifest.secrets.find((s) => s.kind === 'connection' && s.integrationId === integration);
    if (secret) names.set(integration, secret.name);
  }
  if (names.size === 0) return manifest;
  const swap = (text: string) => text.replace(CONNECTION_REF, (whole, integration: string) => (names.has(integration) ? `{{secret:${names.get(integration)}}}` : whole));
  return { ...manifest, actions: manifest.actions.map((a) => (a.adapter ? a : (rewrite(a, swap) as PackAction))) };
}

/** Keep only the named actions, and the secrets, parameters, policies and limits they use. */
export function filterPackActions(manifest: PackManifest, names: string[]): PackManifest {
  const unknown = names.filter((n) => !manifest.actions.some((a) => a.name === n));
  if (unknown.length > 0) throw new PackError('PACK_INVALID', `The pack has no action ${unknown.join(', ')}.`);
  const keep = new Set(names);
  const actions = manifest.actions.filter((a) => keep.has(a.name));
  const used = JSON.stringify(actions);
  const secretNames = new Set([
    ...secretRefs(...actions.map(templateParts)),
    ...actions.flatMap((a) => (a.adapter ? [a.adapter.credentialSecret] : [])),
  ]);
  const connections = new Set(packConnectionRefs(...actions.map(templateParts)));
  return {
    ...manifest,
    parameters: (manifest.parameters ?? []).filter((p) => used.includes(`{{param:${p.name}}}`)),
    secrets: manifest.secrets.filter((s) => secretNames.has(s.name) || (s.kind === 'connection' && connections.has(s.integrationId!))),
    actions,
    policies: (manifest.policies ?? []).filter((p) => keep.has(p.matchActionName)),
    limits: (manifest.limits ?? []).filter((l) => l.actionName !== undefined && keep.has(l.actionName)),
  };
}

/** Expand, validate, rename and filter: the manifest an install actually works from. */
export async function preparePackManifest(input: unknown, options: PackInstallOptions = {}): Promise<PackManifest> {
  let manifest = validatePackManifest(await expandPackRefs(input, options.resolvePack));
  const mode = options.credential ?? 'connection';
  if (mode !== 'connection' && mode !== 'secret') throw new PackError('PACK_INVALID', `credential must be "connection" or "secret", not "${String(mode)}".`);
  const renamed = new Set(Object.entries(options.secretNames ?? {}).filter(([from, to]) => from !== to).map(([from]) => from));
  const byName = manifest.secrets
    .filter((s) => s.kind === 'connection' && (mode === 'secret' || renamed.has(s.name)))
    .map((s) => s.integrationId!);
  if (byName.length > 0) manifest = validatePackManifest(bindPackConnections(manifest, byName));
  if (options.secretNames) manifest = validatePackManifest(renamePackSecrets(manifest, options.secretNames));
  if (options.actions) manifest = filterPackActions(manifest, options.actions);
  return manifest;
}

/** `anlyon/outbound-sales` → `outbound-sales`. */
export function packShortName(pack: string): string {
  return pack.slice(pack.indexOf('/') + 1);
}

function substituteParams(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(PARAM_REF, (_, name: string) => params[name]!);
  }
  if (Array.isArray(value)) return value.map((v) => substituteParams(v, params));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteParams(v, params)]));
  return value;
}

function resolveParams(manifest: PackManifest, given: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of manifest.parameters ?? []) {
    const value = given[p.name] ?? p.default;
    if (value === undefined) throw new PackError('PACK_PARAMETER_MISSING', `Parameter ${p.name} is required: ${p.description}`);
    if (p.enum && !p.enum.includes(value)) throw new PackError('PACK_PARAMETER_MISSING', `Parameter ${p.name} must be one of ${p.enum.join(', ')}.`);
    if (p.pattern && !new RegExp(p.pattern).test(value)) throw new PackError('PACK_PARAMETER_MISSING', `Parameter ${p.name} does not match ${p.pattern}.`);
    out[p.name] = value;
  }
  return out;
}

/** The create/update request for an action, as installed. */
function actionRequest(action: PackAction, name: string, params: Record<string, string>): Record<string, unknown> {
  if (action.adapter) {
    return {
      name,
      description: action.description,
      requiresApproval: action.requiresApproval ?? false,
      adapter: { ...action.adapter, config: substituteParams(action.adapter.config, params) },
    };
  }
  return {
    name,
    description: action.description,
    method: action.method,
    urlTemplate: substituteParams(action.urlTemplate, params),
    headers: action.headers ?? {},
    ...(action.bodyTemplate !== undefined ? { bodyTemplate: substituteParams(action.bodyTemplate, params) } : {}),
    inputSchema: action.inputSchema,
    requiresApproval: action.requiresApproval ?? false,
    ...(action.impact !== undefined ? { impact: action.impact } : {}),
    ...(action.verify !== undefined ? { verify: substituteParams(action.verify, params) } : {}),
  };
}

/** Whether `actual` carries every value `wanted` sets. Extra fields the API adds are ignored. */
function covers(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    return Array.isArray(actual) && actual.length === wanted.length && wanted.every((w, i) => covers(actual[i], w));
  }
  if (isObject(wanted)) {
    return isObject(actual) && Object.entries(wanted).every(([k, v]) => covers(actual[k], v));
  }
  return actual === wanted;
}

function sameDefinition(existing: Action, request: Record<string, unknown>): boolean {
  const { name: _name, ...rest } = request;
  return covers(existing, rest);
}

/**
 * The calls an install makes. A missing secret or action reads as `null`; anything else that fails
 * throws. Writes take the same request shapes as the public API.
 */
export interface PackTransport {
  getSecret(name: string): Promise<Secret | null>;
  putSecret(name: string, request: PutSecretRequest): Promise<unknown>;
  getAction(name: string): Promise<Action | null>;
  createAction(request: Record<string, unknown>): Promise<unknown>;
  updateAction(name: string, request: Record<string, unknown>): Promise<unknown>;
  listPolicies(actionName: string): Promise<ApprovalPolicy[]>;
  createPolicy(request: CreateApprovalPolicyRequest): Promise<unknown>;
  listLimits(): Promise<ImpactLimit[]>;
  createLimit(request: CreateImpactLimitRequest): Promise<unknown>;
}

/** What `install` would do, with nothing sent. */
export function planPack(api: PackTransport, manifest: unknown, options: PackInstallOptions = {}): Promise<PackInstallResult> {
  return runPack(api, manifest, options, false);
}

/** Install the pack. Refuses before writing anything; see the rules at the top of this file. */
export function installPack(api: PackTransport, manifest: unknown, options: PackInstallOptions = {}): Promise<PackInstallResult> {
  return runPack(api, manifest, options, true);
}

export async function runPack(api: PackTransport, input: unknown, options: PackInstallOptions, apply: boolean): Promise<PackInstallResult> {
  const manifest = await preparePackManifest(input, options);
  const params = resolveParams(manifest, options.params ?? {});
  const short = packShortName(manifest.pack);
  const installedName = (name: string) => (options.noPrefix ? name : `${short}-${name}`);

  const writes: Array<() => Promise<unknown>> = [];
  const steps: PackStep[] = [];

  const perCall = new Set(packConnectionRefs(...manifest.actions.map(templateParts)));
  const byName = new Set([
    ...secretRefs(...manifest.actions.map(templateParts)),
    ...manifest.actions.flatMap((a) => (a.adapter ? [a.adapter.credentialSecret] : [])),
  ]);
  for (const secret of manifest.secrets) {
    if (secret.kind === 'connection' && perCall.has(secret.integrationId!)) {
      steps.push({
        kind: 'connection',
        name: `connection:${secret.integrationId}`,
        outcome: 'skip',
        detail: `Chosen at each call: the end user's own ${secret.integrationId} account, or this environment's connected ${secret.integrationId} account when the call names no end user. Nothing to create.`,
      });
      if (!byName.has(secret.name)) continue;
    }
    const existing = await api.getSecret(secret.name);
    if (secret.kind === 'connection') {
      const command = `anlyon connections add ${secret.integrationId} --secret ${secret.name}`;
      if (!existing) {
        if (apply) {
          throw new PackError('PACK_CONNECTION_MISSING', `Secret ${secret.name} must be a connected ${secret.integrationId} account. Connect it first, then install again. Nothing was installed.`, command);
        }
        steps.push({ kind: 'secret', name: secret.name, outcome: 'create', detail: `Connect a ${secret.integrationId} account first: ${command}` });
        continue;
      }
      const connectedFor = existing.integrationId ?? existing.connection?.integrationId ?? null;
      if (connectedFor !== secret.integrationId) {
        throw new PackError('PACK_SECRET_MISMATCH', `Secret ${secret.name} exists but is not a connected ${secret.integrationId} account. Delete it or install with a free name.`);
      }
      const outside = secret.hosts.filter((h) => !(existing.allowedHosts ?? []).includes(h));
      if (outside.length > 0) throw new PackError('PACK_SECRET_MISMATCH', `Connected account ${secret.name} may not be sent to ${outside.join(', ')}, which this pack needs.`);
      steps.push({ kind: 'secret', name: secret.name, outcome: 'skip', detail: `Connected ${secret.integrationId} account` });
      continue;
    }
    if (existing) {
      if (existing.kind === 'connection' || existing.integrationId) throw new PackError('PACK_SECRET_MISMATCH', `Secret ${secret.name} is a connected account; this pack needs a stored value.`);
      const bound = existing.allowedHosts;
      if (bound && bound.length > 0 && secret.hosts.some((h) => !bound.includes(h))) {
        throw new PackError('PACK_SECRET_MISMATCH', `Secret ${secret.name} may not be sent to ${secret.hosts.filter((h) => !bound.includes(h)).join(', ')}, which this pack needs.`);
      }
      steps.push({ kind: 'secret', name: secret.name, outcome: 'skip', detail: 'Already stored' });
      continue;
    }
    if (apply) {
      const value = options.secrets?.[secret.name] ?? (await options.resolveSecret?.(secret));
      if (!value) {
        throw new PackError('PACK_SECRET_VALUE_MISSING', `Secret ${secret.name} needs a value (${secret.description ?? 'no description'}). Pass --secret ${secret.name}=<value>. Nothing was installed.`);
      }
      writes.push(() => api.putSecret(secret.name, {
        value,
        ...(secret.description ? { description: secret.description } : {}),
        allowedHosts: secret.hosts,
        allowedPlacements: ['header'],
      }));
    }
    steps.push({ kind: 'secret', name: secret.name, outcome: apply ? 'created' : 'create', detail: `Stored value, bound to ${secret.hosts.join(', ')} in headers` });
  }

  for (const action of manifest.actions) {
    const name = installedName(action.name);
    const request = actionRequest(action, name, params);
    const existing = await api.getAction(name);
    if (!existing) {
      writes.push(() => api.createAction(request as never));
      steps.push({ kind: 'action', name, outcome: apply ? 'created' : 'create', detail: action.adapter ? `Adapter ${action.adapter.type}` : `${action.method} ${templateHost(action.urlTemplate)}` });
      continue;
    }
    if (sameDefinition(existing, request)) {
      steps.push({ kind: 'action', name, outcome: 'skip', detail: 'Identical definition already installed' });
      continue;
    }
    if (!options.update) {
      throw new PackError('PACK_ACTION_CONFLICT', `Action ${name} exists with a different definition. Re-run with --update to install this one as a new version. Nothing was installed.`);
    }
    const { name: _n, ...changes } = request;
    writes.push(() => api.updateAction(name, changes as never));
    steps.push({ kind: 'action', name, outcome: apply ? 'updated' : 'update', detail: 'New action version' });
  }

  const disabledPolicies: string[] = [];
  for (const policy of manifest.policies ?? []) {
    const actionName = installedName(policy.matchActionName);
    const actionExists = steps.some((s) => s.kind === 'action' && s.name === actionName && (s.outcome === 'skip' || s.outcome.startsWith('update')));
    const existing = actionExists
      ? (await api.listPolicies(actionName)).find((p) => p.name === policy.name)
      : undefined;
    if (existing) {
      steps.push({ kind: 'policy', name: policy.name, outcome: 'skip', detail: `Already exists (${existing.enabled ? 'enabled' : 'disabled'}); left as it is` });
      continue;
    }
    writes.push(() => api.createPolicy({
      name: policy.name,
      matchKind: 'action',
      matchActionName: actionName,
      ...(policy.condition ? { condition: policy.condition } : {}),
      effect: policy.effect,
      ...(policy.requiredApprovals ? { requiredApprovals: policy.requiredApprovals } : {}),
      enabled: false,
      changeNote: `Installed disabled by pack ${manifest.pack}@${manifest.version}`,
    }));
    disabledPolicies.push(policy.name);
    steps.push({ kind: 'policy', name: policy.name, outcome: apply ? 'created' : 'create', detail: 'Disabled. Review it, then enable it.' });
  }

  const suggestedLimits: PackLimit[] = [];
  if (options.withLimits) {
    const current = await api.listLimits();
    for (const limit of manifest.limits ?? []) {
      if (current.some((l) => l.name === limit.name)) {
        steps.push({ kind: 'limit', name: limit.name, outcome: 'skip', detail: 'A limit with this name exists' });
        continue;
      }
      writes.push(() => api.createLimit({
        name: limit.name,
        dimension: limit.dimension,
        ...(limit.currency ? { currency: limit.currency } : {}),
        period: limit.period,
        amount: limit.amount,
        actionName: limit.actionName ? installedName(limit.actionName) : null,
      }));
      steps.push({ kind: 'limit', name: limit.name, outcome: apply ? 'created' : 'create', detail: `${limit.amount} ${limit.currency ?? limit.dimension} per ${limit.period}` });
    }
  } else {
    for (const limit of manifest.limits ?? []) {
      suggestedLimits.push({ ...limit, ...(limit.actionName ? { actionName: installedName(limit.actionName) } : {}) });
      steps.push({ kind: 'limit', name: limit.name, outcome: 'suggest', detail: `Not created. ${limit.amount} ${limit.currency ?? limit.dimension} per ${limit.period}; add --with-limits to create it.` });
    }
  }

  if (apply) for (const write of writes) await write();

  return { pack: manifest.pack, version: manifest.version, applied: apply, steps, disabledPolicies, suggestedLimits };
}
