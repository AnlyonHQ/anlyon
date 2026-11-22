import { descriptionVerb, nameSignals, type Verb } from "./classify.ts";
import { isObject } from "./schema.ts";
import { visible } from "./text.ts";
import type { CapabilityTag, McpTool, RiskClass, ToolTag } from "./types.ts";
import { firstSentence, words } from "./words.ts";

export const CAPABILITY_TAGS: CapabilityTag[] = ["private-data", "untrusted-input", "outbound"];

const PRIVATE_NOUNS: Record<string, string> = {
  file: "files", directory: "files", folder: "files", drive: "files", document: "documents", doc: "documents",
  note: "notes", mail: "mail", email: "mail", inbox: "mail", mailbox: "mail", message: "messages",
  chat: "messages", conversation: "messages", dm: "messages", thread: "messages", database: "databases",
  db: "databases", table: "databases", sql: "databases", secret: "secrets", credential: "secrets",
  password: "secrets", passphrase: "secrets", vault: "secrets", keychain: "secrets", calendar: "calendars",
  meeting: "calendars", repo: "repositories", repository: "repositories", commit: "repositories",
  branch: "repositories", contact: "contacts",
};

const PRIVATE_INPUTS = new Set([
  "file", "directory", "folder", "repo", "repository", "calendar", "database", "table", "secret", "mailbox", "inbox",
]);

const UNTRUSTED_NOUNS: Record<string, string> = {
  url: "web pages", uri: "web pages", web: "web pages", webpage: "web pages", website: "web pages",
  html: "web pages", browser: "web pages", internet: "web pages", http: "web pages", https: "web pages",
  rss: "web pages", email: "inbound email", mail: "inbound email", inbox: "inbound email",
  mailbox: "inbound email", message: "messages", chat: "messages", dm: "messages", thread: "messages",
  conversation: "messages", comment: "comments", reply: "comments", mention: "comments", review: "comments",
  discussion: "comments", issue: "issues", ticket: "issues", tweet: "posts", post: "posts",
};

const WEB_VERBS = new Set(["scrape", "crawl", "browse"]);

const LOAD_VERBS = new Set(["navigate", "open", "visit", "goto"]);

const OUTBOUND_VERBS = new Set(["post", "publish", "share", "tweet", "forward"]);

const OUTBOUND_NOUNS = new Set([
  "comment", "issue", "message", "email", "mail", "sms", "dm", "reply", "post", "tweet", "gist", "discussion",
]);

const DESTINATION_INPUTS = new Set([
  "to", "cc", "bcc", "recipient", "channel", "channel_id", "channel_name", "chat_id", "phone", "phone_number",
]);

const URL_INPUTS = new Set([
  "url", "uri", "href", "endpoint", "webhook", "webhook_url", "callback_url", "target_url",
]);

const INPUT_VERBS = new Set(["validate", "explain"]);

const RUN_VERBS = new Set(["run", "execute", "exec", "query", "call", "invoke", "evaluate"]);

const STATEMENT_INPUTS = new Set(["sql", "statement"]);

interface Place {
  label: string;
  words: string[];
  verbAt: number;
  verb: Verb | null;
}

function nameOf(tool: McpTool): Place {
  const list = words(tool.name);
  const { verb } = nameSignals(tool.name);
  return { label: `The name "${visible(tool.name)}"`, words: list, verbAt: verb ? list.indexOf(verb.word) : -1, verb };
}

function sentenceOf(tool: McpTool): Place | null {
  if (!tool.description) return null;
  const sentence = firstSentence(tool.description);
  const list = words(sentence);
  const verb = descriptionVerb(tool.description);
  return { label: "The description's first sentence", words: list, verbAt: verb ? list.indexOf(verb.word) : -1, verb };
}

function nounIn(place: Place, nouns: Record<string, string> | Set<string>): string | null {
  const has = (w: string) => (nouns instanceof Set ? nouns.has(w) : Object.hasOwn(nouns, w));
  for (let i = 0; i < place.words.length; i++) {
    if (i === place.verbAt) continue;
    const word = place.words[i]!;
    if (word === "pull" && place.words[i + 1] === "request" && has("issue")) return "pull request";
    if (has(word)) return word;
  }
  return null;
}

function meaningOf(noun: string, nouns: Record<string, string>): string {
  return noun === "pull request" ? (nouns.issue ?? "issues") : (nouns[noun] ?? noun);
}

interface InputName {
  path: string;
  key: string;
}

function inputNames(schema: unknown): InputName[] {
  const out: InputName[] = [];
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (!isObject(value) || !isObject(value.properties)) return;
    for (const [name, sub] of Object.entries(value.properties)) {
      out.push({ path: `${prefix}${name}`, key: words(name).join("_") });
      if (depth < 1 && isObject(sub) && sub.type === "object") walk(sub, `${prefix}${name}.`, depth + 1);
    }
  };
  walk(schema, "", 0);
  return out;
}

function topLevelNames(schema: unknown): InputName[] {
  return inputNames(schema).filter((n) => !n.path.includes("."));
}

function reads(cls: RiskClass, name: Place, sentence: Place | null): boolean {
  const verb = name.verb ?? sentence?.verb;
  if (verb && INPUT_VERBS.has(verb.word)) return false;
  if (cls === "read") return true;
  if (name.verb) return name.verb.kind === "read";
  return sentence?.verb?.kind === "read";
}

