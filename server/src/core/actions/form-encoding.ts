const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export function wantsFormBody(headers: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") continue;
    return value.split(";")[0].trim().toLowerCase() === FORM_CONTENT_TYPE;
  }
  return false;
}

export function encodeFormBody(payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) appendField(params, key, value);
  return params.toString();
}

function appendField(params: URLSearchParams, key: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendField(params, `${key}[${index}]`, item));
    return;
  }
  if (typeof value === "object") {
    for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) {
      appendField(params, `${key}[${child}]`, childValue);
    }
    return;
  }
  params.append(key, String(value));
}
