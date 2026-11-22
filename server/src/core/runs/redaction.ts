import { env } from "../../config/env.ts";

const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024;
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|credential|cookie|ssn|card[-_]?number/i;

function maxPayloadBytes(): number {
  const configured = Number(env.TRACE_MAX_PAYLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PAYLOAD_BYTES;
}

function redactionEnabled(): boolean {
  return env.TRACE_REDACTION !== "off";
}

const MAX_REDACTION_DEPTH = 12;

function redactKeys(value: unknown, depth = 0, strict = false): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACTION_DEPTH) return strict ? "[OMITTED]" : value;
  if (Array.isArray(value)) return value.map((v) => redactKeys(v, depth + 1, strict));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactKeys(v, depth + 1, strict);
  }
  return out;
}

export function redactSensitiveKeys(value: unknown): unknown {
  return redactKeys(value, 0, true);
}

export function redactPayload(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const redacted = redactionEnabled() ? redactKeys(value) : value;

  const serialized = JSON.stringify(redacted);
  if (serialized !== undefined && serialized.length > maxPayloadBytes()) {
    return { __anlyon_omitted: "payload_too_large", bytes: serialized.length };
  }
  return redacted;
}
