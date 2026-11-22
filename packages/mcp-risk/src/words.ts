export const READ_WORDS = new Set([
  "get", "list", "search", "find", "read", "fetch", "query", "describe", "show", "view", "lookup",
  "retrieve", "count", "inspect", "browse", "preview", "resolve", "explain", "summarize", "summarise",
  "analyze", "analyse", "validate", "compare", "diff", "status", "log", "snapshot", "screenshot",
  "tree", "wait", "ping", "whoami",
]);

export const WRITE_WORDS = new Set([
  "create", "update", "add", "set", "post", "put", "patch", "upsert", "replace", "modify", "edit",
  "write", "insert", "move", "rename", "copy", "upload", "assign", "unassign", "apply", "run",
  "execute", "exec", "click", "type", "fill", "press", "drag", "hover", "select", "navigate", "open",
  "close", "reopen", "star", "unstar", "fork", "comment", "label", "react", "approve", "reject",
  "submit", "request", "trigger", "start", "stop", "restart", "deploy", "install", "enable", "disable",
  "toggle", "mark", "pin", "unpin", "schedule", "reschedule", "invoke", "call", "evaluate", "generate",
  "save", "store", "import", "sync", "push", "commit", "checkout", "reset", "init", "resize", "handle",
  "convert", "dismiss", "lock", "unlock", "subscribe", "unsubscribe", "attach", "detach", "link", "unlink",
]);

export const MONEY_WORDS = new Set([
  "refund", "charge", "capture", "payout", "pay", "payment", "withdraw", "withdrawal",
  "disburse", "disbursement", "purchase", "topup", "reversal",
]);

export const SEND_WORDS = new Set(["send", "resend", "notify", "broadcast", "invite", "deliver", "reply"]);

export const FINAL_WORDS = new Set(["merge", "publish", "transfer", "finalize", "finalise"]);

export const DESTROY_WORDS = new Set([
  "delete", "remove", "destroy", "purge", "erase", "wipe", "cancel", "void", "revoke", "terminate",
  "archive", "drop", "truncate", "kill", "uninstall",
]);

export const QUALIFIERS = new Set([
  "method", "setting", "config", "configuration", "link", "page", "type", "status", "preference",
  "profile", "schedule", "intent",
]);

export const MESSAGE_NOUNS = new Set(["message", "email", "mail", "sms", "dm"]);

export const FILLER_WORDS = new Set([
  "use", "this", "tool", "to", "a", "an", "the", "will", "can", "you", "allow", "let", "help", "used",
  "it", "that", "which", "please", "simply", "just", "also", "then", "and", "or", "permanently",
  "immediately", "quickly", "safely", "directly",
]);

const NOT_PLURAL = new Set(["this", "its", "has", "was", "does", "is", "as", "us", "yes", "plus", "less", "news", "alias", "status", "always"]);

export function singular(word: string): string {
  if (NOT_PLURAL.has(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(sses|xes|ches|shes|zzes)$/.test(word)) return word.slice(0, -2);
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

export function countedWords(text: string): string[] {
  const list = words(text);
  return list.filter((word, i) => !(MONEY_WORDS.has(word) && QUALIFIERS.has(list[i + 1] ?? "")));
}

export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)|\n/);
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}
