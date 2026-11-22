import { findMoney, findRecipients, findCodeInput } from "./schema.ts";
import { visible } from "./text.ts";
import type { Finding, McpTool, RiskClass } from "./types.ts";
import {
  DESTROY_WORDS,
  FILLER_WORDS,
  FINAL_WORDS,
  MESSAGE_NOUNS,
  MONEY_WORDS,
  READ_WORDS,
  SEND_WORDS,
  WRITE_WORDS,
  countedWords,
  firstSentence,
} from "./words.ts";

export const RANK: Record<RiskClass, number> = { read: 0, write: 1, irreversible: 2, destructive: 3 };

export type Kind = "read" | "write" | "money" | "send" | "final" | "destroy";

const KIND_CLASS: Record<Kind, RiskClass> = {
  read: "read",
  write: "write",
  money: "irreversible",
  send: "irreversible",
  final: "irreversible",
  destroy: "destructive",
};

const KIND_MEANING: Record<Kind, string> = {
  read: "a word for reading",
  write: "a word for a change",
  money: "a word that usually means money moves, which cannot be taken back",
  send: "a word for sending, and what is sent cannot be taken back",
  final: "a word for a change that another call does not undo",
  destroy: "a word for removing or ending something",
};

const DESCRIPTION_READ_WORDS = new Set(["return", "display"]);

export function kindOf(word: string, inDescription = false): Kind | null {
  if (DESTROY_WORDS.has(word)) return "destroy";
  if (MONEY_WORDS.has(word)) return "money";
  if (SEND_WORDS.has(word)) return "send";
  if (FINAL_WORDS.has(word)) return "final";
  if (READ_WORDS.has(word) || (inDescription && DESCRIPTION_READ_WORDS.has(word))) return "read";
  if (WRITE_WORDS.has(word)) return "write";
  return null;
}

