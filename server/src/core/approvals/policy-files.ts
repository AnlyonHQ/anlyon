import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { parseDocument } from "yaml";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { actions } from "../../db/schema/actions.ts";
import { approvalPolicies, type ApprovalPolicy } from "../../db/schema/approvals.ts";
import { workspaces } from "../../db/schema/workspaces.ts";
import { ApiError, AuthorizationError, NotFoundError, ValidationError } from "../../utils/errors.ts";
import { getPlanLimits } from "../plans/limits.ts";
import { resourcePlan } from "../billing/plan-management.ts";
import { getEnvironment } from "../environments/service.ts";
import { checkCondition } from "./condition.ts";
import {
  POLICY_ORDER, decideFromPolicies, generatePolicyId, isBroad, policyScope, policyWrite, sortPolicies,
  type PolicyEffect, type PolicyMatchKind, type PolicyScopeContext, type PolicyTransaction,
} from "./policy.ts";

export const POLICY_FILE_API_VERSION = "anlyon.com/policies/v1";
export const POLICY_FILE_MAX_BYTES = 256 * 1024;
const MAX_POLICIES = 500;
const MAX_CASES = 200;

const policyKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Policy keys use lowercase letters, digits, '-' and '_' (max 64).");

const target = z.object({
  action: z.string().min(1).max(200).optional(),
  allActions: z.literal(true).optional(),
  customRequests: z.literal(true).optional(),
  allRequests: z.literal(true).optional(),
}).strict().refine((t) => Object.keys(t).length === 1, {
  message: "target needs exactly one of: action, allActions, customRequests, allRequests.",
});

const filePolicy = z.object({
  name: z.string().min(1).max(80),
  target,
  when: z.string().trim().min(1).max(2000).optional(),
  effect: z.enum(["require_approval", "auto_approve", "auto_deny"]).optional(),
  approvals: z.number().int().min(1).max(20).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
  agent: z.string().min(1).max(60).optional(),
  user: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
  acknowledgeBroadScope: z.boolean().optional(),
}).strict();

const policyFileSchema = z.object({
  apiVersion: z.literal(POLICY_FILE_API_VERSION),
  file: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,99}$/, "file is a stable id: lowercase letters, digits, '.', '_', '-', '/' (max 100)."),
  environment: z.string().min(1).max(100),
  policies: z.record(policyKey, filePolicy)
    .refine((p) => Object.keys(p).length <= MAX_POLICIES, `A file may declare at most ${MAX_POLICIES} policies.`),
}).strict();

export type PolicyFile = z.infer<typeof policyFileSchema>;

const requestCase = z.object({
  name: z.string().min(1).max(200),
  request: z.object({
    kind: z.enum(["action", "custom"]),
    action: z.string().min(1).max(200).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    agent: z.string().max(60).optional(),
    user: z.string().max(200).optional(),
    tags: z.array(z.string().max(60)).max(50).optional(),
  }).strict(),
  expect: z.object({
    effect: z.enum(["require_approval", "auto_approve", "auto_deny"]).optional(),
    policy: z.string().min(1).max(100).nullable().optional(),
  }).strict().refine((e) => e.effect !== undefined || e.policy !== undefined, { message: "expect needs effect and/or policy." }),
}).strict();
export type PolicyTestCase = z.infer<typeof requestCase>;
const casesSchema = z.array(requestCase).min(1).max(MAX_CASES);

function parseYaml(source: string, what: string): unknown {
  if (Buffer.byteLength(source, "utf8") > POLICY_FILE_MAX_BYTES) {
    throw new ValidationError(`The ${what} is larger than ${POLICY_FILE_MAX_BYTES / 1024} KiB.`);
  }
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: true });
  if (document.errors.length) {
    throw new ValidationError(`The ${what} is not valid YAML: ${document.errors[0].message.split("\n")[0]}`);
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ValidationError(`The ${what} uses YAML aliases, which policy files do not allow.`);
  }
}

