type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CURRENCY_NAME = /^currency(_?code)?$/i;
const RECIPIENT_NAME = /^(to|recipients?)$/i;
const CODE_NAME = /^(sql|statement|command|cmd|script|code|javascript|shell)$/i;
const MAX_DEPTH = 2;

export interface MoneyField {
  path: string;
  hasCurrency: boolean;
}

export interface RecipientField {
  path: string;
}

function properties(schema: Json): Json {
  return isObject(schema.properties) ? schema.properties : {};
}

export function findMoney(schema: unknown, prefix = "", depth = 0): MoneyField | null {
  if (!isObject(schema)) return null;
  const props = properties(schema);
  const names = Object.keys(props);
  const currencyName = names.find((name) => CURRENCY_NAME.test(name));
  const amountName = names.find((name) => name.toLowerCase() === "amount" && isObject(props[name]));
  if (amountName) {
    return { path: `${prefix}${amountName}`, hasCurrency: currencyName !== undefined && isObject(props[currencyName]) };
  }
  if (depth >= MAX_DEPTH) return null;
  for (const name of names) {
    const sub = props[name];
    if (isObject(sub) && sub.type === "object") {
      const found = findMoney(sub, `${prefix}${name}.`, depth + 1);
      if (found && found.hasCurrency) return found;
    }
  }
  return null;
}

export function findRecipients(schema: unknown, prefix = "", depth = 0): RecipientField | null {
  if (!isObject(schema)) return null;
  const props = properties(schema);
  const names = Object.keys(props);
  const primary = names.find((name) => RECIPIENT_NAME.test(name));
  if (primary && isObject(props[primary])) return { path: `${prefix}${primary}` };
  if (depth >= MAX_DEPTH) return null;
  for (const name of names) {
    const sub = props[name];
    if (isObject(sub) && sub.type === "object") {
      const found = findRecipients(sub, `${prefix}${name}.`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function findCodeInput(schema: unknown): string | null {
  if (!isObject(schema)) return null;
  const props = properties(schema);
  for (const [name, sub] of Object.entries(props)) {
    if (CODE_NAME.test(name) && isObject(sub) && (sub.type === "string" || sub.type === undefined)) return name;
  }
  return null;
}