const FINAL_WORDING =
  /\b(?:cannot|can ?not|can't)\s+be\s+(?:undone|reversed|recovered|restored)\b|\birreversibl[ey]\b|\bpermanently\s+(?:delete|deletes|remove|removes|destroy|destroys|erase|erases)\b/i;

export interface Classification {
  class: RiskClass;
  reasons: string[];
  findings: Finding[];
}

export interface Verb {
  word: string;
  kind: Kind;
  with?: string;
}

export function nameSignals(name: string): { verb: Verb | null; extra: Verb[] } {
  const list = countedWords(name);
  let index = -1;
  let verb: Verb | null = null;
  for (let i = 0; i < list.length; i++) {
    const word = list[i]!;
    const kind = kindOf(word);
    if (kind) {
      index = i;
      verb = { word, kind };
      break;
    }
  }
  if (!verb) return { verb: null, extra: [] };
  if (verb.word === "post") {
    const noun = list.slice(index + 1).find((w) => MESSAGE_NOUNS.has(w));
    if (noun) verb = { word: "post", kind: "send", with: noun };
  }
  if (verb.kind === "read") return { verb, extra: [] };

  const extra: Verb[] = [];
  const next = list[index + 1];
  if (verb.kind === "write" && next && (MONEY_WORDS.has(next) || SEND_WORDS.has(next))) {
    extra.push({ word: next, kind: kindOf(next)! });
  }
  for (let i = index + 1; i < list.length - 1; i++) {
    if (list[i] === "and" || list[i] === "then") {
      const word = list[i + 1]!;
      const kind = kindOf(word);
      if (kind && kind !== "read") extra.push({ word, kind });
    }
  }
  return { verb, extra };
}

export function descriptionVerb(description: string): Verb | null {
  const sentence = firstSentence(description);
  const list = countedWords(sentence);
  const index = list.findIndex((w) => !FILLER_WORDS.has(w));
  if (index === -1) return null;
  const word = list[index]!;
  const kind = kindOf(word, true);
  if (!kind) return null;
  if (word === "post") {
    const noun = list.slice(index + 1).find((w) => MESSAGE_NOUNS.has(w));
    if (noun) return { word, kind: "send", with: noun };
  }
  return { word, kind };
}

function says(verb: Verb): string {
  return verb.with ? `"${verb.word}" and "${verb.with}"` : `"${verb.word}"`;
}

function meaning(verb: Verb): string {
  return verb.with ? "it sends a message, which cannot be taken back" : KIND_MEANING[verb.kind];
}

export function classifyTool(tool: McpTool): Classification {
  const reasons: string[] = [];
  const shown = visible(tool.name);
  const findings: Finding[] = [];
  let evidence: RiskClass | null = null;
  const raise = (to: RiskClass, reason: string) => {
    if (evidence === null || RANK[to] > RANK[evidence]) evidence = to;
    reasons.push(reason);
  };

  const { verb: nameVerb, extra } = nameSignals(tool.name);
  if (nameVerb) {
    raise(KIND_CLASS[nameVerb.kind], `The name "${shown}" says ${says(nameVerb)}: ${meaning(nameVerb)}.`);
    for (const word of extra) {
      raise(KIND_CLASS[word.kind], `The name "${shown}" also says "${word.word}": ${KIND_MEANING[word.kind]}.`);
    }
  }

  const description = tool.description ?? "";
  const descVerb = description ? descriptionVerb(description) : null;
  if (descVerb) {
    const to = KIND_CLASS[descVerb.kind];
    const current = evidence as RiskClass | null;
    if (current === null || RANK[to] > RANK[current]) {
      raise(to, `The description's first verb is ${says(descVerb)}: ${meaning(descVerb)}.`);
    }
  }
  const finalWording = FINAL_WORDING.exec(description);
  if (finalWording) {
    raise("irreversible", `The description says "${finalWording[0]}".`);
  }

  const schema = tool.inputSchema;
  const readsByWords = (evidence as RiskClass | null) === "read";
  if (!readsByWords) {
    const money = findMoney(schema);
    if (money && money.hasCurrency) {
      raise("irreversible", `The input carries an amount (input.${money.path}) and a currency, so it moves money.`);
    }
    const recipients = findRecipients(schema);
    if (recipients) {
      raise("irreversible", `The input addresses people (input.${recipients.path}): what it sends cannot be taken back.`);
    }
  }
  const code = findCodeInput(schema);
  if (code) {
    raise("write", `The input takes a statement or command to run (input.${code}), which can change anything it can reach.`);
  }

  const fromWords = evidence as RiskClass | null;
  let risk: RiskClass = fromWords ?? "write";
  if (fromWords === null) {
    reasons.push("Nothing in its name or description says what it does, so it is counted as a write.");
  }

  const hints = tool.annotations ?? {};
  const conflict = (message: string) =>
    findings.push({
      id: "annotation-conflict",
      severity: "warn",
      tool: tool.name,
      message,
      evidence: `annotations: ${JSON.stringify(pickHints(hints))}${reasons.length ? `; ${reasons[0]}` : ""}`,
    });

  if (hints.readOnlyHint === true && hints.destructiveHint === true) {
    conflict(`The server marks "${shown}" both read-only (readOnlyHint: true) and destructive (destructiveHint: true).`);
  }
  if (hints.destructiveHint === true) {
    if (RANK.destructive > RANK[risk]) risk = "destructive";
    reasons.push("The server marks it destructive (destructiveHint: true).");
    if (nameVerb?.kind === "read") {
      conflict(`The server marks "${shown}" destructive (destructiveHint: true), and its name says "${nameVerb.word}", a word for reading.`);
    }
  }
  if (hints.readOnlyHint === false && risk === "read") {
    risk = "write";
    reasons.push("The server marks it as not read-only (readOnlyHint: false).");
    conflict(`The server marks "${shown}" as not read-only (readOnlyHint: false), and its words say it reads.`);
  }
  if (hints.readOnlyHint === true && risk !== "read") {
    reasons.push("The server marks it read-only (readOnlyHint: true), but an annotation never lowers a class.");
    if (fromWords !== null && fromWords !== "read") {
      conflict(`The server marks "${shown}" read-only (readOnlyHint: true), and its own name, description or input give the class "${fromWords}".`);
    }
  }
  if (hints.destructiveHint === false && fromWords === "destructive") {
    reasons.push("The server marks it not destructive (destructiveHint: false), but an annotation never lowers a class.");
    conflict(`The server marks "${shown}" not destructive (destructiveHint: false), and its own name, description or input give the class "destructive".`);
  }

  return { class: risk, reasons, findings };
}

function pickHints(hints: McpTool["annotations"] & object): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof hints[key] === "boolean") out[key] = hints[key];
  }
  return out;
}
