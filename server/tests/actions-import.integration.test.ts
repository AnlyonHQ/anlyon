import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
vi.mock("../src/api/governance-gate.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), signOffIfLoosening: async () => null }));

const spec = {
  openapi: "3.0.3",
  info: { title: "Pets", version: "1.0.0" },
  servers: [{ url: "https://api.hubapi.com/pets-fixture/v1" }],
  paths: {
    "/pets": {
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
      post: {
        operationId: "createPet",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, price: { type: "integer" } } } } } },
        responses: { "201": { description: "created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } },
      },
    },
    "/pets/{petId}": {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "getPet", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } } },
    },
  },
};

describe.runIf(process.env.ANLYON_TEST_TARGETS === "ok")("governed OpenAPI import (real stack, HTTP)", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let userId: string;
  let workspaceId: string;
  let key: string;

  beforeAll(async () => {
    app = (await import("../src/api/index.ts")).default as typeof app;
    const keys = await import("../src/core/auth/api-keys.ts");
    const envs = await import("../src/core/environments/service.ts");
    userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'T', $2, false, now(), now())`,
      [userId, `${userId}@test.dev`]);
    workspaceId = (await pool.query(`INSERT INTO workspaces (name, slug, plan) VALUES ('I', $1, 'enterprise') RETURNING id`,
      [`ws-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const environment = await envs.ensureDefaultEnvironment(workspaceId);
    key = (await keys.createApiKey(workspaceId, userId, "import", undefined, ["actions:read", "actions:write", "actions:govern"] as never, environment.id)).key;
  }, 60_000);

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await pool.end();
  });

  const call = (path: string, init: { method?: string; body?: unknown } = {}) => app.request(path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  it("a dry run reports the governance of each operation and creates nothing", async () => {
    const res = await call("/api/v2/actions/import", { method: "POST", body: { spec, dryRun: true } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.skipped).toEqual([]);
    const byName = Object.fromEntries(data.created.map((a: { name: string }) => [a.name, a]));
    expect(byName.listPets).toMatchObject({ governed: false, impact: null, proposedVerify: null });
    expect(byName.createPet).toMatchObject({
      governed: true,
      impact: { dimension: "resource_mutations", amount: "1", bound: "exact" },
      proposedVerify: { url: "https://api.hubapi.com/pets-fixture/v1/pets/{{response.id}}", status: 200, match: [{ path: "name", equals: "{{input.name}}" }] },
    });
    expect((await pool.query("SELECT count(*)::int AS n FROM actions WHERE workspace_id = $1", [workspaceId])).rows[0].n).toBe(0);
  });

  it("imports a write governed with one resource mutation and no verify rule, and a read as a plain action", async () => {
    const res = await call("/api/v2/actions/import", { method: "POST", body: { spec } });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.skipped).toEqual([]);
    expect(data.created.map((a: { name: string }) => a.name).sort()).toEqual(["createPet", "getPet", "listPets"]);

    const write = (await (await call("/api/v2/actions/createPet")).json()).data;
    expect(write).toMatchObject({ governed: true, impact: { dimension: "resource_mutations", amount: "1", bound: "exact" }, verify: null });
    const read = (await (await call("/api/v2/actions/getPet")).json()).data;
    expect(read).toMatchObject({ governed: false, impact: null, verify: null });
  });

  it("the proposed read-back is accepted when a person adds it", async () => {
    const proposed = (await (await call("/api/v2/actions/import", { method: "POST", body: { spec, dryRun: true, only: ["createPet"] } })).json()).data.created[0].proposedVerify;
    const patched = await call("/api/v2/actions/createPet", { method: "PATCH", body: { verify: proposed } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.verify).toEqual(proposed);
  });

  it("governed: false imports the write as a plain action", async () => {
    const res = await call("/api/v2/actions/import", {
      method: "POST",
      body: { spec: { ...spec, paths: { "/cats": { post: { operationId: "createCat", requestBody: spec.paths["/pets"].post.requestBody } } } }, governed: false },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.created[0]).toMatchObject({ governed: false, impact: null });
    expect((await (await call("/api/v2/actions/createCat")).json()).data).toMatchObject({ governed: false, impact: null });
  });
});