function zodMessage(error: z.ZodError, what: string): string {
  return error.issues.slice(0, 5)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : what}: ${issue.message}`)
    .join("; ");
}

export function parsePolicyFile(source: string): PolicyFile {
  const parsed = policyFileSchema.safeParse(parseYaml(source, "policy file"));
  if (!parsed.success) throw new ValidationError(`Invalid policy file: ${zodMessage(parsed.error, "file")}`);
  return parsed.data;
}

export function parseTestCases(input: unknown): PolicyTestCase[] {
  const raw = typeof input === "string" ? parseYaml(input, "test cases") : input;
  const cases = (raw && typeof raw === "object" && !Array.isArray(raw) && "cases" in raw) ? (raw as { cases: unknown }).cases : raw;
  const parsed = casesSchema.safeParse(cases);
  if (!parsed.success) throw new ValidationError(`Invalid test cases: ${zodMessage(parsed.error, "cases")}`);
  return parsed.data;
}

interface DesiredPolicy {
  key: string;
  name: string;
  priority: number;
  enabled: boolean;
  matchKind: PolicyMatchKind;
  matchActionName: string | null;
  matchAgentId: string | null;
  matchUserId: string | null;
  matchTags: string[] | null;
  condition: string | null;
  effect: PolicyEffect;
  requiredApprovals: number;
}

function desiredPolicies(file: PolicyFile): DesiredPolicy[] {
  return Object.entries(file.policies).sort(([a], [b]) => a.localeCompare(b)).map(([key, p]) => {
    const [matchKind, matchActionName]: [PolicyMatchKind, string | null] =
      p.target.action ? ["action", p.target.action]
        : p.target.allActions ? ["action", null]
          : p.target.customRequests ? ["custom", null] : ["any", null];
    return {
      key, name: p.name, priority: p.priority ?? 100, enabled: p.enabled ?? true, matchKind, matchActionName,
      matchAgentId: p.agent ?? null, matchUserId: p.user ?? null, matchTags: p.tags?.length ? p.tags : null,
      condition: p.when ?? null, effect: p.effect ?? "require_approval", requiredApprovals: p.approvals ?? 1,
    };
  });
}

const COMPARED = ["name", "priority", "enabled", "matchKind", "matchActionName", "matchAgentId", "matchUserId",
  "matchTags", "condition", "effect", "requiredApprovals"] as const;

function differences(current: ApprovalPolicy, desired: DesiredPolicy): string[] {
  const fields: string[] = COMPARED.filter((field) =>
    JSON.stringify(current[field] ?? null) !== JSON.stringify(desired[field] ?? null));
  if (current.minAmount !== null) fields.push("minAmount");
  if (current.conditions !== null) fields.push("conditions");
  return fields;
}

export type PolicyChange =
  | { op: "create"; key: string; name: string; after: DesiredPolicy }
  | { op: "update"; key: string; name: string; policyId: string; version: number; fields: string[]; after: DesiredPolicy }
  | { op: "delete"; key: string; name: string; policyId: string; version: number }
  | { op: "unchanged"; key: string; name: string; policyId: string; version: number };

export interface PolicyPlan {
  file: string;
  environmentId: string;
  digest: string;
  changes: PolicyChange[];
  summary: { create: number; update: number; delete: number; unchanged: number };
  errors: string[];
}

type Reader = typeof db | PolicyTransaction;

async function resolveEnvironment(workspaceId: string, credentialEnvironmentId: string, declared: string) {
  const environment = await getEnvironment(workspaceId, credentialEnvironmentId);
  if (declared !== environment.id && declared !== (environment as { slug?: string }).slug) {
    throw new AuthorizationError(
      `This file declares environment "${declared}", but this credential belongs to "${(environment as { slug?: string }).slug ?? environment.id}".`,
    );
  }
  return environment;
}

async function computePlan(q: Reader, workspaceId: string, environmentId: string, file: PolicyFile, lockActions = false): Promise<PolicyPlan & { owned: ApprovalPolicy[]; current: ApprovalPolicy[]; desired: DesiredPolicy[] }> {
  const desired = desiredPolicies(file);
  const current = await q.select().from(approvalPolicies)
    .where(eq(approvalPolicies.environmentId, environmentId)).orderBy(...POLICY_ORDER);
  const owned = current.filter((p) => p.managedByFile === file.file);
  const others = current.filter((p) => p.managedByFile !== file.file);
  const actionNames = [...new Set(desired.map((d) => d.matchActionName).filter((n): n is string => !!n))];
  const actionQuery = q.select({ id: actions.id, name: actions.name, inputSchema: actions.inputSchema, currentVersionId: actions.currentVersionId })
      .from(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.environmentId, environmentId),
        isNull(actions.archivedAt), inArray(actions.name, actionNames)));
  const referenced = actionNames.length ? await (lockActions ? actionQuery.for("share") : actionQuery) : [];
  const actionByName = new Map(referenced.map((a) => [a.name, a]));

  const errors: string[] = [];
  const names = new Map<string, string>();
  for (const d of desired) {
    const where = `policies.${d.key}`;
    const earlier = names.get(d.name);
    if (earlier) errors.push(`${where}: name "${d.name}" is also used by policies.${earlier}.`);
    names.set(d.name, d.key);
    const clash = others.find((p) => p.name === d.name);
    if (clash) {
      errors.push(`${where}: a policy named "${d.name}" already exists (${clash.policyId}, ${clash.managedByFile
        ? `managed by file "${clash.managedByFile}"` : "made in the console or API"}). Rename one of them; a file never takes over a policy it does not own.`);
    }
    const renamedFrom = owned.find((p) => p.managedKey === d.key);
    const occupied = owned.find((p) => p.name === d.name && p.managedKey !== d.key && desired.some((next) => next.key === p.managedKey));
    if (occupied && renamedFrom?.name !== d.name) {
      errors.push(`${where}: name "${d.name}" is currently used by policies.${occupied.managedKey}. Apply a temporary unique name first, then plan this rename again.`);
    }
    const action = d.matchActionName ? actionByName.get(d.matchActionName) : undefined;
    if (d.matchActionName && !action) errors.push(`${where}: action "${d.matchActionName}" does not exist in this environment.`);
    if (d.condition) {
      const check = checkCondition(d.condition, { inputSchema: action?.inputSchema });
      if (!check.valid) errors.push(`${where}.when: ${check.message.split("\n")[0]}`);
    }
    const broad = isBroad(policyScope(d.matchKind, d.matchActionName));
    if (d.effect === "auto_deny" && broad && !file.policies[d.key].acknowledgeBroadScope) {
      errors.push(`${where}: an auto_deny for ${d.matchKind === "any" ? "every request" : "every action"} needs acknowledgeBroadScope: true.`);
    }
  }

  const [workspace] = await q.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundError("Workspace");
  const limit = getPlanLimits(resourcePlan(workspace), workspace).maxApprovalPoliciesPerEnvironment;
  if (limit !== "unlimited" && others.length + desired.length > limit) {
    errors.push(`This environment would hold ${others.length + desired.length} policies; the plan allows ${limit}.`);
  }

  const changes: PolicyChange[] = [];
  const ownedByKey = new Map(owned.map((p) => [p.managedKey, p]));
  for (const d of desired) {
    const existing = ownedByKey.get(d.key);
    if (!existing) changes.push({ op: "create", key: d.key, name: d.name, after: d });
    else {
      const fields = differences(existing, d);
      changes.push(fields.length
        ? { op: "update", key: d.key, name: d.name, policyId: existing.policyId, version: existing.version, fields, after: d }
        : { op: "unchanged", key: d.key, name: d.name, policyId: existing.policyId, version: existing.version });
    }
  }
  for (const p of owned) {
    if (!desired.some((d) => d.key === p.managedKey)) {
      changes.push({ op: "delete", key: p.managedKey ?? p.policyId, name: p.name, policyId: p.policyId, version: p.version });
    }
  }

  const digest = createHash("sha256").update(JSON.stringify({
    apiVersion: file.apiVersion, file: file.file, environmentId, desired,
    current: current.map((p) => [p.policyId, p.version]).sort(),
    actions: referenced.map((a) => [a.id, a.name, a.currentVersionId, a.inputSchema]).sort(),
  })).digest("hex");
  const count = (op: PolicyChange["op"]) => changes.filter((c) => c.op === op).length;
  return {
    file: file.file, environmentId, digest, changes, errors,
    summary: { create: count("create"), update: count("update"), delete: count("delete"), unchanged: count("unchanged") },
    owned, current, desired,
  };
}

function publicPlan(plan: PolicyPlan): PolicyPlan {
  const { file, environmentId, digest, changes, summary, errors } = plan;
  return { file, environmentId, digest, changes, summary, errors };
}

export async function planPolicyFile(workspaceId: string, credentialEnvironmentId: string, source: string): Promise<PolicyPlan> {
  const file = parsePolicyFile(source);
  const environment = await resolveEnvironment(workspaceId, credentialEnvironmentId, file.environment);
  return publicPlan(await computePlan(db, workspaceId, environment.id, file));
}

export async function applyPolicyFile(
  workspaceId: string,
  credentialEnvironmentId: string,
  source: string,
  digest: string,
  scope: PolicyScopeContext,
  changeNote?: string,
): Promise<PolicyPlan & { applied: true }> {
  const file = parsePolicyFile(source);
  const environment = await resolveEnvironment(workspaceId, credentialEnvironmentId, file.environment);
  try {
    return await policyWrite(workspaceId, scope, changeNote ?? `Applied policy file ${file.file}`, async (tx) => {
      const plan = await computePlan(tx, workspaceId, environment.id, file, true);
      if (plan.digest !== digest) {
        throw new ApiError(409, "STALE_PLAN",
          "The policies, the file or its actions changed since this plan was made. Plan again and review the new changes.");
      }
      if (plan.errors.length) {
        throw new ApiError(400, "POLICY_FILE_INVALID", `The policy file cannot be applied: ${plan.errors.join(" ")}`, { errors: plan.errors });
      }
      const stale = () => new ApiError(409, "STALE_PLAN", "A policy changed while the plan was being applied. Plan again.");
      const createdAt = nextCreationTime(plan.current);
      for (const change of plan.changes) {
        if (change.op !== "delete") continue;
        const rows = await tx.delete(approvalPolicies)
          .where(and(eq(approvalPolicies.policyId, change.policyId), eq(approvalPolicies.version, change.version)))
          .returning({ id: approvalPolicies.id });
        if (!rows.length) throw stale();
      }
      for (const change of plan.changes) {
        if (change.op !== "update") continue;
        const { key: _key, ...fields } = change.after;
        const rows = await tx.update(approvalPolicies)
          .set({ ...fields, minAmount: null, conditions: null, scopeReviewedAt: sql`clock_timestamp()` as unknown as Date })
          .where(and(eq(approvalPolicies.policyId, change.policyId), eq(approvalPolicies.version, change.version)))
          .returning({ id: approvalPolicies.id });
        if (!rows.length) throw stale();
      }
      for (const change of plan.changes) {
        if (change.op !== "create") continue;
        const { key, ...fields } = change.after;
        await tx.insert(approvalPolicies).values({
          ...fields, workspaceId, environmentId: environment.id, policyId: generatePolicyId(),
          id: filePolicyRowId(environment.id, file.file, key), createdAt,
          managedByFile: file.file, managedKey: key, scopeReviewedAt: sql`clock_timestamp()`,
        });
      }
      return { ...publicPlan(plan), applied: true as const };
    });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") throw new ApiError(409, "STALE_PLAN", "A policy name or key collided while applying. Plan again.");
    throw error;
  }
}

export interface PolicyTestResult {
  name: string;
  pass: boolean;
  policy: string | null;
  effect: PolicyEffect;
  explanation: string;
}

function filePolicyRowId(environmentId: string, file: string, key: string): string {
  const hash = createHash("sha256").update(JSON.stringify([environmentId, file, key])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function nextCreationTime(current: ApprovalPolicy[]): Date {
  return new Date(Math.max(Date.now(), ...current.map((p) => p.createdAt.getTime() + 1)));
}

export async function testPolicyFile(
  workspaceId: string,
  credentialEnvironmentId: string,
  source: string,
  casesInput: unknown,
): Promise<{ file: string; passed: number; failed: number; results: PolicyTestResult[] }> {
  const file = parsePolicyFile(source);
  const cases = parseTestCases(casesInput);
  const environment = await resolveEnvironment(workspaceId, credentialEnvironmentId, file.environment);
  const plan = await computePlan(db, workspaceId, environment.id, file);
  if (plan.errors.length) {
    throw new ApiError(400, "POLICY_FILE_INVALID", `The policy file has errors: ${plan.errors.join(" ")}`, { errors: plan.errors });
  }
  const ownedByKey = new Map(plan.owned.map((p) => [p.managedKey, p]));
  const now = nextCreationTime(plan.current);
  const keyByPolicyId = new Map<string, string>();
  const rows: ApprovalPolicy[] = [
    ...plan.current.filter((p) => p.managedByFile !== file.file),
    ...plan.desired.map((d): ApprovalPolicy => {
      const existing = ownedByKey.get(d.key);
      const policyId = existing?.policyId ?? `file:${file.file}#${d.key}`;
      keyByPolicyId.set(policyId, d.key);
      const { key: _key, ...fields } = d;
      return {
        ...(existing ?? {}), ...fields, id: existing?.id ?? filePolicyRowId(environment.id, file.file, d.key), workspaceId, environmentId: environment.id,
        policyId, version: existing?.version ?? 1, minAmount: null, conditions: null,
        managedByFile: file.file, managedKey: d.key, createdAt: existing?.createdAt ?? now, updatedAt: now,
        scopeReviewedAt: now,
      } as ApprovalPolicy;
    }),
  ].filter((p) => p.enabled);
  const ordered = sortPolicies(rows);

  const results: PolicyTestResult[] = [];
  for (const c of cases) {
    const input = c.request.input ?? {};
    const decision = await decideFromPolicies(ordered, {
      kind: c.request.kind,
      actionName: c.request.kind === "action" ? c.request.action ?? null : null,
      agentId: c.request.agent ?? null,
      userId: c.request.user ?? null,
      tags: c.request.kind === "custom" ? c.request.tags ?? [] : [],
      payload: input,
      amount: typeof input.amount === "number" ? input.amount : null,
    });
    const policy = decision.matchedPolicyId ? keyByPolicyId.get(decision.matchedPolicyId) ?? decision.matchedPolicyId : null;
    const pass = (c.expect.effect === undefined || c.expect.effect === decision.effect) &&
      (c.expect.policy === undefined || c.expect.policy === policy);
    results.push({ name: c.name, pass, policy, effect: decision.effect, explanation: decision.explanation });
  }
  const passed = results.filter((r) => r.pass).length;
  return { file: file.file, passed, failed: results.length - passed, results };
}