function privateData(tool: McpTool, cls: RiskClass, name: Place, sentence: Place | null): string[] {
  const reasons: string[] = [];
  if (reads(cls, name, sentence)) {
    for (const place of [name, sentence]) {
      if (!place) continue;
      const noun = nounIn(place, PRIVATE_NOUNS);
      if (noun) {
        const verb = place.verb && place.verb.kind === "read" ? `"${place.verb.word}" and ` : "";
        reasons.push(`${place.label} says ${verb}"${noun}": it reads ${meaningOf(noun, PRIVATE_NOUNS)}.`);
      }
    }
    const input = topLevelNames(tool.inputSchema).find((n) => n.key.split("_").some((w) => PRIVATE_INPUTS.has(w)));
    if (input) {
      const noun = input.key.split("_").find((w) => PRIVATE_INPUTS.has(w))!;
      reasons.push(`The input names ${article(noun)} (input.${visible(input.path)}), and the tool reads: it reads ${meaningOf(noun, PRIVATE_NOUNS)}.`);
    }
  }
  if (name.verb && RUN_VERBS.has(name.verb.word)) {
    const statement = topLevelNames(tool.inputSchema).find((n) => STATEMENT_INPUTS.has(n.key));
    if (statement) {
      reasons.push(`The name says "${name.verb.word}" and the input takes a statement (input.${visible(statement.path)}): it reads databases.`);
    }
  }
  return reasons;
}

function untrustedInput(tool: McpTool, cls: RiskClass, name: Place, sentence: Place | null): string[] {
  const reasons: string[] = [];
  if (tool.annotations?.openWorldHint === true) {
    reasons.push("The server marks it openWorldHint: true: it reaches things outside the server's own data.");
  }
  const reading = reads(cls, name, sentence);
  const loads = name.verb !== null && LOAD_VERBS.has(name.verb.word);
  for (const place of [name, sentence]) {
    if (!place) continue;
    const webVerb = place.words.find((w) => WEB_VERBS.has(w));
    if (webVerb) {
      reasons.push(`${place.label} says "${webVerb}": it reads web pages, which anyone can write.`);
      continue;
    }
    if (!reading && !loads) continue;
    const noun = nounIn(place, UNTRUSTED_NOUNS);
    if (!noun) continue;
    const meaning = meaningOf(noun, UNTRUSTED_NOUNS);
    if (!reading && meaning !== "web pages") continue;
    const verb = place.verb ? `"${place.verb.word}" and ` : "";
    reasons.push(`${place.label} says ${verb}"${noun}": it reads ${meaning}, which ${meaning === "web pages" ? "anyone" : "other people"} can write.`);
  }
  if (reading || loads) {
    const url = topLevelNames(tool.inputSchema).find((n) => URL_INPUTS.has(n.key));
    if (url) {
      reasons.push(`The input takes a URL (input.${visible(url.path)}), and the tool reads it: it reads web pages, which anyone can write.`);
    }
  }
  return dedupe(reasons);
}

function outbound(tool: McpTool, cls: RiskClass, name: Place, sentence: Place | null): string[] {
  const reasons: string[] = [];
  const shown = visible(tool.name);
  const { extra } = nameSignals(tool.name);
  const verbs = [name.verb, ...extra].filter((v): v is Verb => v !== null);
  const sends = verbs.find((v) => v.kind === "send" || OUTBOUND_VERBS.has(v.word));
  if (sends) {
    reasons.push(
      sends.with
        ? `The name "${shown}" says "${sends.word}" and "${sends.with}": it sends something to other people.`
        : `The name "${shown}" says "${sends.word}": it sends or publishes something to other people.`,
    );
  } else if (name.verb && (name.verb.kind === "write" || name.verb.kind === "send")) {
    const noun = nounIn(name, OUTBOUND_NOUNS);
    if (noun) reasons.push(`The name "${shown}" says "${name.verb.word}" and "${noun}": it writes something other people read.`);
  } else if (!name.verb && sentence?.verb && (sentence.verb.kind === "send" || OUTBOUND_VERBS.has(sentence.verb.word))) {
    reasons.push(`The description's first verb is "${sentence.verb.word}": it sends or publishes something to other people.`);
  }

  if (cls !== "destructive") {
    const names = inputNames(tool.inputSchema);
    if (cls !== "read") {
      const destination = names.find((n) => DESTINATION_INPUTS.has(n.key));
      if (destination) reasons.push(`The input takes a destination (input.${visible(destination.path)}): what the tool writes goes there.`);
    }
    const url = names.find((n) => URL_INPUTS.has(n.key));
    if (url) reasons.push(`The input takes a URL (input.${visible(url.path)}): a request to a URL can carry data to whoever runs it.`);
  }
  return reasons;
}

export function capabilityTags(tool: McpTool, cls: RiskClass): ToolTag[] {
  const name = nameOf(tool);
  const sentence = sentenceOf(tool);
  const found: Array<[CapabilityTag, string[]]> = [
    ["private-data", privateData(tool, cls, name, sentence)],
    ["untrusted-input", untrustedInput(tool, cls, name, sentence)],
    ["outbound", outbound(tool, cls, name, sentence)],
  ];
  return found.filter(([, reasons]) => reasons.length > 0).map(([tag, reasons]) => ({ tag, reasons: dedupe(reasons) }));
}

function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
