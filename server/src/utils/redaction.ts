export const REDACTED = "[REDACTED]";
const MIN_REDACTED_LENGTH = 4;
const MIN_CUT_TAIL = 256;
const MIN_EMBEDDED_BASE64 = 12;

function embeddedBase64Forms(bytes: Buffer): string[] {
  const forms: string[] = [];
  for (const alphabet of ["base64", "base64url"] as const) {
    for (let offset = 0; offset < 3; offset++) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(alphabet).replace(/=+$/, "");
      const head = offset === 0 ? 0 : offset + 1;
      const tail = (offset + bytes.length) % 3 === 0 ? 0 : 1;
      const stable = encoded.slice(head, encoded.length - tail);
      if (stable.length >= MIN_EMBEDDED_BASE64) forms.push(stable);
    }
  }
  return forms;
}

export function secretForms(value: string): string[] {
  if (value.length < MIN_REDACTED_LENGTH) return [];
  const forms = new Set<string>([value]);
  forms.add(encodeURIComponent(value));
  forms.add(JSON.stringify(value).slice(1, -1));
  const bytes = Buffer.from(value, "utf8");
  forms.add(bytes.toString("base64"));
  forms.add(bytes.toString("base64url"));
  for (const form of embeddedBase64Forms(bytes)) forms.add(form);
  return [...forms].filter((form) => form.length >= MIN_REDACTED_LENGTH).sort((a, b) => b.length - a.length);
}

function allForms(secrets: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) for (const form of secretForms(secret)) forms.add(form);
  return [...forms].sort((a, b) => b.length - a.length);
}

export function redactValues(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const form of allForms(secrets)) out = out.split(form).join(REDACTED);
  return out;
}

export function redactCutTail(text: string, secrets: Iterable<string>): string {
  const list = [...secrets];
  const longest = allForms(list)[0]?.length ?? 0;
  if (longest === 0) return text;
  const whole = redactValues(text, list);
  const drop = Math.max(MIN_CUT_TAIL, longest - 1);
  return `${whole.slice(0, Math.max(0, whole.length - drop))}${REDACTED}`;
}
