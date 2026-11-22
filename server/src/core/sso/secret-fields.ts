import { env } from "../../config/env.ts";
import { decryptSecret, encryptSecret } from "../../utils/crypto.ts";

const MARKER = "enc:";
const MODEL = "ssoProvider";

const SECRET_PATHS = {
  oidcConfig: [["clientSecret"]],
  samlConfig: [
    ["privateKey"],
    ["privateKeyPass"],
    ["decryptionPvk"],
    ["spMetadata", "privateKey"],
    ["spMetadata", "privateKeyPass"],
    ["spMetadata", "encPrivateKey"],
    ["spMetadata", "encPrivateKeyPass"],
    ["idpMetadata", "privateKey"],
    ["idpMetadata", "privateKeyPass"],
    ["idpMetadata", "encPrivateKey"],
    ["idpMetadata", "encPrivateKeyPass"],
  ],
} as const;

type Column = keyof typeof SECRET_PATHS;
const COLUMNS = Object.keys(SECRET_PATHS) as Column[];

const context = (providerId: string, column: Column, path: readonly string[]) => ({
  store: "sso-provider" as const,
  name: `${providerId}:${column}.${path.join(".")}`,
});

function transformColumn(
  json: unknown,
  providerId: string,
  column: Column,
  fn: (value: string, ctx: ReturnType<typeof context>) => string,
): unknown {
  if (typeof json !== "string" || !json) return json;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  for (const path of SECRET_PATHS[column]) {
    let holder: Record<string, unknown> | undefined = parsed;
    for (const key of path.slice(0, -1)) {
      const next: unknown = holder?.[key];
      holder = next && typeof next === "object" ? (next as Record<string, unknown>) : undefined;
    }
    const leaf = path[path.length - 1];
    const value = holder?.[leaf];
    if (holder && typeof value === "string" && value) holder[leaf] = fn(value, context(providerId, column, path));
  }
  return JSON.stringify(parsed);
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(MARKER);
}

export function encryptConfig(json: unknown, providerId: string, column: Column): unknown {
  return transformColumn(json, providerId, column, (value, ctx) =>
    isEncryptedValue(value) ? value : `${MARKER}${encryptSecret(value, env.DELIVERY_SECRET_MASTER_KEY, ctx)}`,
  );
}

export function decryptConfig(json: unknown, providerId: string, column: Column): unknown {
  return transformColumn(json, providerId, column, (value, ctx) =>
    isEncryptedValue(value) ? decryptSecret(value.slice(MARKER.length), env.DELIVERY_SECRET_MASTER_KEY, ctx) : value,
  );
}

export function hasPlaintextSecret(json: unknown, column: Column): boolean {
  let found = false;
  transformColumn(json, "-", column, (value) => {
    if (!isEncryptedValue(value)) found = true;
    return value;
  });
  return found;
}

type Row = Record<string, unknown>;
type Where = { field: string; value: unknown; operator?: string };

function providerIdFrom(where: Where[]): string | undefined {
  const clause = where.find((w) => w.field === "providerId" && (!w.operator || w.operator === "eq"));
  return typeof clause?.value === "string" ? clause.value : undefined;
}

function encryptRow(data: Row, providerId: string | undefined): Row {
  const touches = COLUMNS.some((column) => typeof data[column] === "string" && data[column]);
  if (!touches) return data;
  if (!providerId) throw new Error("SSO provider secrets can only be written with a providerId");
  const out = { ...data };
  for (const column of COLUMNS) out[column] = encryptConfig(out[column], providerId, column);
  return out;
}

function decryptRow<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const record = row as Row;
  const touches = COLUMNS.some((column) => typeof record[column] === "string" && record[column]);
  if (!touches) return row;
  const providerId = record.providerId;
  if (typeof providerId !== "string") throw new Error("SSO provider secrets can only be read with providerId selected");
  const out = { ...record };
  for (const column of COLUMNS) out[column] = decryptConfig(out[column], providerId, column);
  return out as T;
}

interface AdapterLike {
  create: (input: { model: string; data: Row; [key: string]: unknown }) => Promise<unknown>;
  findOne: (input: { model: string; [key: string]: unknown }) => Promise<unknown>;
  findMany: (input: { model: string; [key: string]: unknown }) => Promise<unknown[]>;
  update: (input: { model: string; where: Where[]; update: Row }) => Promise<unknown>;
  updateMany: (input: { model: string; where: Where[]; update: Row }) => Promise<number>;
  consumeOne?: (input: { model: string; where: Where[] }) => Promise<unknown>;
  transaction?: <R>(callback: (trx: never) => Promise<R>) => Promise<R>;
}

export function wrapAdapter<A>(adapter: A): A {
  const base = adapter as unknown as AdapterLike;
  const wrapped: AdapterLike = {
    ...base,
    create: async (input) =>
      decryptRow(
        await base.create(
          input.model === MODEL
            ? { ...input, data: encryptRow(input.data, input.data.providerId as string | undefined) }
            : input,
        ),
      ),
    findOne: async (input) => {
      const row = await base.findOne(input);
      return input.model === MODEL ? decryptRow(row) : row;
    },
    findMany: async (input) => {
      const rows = await base.findMany(input);
      return input.model === MODEL ? rows.map(decryptRow) : rows;
    },
    update: async (input) => {
      if (input.model !== MODEL) return base.update(input);
      const updated = await base.update({ ...input, update: encryptRow(input.update, providerIdFrom(input.where)) });
      return decryptRow(updated);
    },
    updateMany: async (input) =>
      base.updateMany(
        input.model === MODEL ? { ...input, update: encryptRow(input.update, providerIdFrom(input.where)) } : input,
      ),
  };
  if (base.consumeOne) {
    const consumeOne = base.consumeOne;
    wrapped.consumeOne = async (input) => {
      const row = await consumeOne(input);
      return input.model === MODEL ? decryptRow(row) : row;
    };
  }
  if (base.transaction) {
    const transaction = base.transaction;
    wrapped.transaction = <R>(callback: (trx: never) => Promise<R>) =>
      transaction((trx: never) => callback(wrapAdapter(trx)));
  }
  return wrapped as unknown as A;
}

export function withSsoSecretEncryption<O, A>(factory: (options: O) => A): (options: O) => A {
  return (options: O) => wrapAdapter(factory(options));
}
