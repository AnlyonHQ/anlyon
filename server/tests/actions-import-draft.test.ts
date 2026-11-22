import { describe, expect, it } from "vitest";
import { draftOperations } from "../src/core/actions/import-translate.ts";

const spec = {
  openapi: "3.0.3",
  info: { title: "Notes", version: "1" },
  servers: [{ url: "https://api.notes.example/v1" }],
  paths: {
    "/notes": {
      get: { operationId: "listNotes", summary: "List notes", parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }], responses: { 200: { description: "ok" } } },
      post: {
        operationId: "createNote",
        summary: "Create a note",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } } } },
        responses: { 201: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } } } } } },
      },
    },
    "/notes/{id}": {
      get: {
        operationId: "getNote",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } } } } } },
      },
      delete: { operationId: "deleteNote", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 204: { description: "ok" } } },
    },
    "/files": { post: { operationId: "upload", requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } }, responses: { 200: { description: "ok" } } } },
  },
};

describe("draftOperations", () => {
  it("translates the named operations in the allow-list's order, by operationId or METHOD /path", () => {
    const draft = draftOperations(spec, { only: ["deleteNote", "POST /notes", "listNotes"], governed: true });
    expect(draft.baseUrl).toBe("https://api.notes.example/v1");
    expect(draft.operations.map((o) => `${o.method} ${o.path}`)).toEqual(["DELETE /notes/{id}", "POST /notes", "GET /notes"]);

    const [remove, create, list] = draft.operations;
    expect(list!.built.governed).toBe(false);
    expect(list!.built.input.urlTemplate).toBe("https://api.notes.example/v1/notes?cursor={{input.cursor}}");
    expect(create!.built.impact).toEqual({ dimension: "resource_mutations", amount: "1", bound: "exact" });
    expect(create!.built.proposedVerify).toEqual({ url: "https://api.notes.example/v1/notes/{{response.id}}", status: 200, match: [{ path: "title", equals: "{{input.title}}" }] });
    expect(remove!.built.suggestion).toMatchObject({ risk: "destructive", requiresApproval: true });
    expect(remove!.built.proposedVerify).toBeNull();
  });

  it("reports what it cannot express and what the spec does not have, and creates nothing", () => {
    const draft = draftOperations(spec, { only: ["upload", "nope", "getNote"] });
    expect(draft.operations.map((o) => o.key)).toEqual(["getNote"]);
    expect(draft.skipped).toEqual([{ key: "upload", reason: expect.stringMatching(/multipart\/form-data/) }]);
    expect(draft.notFound).toEqual(["nope"]);
  });

  it("refuses a spec that is not OpenAPI 3, or has no https base URL", () => {
    expect(() => draftOperations({ swagger: "2.0" }, { only: [] })).toThrow(/OpenAPI 3/);
    expect(() => draftOperations({ ...spec, servers: [{ url: "http://api.notes.example" }] }, { only: [] })).toThrow(/https/);
    expect(draftOperations({ ...spec, servers: [] }, { only: ["getNote"], baseUrl: "https://eu.notes.example" }).operations[0]!.built.input.urlTemplate)
      .toBe("https://eu.notes.example/notes/{{input.id}}");
  });
});
