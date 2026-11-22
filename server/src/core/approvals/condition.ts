import { Environment } from "@marcbachmann/cel-js";
import { conditionRuntime, type BatchOutcome, type ConditionItem } from "./condition-runtime.ts";

export const CONDITION_MAX_LENGTH = 2000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LIMITS = { maxAstNodes: 300, maxDepth: 32, maxListElements: 100, maxMapEntries: 100, maxCallArguments: 8 };
const VARIABLES = [["input", "map"], ["agent", "map"], ["user", "map"], ["tags", "list<string>"],
  ["action", "map"], ["kind", "string"], ["environment", "map"]] as const;

export interface ConditionFacts {
  input: Record<string, unknown>;
  agent: { id: string | null };
  user: { id: string | null };
  tags: string[];
  action: { name: string | null };
  kind: "action" | "custom";
  environment: { id: string };
}

export interface ConditionFactDoc {
  name: string;
  type: string;
  description: string;
}

export const CONDITION_FACTS: ConditionFactDoc[] = [
  { name: "input", type: "map", description: "The call's input, or a custom request's payload." },
  { name: "agent.id", type: "string | null", description: "The agent making the call. Null when the call names no run." },
  { name: "user.id", type: "string | null", description: "The user the run acts for. Null when unattributed." },
  { name: "tags", type: "list<string>", description: "A custom request's tags. Empty for actions." },
  { name: "action.name", type: "string | null", description: "The action being invoked. Null for custom requests." },
  { name: "kind", type: "string", description: "\"action\" or \"custom\"." },
  { name: "environment.id", type: "string", description: "Trusted ID of the environment containing this policy; never caller-supplied input." },
];

type CelSchema = string | { [field: string]: CelSchema };

export function celSchemaFromJsonSchema(schema: unknown, depth = 0, budget = { nodes: 0 }): CelSchema | null {
  if (++budget.nodes > 512 || depth > 16) throw new Error("The action schema exceeds the policy checker's size or depth limit.");
  const s = schema as { type?: unknown; properties?: Record<string, unknown> } | null;
  if (!s || typeof s !== "object") return null;
  if (s.type === "object" || (s.type === undefined && s.properties)) {
    const props = s.properties && typeof s.properties === "object" ? Object.entries(s.properties) : [];
    if (!props.length) return "map";
    if (props.length > 512) throw new Error("The action schema has too many fields for policy checking.");
    return Object.fromEntries(props.map(([name, child]) => {
      if (name.length > 128) throw new Error("Action schema field names must be at most 128 characters for policy checking.");
      return [name, celSchemaFromJsonSchema(child, depth + 1, budget) ?? "dyn"];
    }));
  }
  switch (s.type) {
    case "string": return "string";
    case "number":
    case "integer": return "double";
    case "boolean": return "bool";
    case "array": return "list";
    default: return "dyn";
  }
}

export interface InputField {
  path: string;
  type: string;
  optional: boolean;
  description: string | null;
}

export function inputFieldsFromSchema(schema: unknown, prefix = "input", depth = 0, parentOptional = false): InputField[] {
  if (depth === 0) celSchemaFromJsonSchema(schema);
  const s = schema as { properties?: Record<string, unknown>; required?: unknown } | null;
  if (!s || typeof s !== "object" || !s.properties || typeof s.properties !== "object" || depth > 3) return [];
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : []);
  return Object.entries(s.properties).flatMap(([name, child]) => {
    const path = IDENTIFIER.test(name) ? `${prefix}.${name}` : `${prefix}[${JSON.stringify(name)}]`;
    const c = child as { description?: unknown } | null;
    const type = celSchemaFromJsonSchema(child);
    const field: InputField = {
      path,
      type: typeof type === "string" ? type : "map",
      optional: parentOptional || !required.has(name),
      description: c && typeof c.description === "string" ? c.description.slice(0, 300) : null,
    };
    return [field, ...inputFieldsFromSchema(child, path, depth + 1, field.optional)];
  }).slice(0, 128);
}

function environment(inputSchema?: unknown): Environment {
  const env = new Environment({ limits: LIMITS, homogeneousAggregateLiterals: false });
  const typed = inputSchema === undefined ? null : celSchemaFromJsonSchema(inputSchema);
  if (typed && typeof typed === "object") {
    env.registerType("ActionInput", { schema: typed });
    env.registerVariable("input", "ActionInput");
  } else {
    env.registerVariable("input", "map");
  }
  for (const [name, type] of VARIABLES) if (name !== "input") env.registerVariable(name, type);
  return env;
}

