import { parseImpactDeclaration } from "../effects/declarations.ts";

export type ImportRisk = "read" | "write" | "irreversible" | "destructive";

const RANK: Record<ImportRisk, number> = { read: 0, write: 1, irreversible: 2, destructive: 3 };
const RISKS = Object.keys(RANK) as ImportRisk[];

export interface SuggestedImpact {
  dimension: string;
  unit: string | null;
  amount: string;
  bound: "exact" | "upper_bound";
}

export interface ImportSuggestion {
  risk: ImportRisk;
  reasons: string[];
  requiresApproval: boolean;
  impact: SuggestedImpact | null;
  impactNote: string | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MONEY_WORDS = new Set([
  "refund", "charge", "capture", "payout", "pay", "payment", "withdraw", "withdrawal",
  "disburse", "disbursement", "purchase", "topup", "reversal",
]);
const SEND_WORDS = new Set(["send", "resend", "notify", "broadcast", "invite", "deliver"]);
const FINAL_WORDS = new Set(["merge", "publish", "transfer"]);
const DESTROY_WORDS = new Set([
  "delete", "remove", "destroy", "purge", "erase", "wipe", "cancel", "void", "revoke", "terminate", "archive",
]);
const QUALIFIERS = new Set([
  "method", "setting", "config", "configuration", "link", "page", "type", "status", "preference", "profile", "schedule",
]);
const EMAIL_WORDS = new Set(["email", "mail"]);
const BATCH_WORDS = new Set(["batch", "bulk"]);
const PLAIN_VERBS = new Set(["get", "post", "put", "patch", "create", "update", "list", "add", "set", "upsert", "replace", "modify"]);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

function countedWords(segment: string): string[] {
  const list = words(segment);
  return list.filter((word, i) => !(MONEY_WORDS.has(word) && QUALIFIERS.has(list[i + 1] ?? "")));
}

function verbWords(path: string, operation: Json): Array<{ word: string; from: string }> {
  const out: Array<{ word: string; from: string }> = [];
  const firstWord = (text: string, from: string) => {
    const first = countedWords(text)[0];
    if (first && !PLAIN_VERBS.has(first)) out.push({ word: first, from });
  };
  if (typeof operation.operationId === "string") {
    firstWord(operation.operationId.split("/").filter(Boolean).at(-1) ?? "", `operationId "${operation.operationId}"`);
  }
  if (typeof operation.summary === "string") firstWord(operation.summary, `summary "${operation.summary}"`);
  const lastSegment = path.split("/").filter(Boolean).at(-1);
  if (lastSegment && !/^\{.*\}$/.test(lastSegment)) {
    for (const word of countedWords(lastSegment.replace(/\.[a-z]+$/i, ""))) {
      out.push({ word, from: `path segment "${lastSegment}"` });
    }
  }
  return out;
}

const AMOUNT_NAME = /amount/i;
const CURRENCY_NAME = /^currency(_?code)?$/i;
const RECIPIENT_NAME = /^(to|recipients?|cc|bcc)$/i;
const MAX_BODY_DEPTH = 2;

interface MoneyField {
  path: string;
  type: string;
  required: boolean;
  currency: string | null;
  hasCurrency: boolean;
}

interface RecipientField {
  path: string;
  isArray: boolean;
  uncounted: string[];
}

function requiredSet(schema: Json): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
}

function findMoney(schema: Json, prefix = "", depth = 0): MoneyField | null {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = requiredSet(schema);
  const names = Object.keys(properties);
  const currencyName = names.find((name) => CURRENCY_NAME.test(name));
  const amountName = names.find((name) => name.toLowerCase() === "amount") ?? names.find((name) => AMOUNT_NAME.test(name) && isObject(properties[name]) && (properties[name] as Json).type !== "object");
  if (amountName && isObject(properties[amountName])) {
    const amount = properties[amountName] as Json;
    const currency = currencyName && isObject(properties[currencyName]) ? (properties[currencyName] as Json) : null;
    const only = currency && Array.isArray(currency.enum) && currency.enum.length === 1 && typeof currency.enum[0] === "string" ? currency.enum[0].toLowerCase() : null;
    return {
      path: `${prefix}${amountName}`,
      type: String(amount.type ?? "unknown"),
      required: required.has(amountName),
      currency: only && /^[a-z]{3}$/.test(only) ? only : null,
      hasCurrency: currency !== null,
    };
  }
  if (depth >= MAX_BODY_DEPTH) return null;
  for (const name of names) {
    const sub = properties[name];
    if (isObject(sub) && sub.type === "object") {
      const found = findMoney(sub, `${prefix}${name}.`, depth + 1);
      if (found && found.hasCurrency) return { ...found, required: found.required && required.has(name) };
    }
  }
  return null;
}

