import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeVerify, parseVerifyDeclaration, resolveVerifyBody, resolveVerifyUrl, verifyMismatches } from "../src/core/effects/declarations.ts";
import { applyAccountHost, extractInputRefs, interpolateObject, interpolateUrl } from "../src/core/actions/template.ts";
import { isReadOnlyGraphqlQuery } from "../src/core/effects/graphql.ts";
import { checkSchemaDefinition, validateAgainstSchema } from "../src/utils/json-schema.ts";
import { CATALOGUE } from "../src/core/connections/catalogue.ts";
import { expandPackRefsSync, preparePackManifest, validatePackManifest } from "../../sdks/typescript/sdk/src/resources/packs-core.ts";

const PACKS = resolve(__dirname, "../../packs");

interface Fixture {
  params: Record<string, string>;
  input: Record<string, unknown>;
  accountHost?: string;
  expectedReadBackBody?: unknown;
  expectedUrl?: string;
  expectedBody?: unknown;
  response?: unknown;
  expectedReadBackUrl: string;
  readBack: { status: number; json: unknown };
  mismatchedReadBack: { status: number; json: unknown };
}

interface Action {
  name: string;
  kind?: "read" | "write";
  description: string;
  method?: string;
  urlTemplate?: string;
  headers?: Record<string, string>;
  bodyTemplate?: Record<string, unknown>;
  inputSchema?: { properties?: Record<string, unknown> };
  verify?: unknown;
  graphql?: true;
  adapter?: unknown;
  ref?: string;
}

interface Exercise {
  needs?: Record<string, string>;
  steps: Array<{ action: string; input?: Record<string, unknown>; save?: Record<string, string> }>;
}

const readJson = <T>(...path: string[]): T => JSON.parse(readFileSync(resolve(PACKS, ...path), "utf8")) as T;

const packs = readdirSync(PACKS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "schema")
  .map((d) => d.name);

const byId = (id: string) => readJson<unknown>(id.split("/")[1]!, "pack.json");

const offered = new Set(CATALOGUE.filter((e) => e.verificationStatus !== "paused").map((e) => e.operationsPack));