const runtime = conditionRuntime(LIMITS, VARIABLES);

export type ConditionCheck = { valid: true } | { valid: false; message: string };

export function checkCondition(source: string, opts: { inputSchema?: unknown } = {}): ConditionCheck {
  if (!source.trim()) return { valid: false, message: "The condition is empty. Remove it to match every request in scope." };
  if (source.length > CONDITION_MAX_LENGTH) {
    return { valid: false, message: `The condition is ${source.length} characters; the limit is ${CONDITION_MAX_LENGTH}.` };
  }
  let result: ReturnType<Environment["check"]>;
  try {
    result = environment(opts.inputSchema).check(source);
  } catch (error) {
    return { valid: false, message: (error as Error).message };
  }
  if (!result.valid) return { valid: false, message: result.error?.message ?? "The condition is not valid CEL." };
  if (result.type !== "bool" && result.type !== "dyn") {
    return { valid: false, message: `A condition must be true or false, but this produces ${result.type}.` };
  }
  return { valid: true };
}

export type ConditionOutcome = { result: boolean } | { error: string };

function factsProblem(facts: unknown): string | null {
  let nodes = 0;
  let characters = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: facts, depth: 0 }];
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++nodes > 10000 || item.depth > 32) return "Condition facts exceed the size or depth limit.";
    if (typeof item.value === "string") characters += item.value.length;
    else if (item.value && typeof item.value === "object") {
      for (const key in item.value) {
        if (!Object.hasOwn(item.value, key)) continue;
        characters += key.length;
        if (pending.length + nodes >= 10000) return "Condition facts exceed the size limit.";
        pending.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 });
      }
    }
    if (characters > 65536) return "Condition facts exceed 65536 characters.";
  }
  return null;
}

export type { BatchOutcome, ConditionItem };

export function normalizeBatchOutcome(outcome: unknown, length: number): BatchOutcome {
  const o = outcome as { index?: unknown; result?: unknown; error?: unknown } | null;
  const invalid: BatchOutcome = { index: 0, error: "Condition evaluation returned an invalid result." };
  if (!o || typeof o !== "object" || !Number.isInteger(o.index)) return invalid;
  const index = o.index as number;
  if (index === -1) return o.error === undefined && o.result === undefined ? { index: -1 } : invalid;
  if (index < 0 || index >= length) return invalid;
  if (typeof o.error === "string") return { index, error: o.error };
  if (o.result === true) return { index, result: true };
  return invalid;
}

export async function evaluateConditions(
  items: ConditionItem[],
  facts: Omit<ConditionFacts, "environment">,
): Promise<BatchOutcome> {
  if (!items.length) return { index: -1 };
  try {
    const problem = factsProblem(facts);
    if (problem) return { index: 0, error: problem };
    const tooLarge = items.findIndex((item) => item.source.length > CONDITION_MAX_LENGTH);
    const sendable = tooLarge === -1 ? items : items.slice(0, tooLarge);
    const outcome = normalizeBatchOutcome(await runtime(sendable, facts), sendable.length);
    if (outcome.index === -1 && tooLarge !== -1) return { index: tooLarge, error: "Condition expression is too large." };
    return outcome;
  } catch {
    return { index: 0, error: "Condition evaluation failed." };
  }
}

export async function evaluateCondition(source: string, facts: ConditionFacts): Promise<ConditionOutcome> {
  const { environment, ...rest } = facts;
  const outcome = await evaluateConditions([{ source, environmentId: environment.id }], rest);
  if (outcome.index === -1) return { result: false };
  return "error" in outcome ? { error: outcome.error } : { result: true };
}

const literal = (value: unknown) => JSON.stringify(value);
const field = (key: string) => IDENTIFIER.test(key) ? `input.${key}` : `input[${literal(key)}]`;
const present = (key: string) => IDENTIFIER.test(key) ? `has(input.${key})` : `${literal(key)} in input`;

export function legacyCondition(policy: { minAmount: string | number | null; conditions: Record<string, unknown> | null }): string | null {
  const parts: string[] = [];
  if (policy.minAmount !== null && policy.minAmount !== undefined) {
    parts.push(`input.amount >= ${Number(policy.minAmount)}`);
  }
  for (const [key, want] of Object.entries(policy.conditions ?? {})) {
    parts.push(`${present(key)} && ${field(key)} == ${literal(want)}`);
  }
  return parts.length ? parts.join(" && ") : null;
}