function findRecipients(schema: Json, prefix = "", depth = 0): RecipientField | null {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  const primary = names.find((name) => /^(to|recipients?)$/i.test(name));
  if (primary && isObject(properties[primary])) {
    return {
      path: `${prefix}${primary}`,
      isArray: (properties[primary] as Json).type === "array",
      uncounted: names.filter((name) => RECIPIENT_NAME.test(name) && name !== primary),
    };
  }
  if (depth >= MAX_BODY_DEPTH) return null;
  for (const name of names) {
    const sub = properties[name];
    if (isObject(sub) && sub.type === "object") {
      const found = findRecipients(sub, `${prefix}${name}.`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function batchArray(schema: Json): string | null {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const arrays = Object.entries(properties).filter(([, sub]) => isObject(sub) && sub.type === "array");
  return arrays.length === 1 ? arrays[0][0] : null;
}

function hint(operation: Json, ...names: string[]): unknown {
  for (const name of names) if (name in operation) return operation[name];
  for (const container of ["x-mcp", "x-mcp-annotations"]) {
    const value = operation[container];
    if (isObject(value)) for (const name of names) if (name in value) return value[name];
  }
  return undefined;
}

function methodFloor(method: string): ImportRisk {
  if (method === "DELETE") return "destructive";
  if (method === "POST" || method === "PUT" || method === "PATCH") return "write";
  return "read";
}

const ONE_MUTATION: SuggestedImpact = { dimension: "resource_mutations", unit: "resource_mutations", amount: "1", bound: "exact" };

export function suggestForOperation(method: string, path: string, operation: Json, body: Json | null): ImportSuggestion {
  const reasons: string[] = [];
  let risk: ImportRisk = method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write";
  reasons.push(
    method === "GET"
      ? "GET reads and changes nothing."
      : method === "DELETE"
        ? "DELETE removes the resource."
        : `${method} changes something.`,
  );
  const raise = (to: ImportRisk, reason: string) => {
    if (RANK[to] > RANK[risk]) risk = to;
    reasons.push(reason);
  };

  const verbs = method === "GET" ? [] : verbWords(path, operation);
  const named = (set: Set<string>) => verbs.find((v) => set.has(v.word));
  const money = named(MONEY_WORDS);
  const send = named(SEND_WORDS);
  const destroy = named(DESTROY_WORDS);
  const final = named(FINAL_WORDS);
  if (destroy) raise("destructive", `The ${destroy.from} says "${destroy.word}": it removes or ends something.`);
  if (money) raise("irreversible", `The ${money.from} says "${money.word}": it usually moves money, which cannot be taken back.`);
  if (final) raise("irreversible", `The ${final.from} says "${final.word}": another call does not undo it.`);
  if (send && !money) raise("irreversible", `The ${send.from} says "${send.word}": what it sends cannot be taken back.`);

  const moneyField = method === "GET" || !body ? null : findMoney(body);
  const countsMoney = moneyField && moneyField.hasCurrency;
  if (countsMoney) raise("irreversible", `The request carries an amount (input.${moneyField.path}) and a currency, so it moves money.`);
  const recipients = method === "GET" || !body ? null : findRecipients(body);
  if (recipients) raise("irreversible", `The request addresses people (input.${recipients.path}): what it sends cannot be taken back.`);

  let declaredImpact: SuggestedImpact | null = null;
  const declaredRisk = operation["x-anlyon-risk"];
  if (typeof declaredRisk === "string" && (RISKS as string[]).includes(declaredRisk)) {
    risk = declaredRisk as ImportRisk;
    reasons.push(`The spec declares x-anlyon-risk: ${declaredRisk}.`);
  } else {
    if (hint(operation, "x-destructive", "destructiveHint") === true) raise("destructive", "The spec marks it destructive.");
    if (hint(operation, "x-irreversible") === true) raise("irreversible", "The spec marks it irreversible.");
    if (hint(operation, "x-read-only", "x-readonly", "readOnlyHint") === true && risk === "write") {
      risk = "read";
      reasons.push("The spec marks it read-only.");
    }
  }
  const floor = methodFloor(method);
  if (RANK[risk] < RANK[floor]) {
    risk = floor;
    reasons.push(`A ${method} is suggested as at least ${floor}, whatever the spec declares.`);
  }
  if ("x-anlyon-impact" in operation) {
    try {
      const parsed = parseImpactDeclaration(operation["x-anlyon-impact"]);
      declaredImpact = { ...parsed };
      reasons.push("The spec declares x-anlyon-impact.");
    } catch (error) {
      reasons.push(`x-anlyon-impact was ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let impact: SuggestedImpact | null;
  let impactNote: string | null = null;
  const notes: string[] = [];

  if (declaredImpact) {
    impact = declaredImpact;
  } else if (risk === "read") {
    impact = null;
  } else if (countsMoney || (money && moneyField)) {
    const field = moneyField!;
    if (field.type === "integer") {
      impact = { dimension: "money", unit: field.currency, amount: `input.${field.path}`, bound: "exact" };
      notes.push(`Counts input.${field.path} as minor units (cents for usd). Check that the API takes minor units.`);
      if (!field.currency) {
        notes.push("The currency is an input, so choose the one currency this declaration counts in before accepting it.");
      }
      if (!field.required) {
        notes.push(`${field.path} is optional. A call that leaves it out has no amount to count, and an impact limit that applies refuses it.`);
      }
    } else {
      impact = { ...ONE_MUTATION };
      notes.push(`${field.path} is a ${field.type}, and Anlyon counts money in whole minor units, so this counts one change per call. Declare the money impact by hand if the API also takes minor units.`);
    }
  } else if (recipients || send) {
    const unitWords = new Set([...verbs.map((v) => v.word), ...words(path)]);
    const dimension = [...EMAIL_WORDS].some((w) => unitWords.has(w)) ? "emails" : "messages";
    if (recipients?.isArray) {
      impact = { dimension, unit: dimension, amount: `count(input.${recipients.path})`, bound: "exact" };
      notes.push(`Counts one of ${dimension} per entry in ${recipients.path}.`);
    } else {
      impact = { dimension, unit: dimension, amount: "1", bound: "exact" };
      if (recipients) notes.push(`${recipients.path} is one value. If it can hold several addresses, this counts one per call.`);
    }
    if (recipients && recipients.uncounted.length > 0) {
      notes.push(`${recipients.uncounted.join(" and ")} are not counted.`);
    }
  } else {
    const pathWords = new Set(words(path));
    const array = body && [...BATCH_WORDS].some((w) => pathWords.has(w)) ? batchArray(body) : null;
    if (array) {
      impact = { dimension: "resource_mutations", unit: "resource_mutations", amount: `count(input.${array})`, bound: "exact" };
      notes.push(`A batch call: counts one change per entry in ${array}.`);
    } else {
      impact = { ...ONE_MUTATION };
    }
  }
  if (notes.length > 0) impactNote = notes.join(" ");

  return {
    risk,
    reasons,
    requiresApproval: RANK[risk] >= RANK.irreversible,
    impact,
    impactNote,
  };
}

const MAX_ALLOWED_HOSTS = 20;
const HOSTNAME = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function suggestAllowedHosts(baseUrl: string, servers: unknown[]): string[] {
  const out: string[] = [];
  const add = (url: string) => {
    const match = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
    if (!match) return;
    let host = match[1].toLowerCase().replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    if (host.includes("{")) {
      const suffix = /^\{[^}]+\}(\.[^{}]+)$/.exec(host);
      if (!suffix) return;
      host = suffix[1];
    }
    if (HOSTNAME.test(host) && !out.includes(host)) out.push(host);
  };
  add(baseUrl);
  for (const server of servers) {
    if (isObject(server) && typeof server.url === "string") add(server.url);
  }
  return out.slice(0, MAX_ALLOWED_HOSTS);
}