describe.each(packs)("pack %s", (pack) => {
  const manifest = readJson<{ actions: Action[] }>(pack, "pack.json");
  const own = manifest.actions.filter((a) => !a.ref);
  const declared = own.filter((a) => a.urlTemplate);
  const verified = declared.filter((a) => a.verify);
  const fixture = (name: string) => {
    const raw = readJson<Fixture>(pack, "fixtures", `${name}.json`);
    return raw;
  };
  const withParams = <T>(value: T, params: Record<string, string>): T =>
    JSON.parse(JSON.stringify(value).replace(/\{\{param:([a-z_]+)\}\}/g, (_, p: string) => params[p] ?? ""));

  it("passes the installer's validation", () => {
    expect(() => validatePackManifest(expandPackRefsSync(readJson(pack, "pack.json"), byId))).not.toThrow();
  });

  it("sends each connected account as {{connection:<integration>}}, and installs bound to a secret too", async () => {
    const raw = readJson<{ secrets: Array<{ name: string; kind: string; integrationId?: string }> }>(pack, "pack.json");
    const text = JSON.stringify(readJson(pack, "pack.json"));
    for (const secret of raw.secrets.filter((s) => s.kind === "connection")) {
      expect(text, `${pack}: ${secret.name}`).not.toContain(`{{secret:${secret.name}}}`);
    }
    const bound = await preparePackManifest(readJson(pack, "pack.json"), { credential: "secret", resolvePack: byId });
    expect(JSON.stringify(bound.actions)).not.toContain("{{connection:");
  });

  it("has a fixture for every action it defines", () => {
    if (own.length === 0) return;
    const files = readdirSync(resolve(PACKS, pack, "fixtures")).map((f) => f.replace(/\.json$/, "")).sort();
    expect(files).toEqual(own.map((a) => a.name).sort());
  });

  it.each(declared.map((a) => [a.name, a]))("%s: its input schema is one the API accepts, names every input it uses, and takes its fixture", (name, action) => {
    const a = action as Action;
    expect(checkSchemaDefinition(a.inputSchema, "inputSchema")).toEqual([]);
    const used = new Set(extractInputRefs(a.urlTemplate, a.headers, a.bodyTemplate, a.verify).map((ref) => ref.split(".")[0]));
    const declaredInputs = Object.keys(a.inputSchema?.properties ?? {});
    expect([...used].filter((ref) => !declaredInputs.includes(ref!))).toEqual([]);
    const result = validateAgainstSchema(a.inputSchema, fixture(name as string).input);
    expect(result.errors).toEqual([]);
  });

  it.each(declared.map((a) => [a.name, a]))("%s: its fixture's input renders the request expected, with no placeholder left", (name, action) => {
    const f = fixture(name as string);
    const { urlTemplate, headers, bodyTemplate } = withParams(action as Action, f.params);
    const url = interpolateUrl(urlTemplate!, f.input, new Map(), f.accountHost ?? null);
    const body = bodyTemplate ? interpolateObject(bodyTemplate, f.input, new Map(), { typed: true, keepSecretRefs: true }) : null;
    const rendered = JSON.stringify({
      url,
      headers: interpolateObject(headers ?? {}, f.input, new Map(), { keepSecretRefs: true }),
      body,
    });
    if (f.expectedBody !== undefined) expect(body, "fixture.expectedBody").toEqual(f.expectedBody);
    expect(rendered).not.toMatch(/\{\{\s*input\./);
    expect(rendered).not.toMatch(/\{\{\s*param:/);
    expect(f.expectedUrl, "fixture.expectedUrl").toBeDefined();
    expect(url).toBe(f.expectedUrl);
  });

  it.each(own.map((a) => [a.name, a]))("%s: a read changes nothing and returns a response; a write with no read-back says why", (name, action) => {
    const a = action as Action;
    if (a.kind === "read") {
      expect(a.method === "GET" || /changes nothing/i.test(a.description), "a POST read says it changes nothing").toBe(true);
      if (a.graphql) expect(isReadOnlyGraphqlQuery(a.bodyTemplate?.query), "a GraphQL read's query is read-only").toBe(true);
      expect(fixture(name as string).response, "fixture.response").toBeDefined();
    } else if (!a.adapter && !a.verify) {
      expect(a.description).toMatch(/No read-back:/);
    }
  });

  it.each(verified.map((a) => [a.name, a]))("%s: the read-back is built and matched as the executor does", (name, action) => {
    const f = fixture(name as string);
    const verify = normalizeVerify(parseVerifyDeclaration(withParams((action as Action).verify, f.params)), f.input);
    const readBackUrl = resolveVerifyUrl(verify, f.response);
    expect(readBackUrl === null ? null : applyAccountHost(readBackUrl, f.accountHost ?? null)).toBe(f.expectedReadBackUrl);
    if (verify.graphql) expect(resolveVerifyBody(verify, f.response), "fixture.expectedReadBackBody").toEqual(f.expectedReadBackBody);
    expect(verifyMismatches(verify, f.readBack, f.response)).toEqual([]);
    expect(verifyMismatches(verify, f.mismatchedReadBack, f.response).length).toBeGreaterThan(0);
  });

  it("has an exercise that reaches every action, in an order that can run, if its integration is offered", () => {
    if (!offered.has(`anlyon/${pack}`)) return;
    expect(existsSync(resolve(PACKS, pack, "exercise.json")), "exercise.json").toBe(true);
    const exercise = readJson<Exercise>(pack, "exercise.json");
    const names = new Set(own.map((a) => a.name));
    const needs = new Set(Object.keys(exercise.needs ?? {}));
    const saved = new Set<string>();
    for (const [i, step] of exercise.steps.entries()) {
      expect(names.has(step.action), `step ${i}: ${step.action} is an action of this pack`).toBe(true);
      const text = JSON.stringify(step.input ?? {});
      for (const m of text.matchAll(/\{\{\s*needs\.([a-z0-9_]+)\s*\}\}/gi)) expect(needs.has(m[1]!), `step ${i}: needs.${m[1]} is declared`).toBe(true);
      for (const m of text.matchAll(/\{\{\s*saved\.([a-z0-9_]+)\s*\}\}/gi)) expect(saved.has(m[1]!), `step ${i}: saved.${m[1]} is saved by an earlier step`).toBe(true);
      for (const key of Object.keys(step.save ?? {})) saved.add(key);
    }
    const reached = new Set(exercise.steps.map((s) => s.action));
    expect([...names].filter((n) => !reached.has(n))).toEqual([]);
  });
});
