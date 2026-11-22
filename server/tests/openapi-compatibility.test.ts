import { describe, expect, it } from "vitest";
import { classifyChanges, findBreakingChanges, schemaPaths, unreleasedOperations } from "../scripts/openapi-compatibility.ts";

function api(requestRequired = false, responseType = "string") {
  return { security: [{ BearerAuth: [] }], paths: { "/api/v2/example": { post: {
    operationId: "createExample", "x-anlyon-audience": "public", "x-anlyon-scopes": ["example:write"],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: requestRequired ? ["name", "mode"] : ["name"], properties: { name: { type: "string" }, mode: { type: "string" } } } } } },
    responses: { "200": { content: { "application/json": { schema: { type: "object", required: ["success", "data"], properties: { success: { type: "boolean" }, data: { type: responseType } } } } } } },
  } } } };
}

describe("OpenAPI compatibility", () => {
  it("accepts an unchanged or additive contract", () => expect(findBreakingChanges(api(), api())).toEqual([]));
  it("detects newly required request fields", () => expect(findBreakingChanges(api(false), api(true)).some((change) => change.message.includes("became required"))).toBe(true));
  it("detects response type changes", () => expect(findBreakingChanges(api(), api(false, "number")).some((change) => change.message.includes("type changed"))).toBe(true));
  it("detects removed operations", () => expect(findBreakingChanges(api(), { paths: {} })[0]?.message).toBe("operation was removed"));
});

describe("acknowledgements against two bases", () => {
  const change = { operationId: "listThings", path: "GET /things response 200.kind", message: "enum compatibility changed" };
  const other = { operationId: "getThing", path: "GET /things/{id} response 200.kind", message: "type changed from string to number" };
  const ack = { operationId: change.operationId, path: change.path, message: "enum compatibility changed", reason: "widened on purpose", disclosedOn: "2026-10-03" };

  it("an entry that still describes a change against the release base is not stale, though the PR base already has it", () => {
    expect(classifyChanges([], [change], [ack])).toEqual({ acknowledged: [], changes: [], stale: [], unreleased: [] });
  });

  it("an entry that matches nothing against the release base is stale", () => {
    expect(classifyChanges([], [], [ack]).stale).toEqual([ack]);
  });

  it("a new breaking change in the PR still needs its own entry", () => {
    const result = classifyChanges([other], [change, other], [ack]);
    expect(result.changes).toEqual([other]);
    expect(result.stale).toEqual([]);
  });

  it("a change to an operation the release base does not have is reported, not breaking, and needs no entry", () => {
    const result = classifyChanges([change, other], [], [], new Set(["listThings"]));
    expect(result.unreleased).toEqual([change]);
    expect(result.changes).toEqual([other]);
    expect(result.stale).toEqual([]);
  });

  it("finds the operations the release base does not have, by route", () => {
    const added = api();
    (added.paths as Record<string, unknown>)["/api/v2/new"] = { get: { operationId: "getNew", responses: {} } };
    expect([...unreleasedOperations(api(), added)]).toEqual(["getNew"]);
    expect([...unreleasedOperations(api(), api())]).toEqual([]);
  });

  it("a change at a field the release base does not have is reported, not breaking; a released field is still judged", () => {
    const released = { paths: { "/things": { get: { operationId: "listThings", responses: { "200": { content: { "application/json": { schema: {
      type: "object", properties: { data: { type: "object", properties: { kind: { type: "string" } } } },
    } } } } } } } } };
    const paths = schemaPaths(released);
    const unreleasedField = { operationId: "listThings", path: "GET /things response 200.data.plans[].seats", message: "response may now be null" };
    const releasedField = { operationId: "listThings", path: "GET /things response 200.data.kind", message: "response may now be null" };
    const result = classifyChanges([unreleasedField, releasedField], [], [], new Set(), paths);
    expect(result.unreleased).toEqual([unreleasedField]);
    expect(result.changes).toEqual([releasedField]);
  });

  it("names every path findBreakingChanges can report, through refs and cycles", () => {
    const spec = { components: { schemas: { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" }, tags: { type: "array", items: { type: "string" } } } } } },
      paths: { "/n": { get: { operationId: "getNode", parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } } } };
    const paths = schemaPaths(spec);
    for (const path of ["GET /n", "GET /n parameter query:q", "GET /n requestBody", "GET /n response 200", "GET /n response 200.child", "GET /n response 200.tags[]"]) {
      expect(paths.has(path)).toBe(true);
    }
    expect(paths.has("GET /n response 200.child.child")).toBe(false);
    const changes = findBreakingChanges(api(), api(false, "number"));
    for (const change of changes) expect(schemaPaths(api()).has(change.path)).toBe(true);
  });

  it("with one base for both, it behaves as before", () => {
    expect(classifyChanges([change], [change], [ack])).toEqual({ acknowledged: [change], changes: [], stale: [], unreleased: [] });
    expect(classifyChanges([change], [change], []).changes).toEqual([change]);
  });
});
