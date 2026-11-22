import { describe, it, expect, vi, beforeEach } from "vitest";

const createAction = vi.fn();
const countActions = vi.fn();
const getSecretMetadata = vi.fn();
const selectWorkspace = vi.fn();

vi.mock("../src/core/actions/service.ts", () => ({
  createAction: (...args: unknown[]) => createAction(...args),
  countActions: (...args: unknown[]) => countActions(...args),
  UNSCOPED_AUTHORITY: { scopes: null },
}));

vi.mock("../src/core/actions/secrets.ts", () => ({
  getSecretMetadata: (...args: unknown[]) => getSecretMetadata(...args),
}));

vi.mock("../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectWorkspace() }) }),
  },
}));

vi.mock("../src/lib/logger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/logger.ts")>()),
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { importActionsFromOpenApi } = await import("../src/core/actions/import.ts");
const { usePlanFixture } = await import("./support/plan-fixture.ts");
usePlanFixture({ free: { maxActions: 1_000 } });

function spec(paths: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    openapi: "3.0.3",
    info: { title: "Pets", version: "1.0.0" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths,
    ...extra,
  };
}

function createdInput(call = 0) {
  return createAction.mock.calls[call][1];
}

beforeEach(() => {
  createAction.mockReset();
  countActions.mockReset();
  getSecretMetadata.mockReset();
  selectWorkspace.mockReset();

  createAction.mockImplementation(async (_ws: string, input: Record<string, unknown>) => ({
    ...input,
    id: "act_1",
  }));
  countActions.mockResolvedValue(0);
  getSecretMetadata.mockResolvedValue({ name: "API_TOKEN" });
  selectWorkspace.mockResolvedValue([{ id: "ws_1", plan: "paygo" }]);
});

describe("happy path", () => {
  it("turns a path+query+body operation into one action", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets/{petId}": {
          post: {
            operationId: "updatePet",
            summary: "Update a pet",
            parameters: [
              { name: "petId", in: "path", required: true, schema: { type: "string" } },
              { name: "dryRun", in: "query", schema: { type: "boolean" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" }, age: { type: "integer" } },
                    required: ["name"],
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].name).toBe("updatePet");

    const input = createdInput();
    expect(input.method).toBe("POST");
    expect(input.urlTemplate).toBe(
      "https://api.example.com/v1/pets/{{input.petId}}?dryRun={{input.dryRun}}"
    );
    expect(input.description).toBe("Update a pet");

    expect(input.bodyTemplate).toEqual({ name: "{{input.name}}", age: "{{input.age}}" });
    expect(input.inputSchema).toEqual({
      type: "object",
      properties: {
        petId: { type: "string" },
        dryRun: { type: "boolean" },
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["petId", "name"],
    });
  });

  it("names an operation without an operationId after its method and path", async () => {
    await importActionsFromOpenApi(
      "ws_1",
      spec({ "/pets/{petId}/photos": { get: { parameters: [] } } })
    );

    expect(createdInput().name).toBe("get_pets-petId-photos");
  });

  it("prefers an explicit baseUrl over the spec's server", async () => {
    await importActionsFromOpenApi("ws_1", spec({ "/pets": { get: {} } }), {
      baseUrl: "https://staging.example.com",
    });

    expect(createdInput().urlTemplate).toBe("https://staging.example.com/pets");
  });

  it("adds the auth header to every action and checks the secret exists first", async () => {
    await importActionsFromOpenApi("ws_1", spec({ "/pets": { get: {}, post: {} } }), {
      auth: {
        headerName: "Authorization",
        secretName: "API_TOKEN",
        valueTemplate: "Bearer {{secret}}",
      },
    });

    expect(getSecretMetadata).toHaveBeenCalledWith("ws_1", "API_TOKEN");
    expect(createdInput(0).headers).toEqual({ Authorization: "Bearer {{secret:API_TOKEN}}" });
    expect(createdInput(1).headers).toEqual({ Authorization: "Bearer {{secret:API_TOKEN}}" });
  });

  it("gates every imported action when asked", async () => {
    await importActionsFromOpenApi("ws_1", spec({ "/pets": { delete: {} } }), {
      requiresApproval: true,
    });

    expect(createdInput().requiresApproval).toBe(true);
  });
});

describe("$ref resolution", () => {
  it("inlines a local component schema", async () => {
    await importActionsFromOpenApi(
      "ws_1",
      spec(
        {
          "/pets": {
            post: {
              operationId: "createPet",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pet" },
                  },
                },
              },
            },
          },
        },
        {
          components: {
            schemas: {
              Pet: {
                type: "object",
                properties: { name: { type: "string" }, tag: { $ref: "#/components/schemas/Tag" } },
                required: ["name"],
              },
              Tag: { type: "object", properties: { label: { type: "string" } } },
            },
          },
        }
      )
    );

    const schema = createdInput().inputSchema as Record<string, any>;
    expect(schema.properties.name).toEqual({ type: "string" });
    expect(schema.properties.tag).toEqual({
      type: "object",
      properties: { label: { type: "string" } },
    });
  });

  it("skips an operation whose $ref does not resolve", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } },
            },
          },
        },
      })
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0].reason).toContain("does not resolve");
    expect(createAction).not.toHaveBeenCalled();
  });
});

describe("the subset boundary", () => {
  it("drops documentation-only constraints and reports them as warnings", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      age: { type: "integer", format: "int64", minimum: 0 },
                      name: { type: "string", maxLength: 40 },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(result.created).toHaveLength(1);
    expect(result.created[0].warnings).toEqual([expect.stringContaining('dropped "format"')]);

    expect(createdInput().inputSchema).toEqual({
      type: "object",
      properties: { age: { type: "integer", minimum: 0 }, name: { type: "string", maxLength: 40 } },
    });
  });

  it("turns OpenAPI 3.0's boolean exclusive bounds into the numeric form", async () => {
    await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      weight: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 100, exclusiveMaximum: false },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(createdInput().inputSchema).toEqual({
      type: "object",
      properties: { weight: { type: "number", exclusiveMinimum: 0, maximum: 100 } },
    });
  });

  it("drops a pattern that could backtrack catastrophically and keeps a safe one", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      tag: { type: "string", pattern: "^(a+)+$" },
                      code: { type: "string", pattern: "^[A-Z]{3}$" },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(result.created).toHaveLength(1);
    expect(result.created[0].warnings).toEqual([expect.stringContaining('dropped "pattern"')]);
    expect(createdInput().inputSchema).toEqual({
      type: "object",
      properties: { tag: { type: "string" }, code: { type: "string", pattern: "^[A-Z]{3}$" } },
    });
  });

  it("skips an operation whose schema needs oneOf", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      pet: { oneOf: [{ type: "string" }, { type: "integer" }] },
                    },
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      { path: "/pets", method: "POST", reason: expect.stringContaining("oneOf") },
    ]);
  });

  it("skips a type union", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          get: {
            parameters: [{ name: "id", in: "query", schema: { type: ["string", "null"] } }],
          },
        },
      })
    );

    expect(result.skipped[0].reason).toContain("type unions are not supported");
  });

  it("skips a body that is not JSON", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/upload": {
          post: {
            requestBody: {
              content: { "multipart/form-data": { schema: { type: "object" } } },
            },
          },
        },
      })
    );

    expect(result.skipped[0].reason).toContain("not application/json");
  });

  it("imports a form-encoded body and declares the form Content-Type so the executor encodes it", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/refunds": {
          post: {
            operationId: "createRefund",
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: { charge: { type: "string" }, amount: { type: "integer" } },
                    required: ["charge"],
                  },
                },
              },
            },
          },
        },
      })
    );

    expect(result.skipped).toEqual([]);
    const input = createdInput();
    expect(input.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(input.bodyTemplate).toEqual({ charge: "{{input.charge}}", amount: "{{input.amount}}" });
    expect(input.inputSchema.required).toEqual(["charge"]);
  });

  it("skips a form body whose nested field uses OpenAPI's default (repeated-key) serialization", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          post: {
            operationId: "tagPets",
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
                },
              },
            },
          },
        },
      })
    );

    expect(createAction).not.toHaveBeenCalled();
    expect(result.skipped[0].reason).toContain('form field "tags"');
  });

  it("imports a nested form field declared as deepObject, which matches bracket notation", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/refunds": {
          post: {
            operationId: "createRefund",
            requestBody: {
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: {
                      charge: { type: "string" },
                      metadata: { type: "object", properties: { order: { type: "string" } } },
                    },
                  },
                  encoding: { metadata: { style: "deepObject", explode: true } },
                },
              },
            },
          },
        },
      })
    );

    expect(result.skipped).toEqual([]);
    expect(createdInput().headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("keeps a header parameter out of the agent's inputs and says so", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          get: {
            operationId: "listPets",
            parameters: [
              { name: "X-Tenant", in: "header", schema: { type: "string" } },
              { name: "limit", in: "query", schema: { type: "integer" } },
            ],
          },
        },
      })
    );

    expect(result.created[0].warnings[0]).toContain("X-Tenant");
    expect(createdInput().inputSchema).toEqual({
      type: "object",
      properties: { limit: { type: "integer" } },
    });
  });

  it("skips a body field that would collide with a path parameter", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets/{id}": {
          put: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
        },
      })
    );

    expect(result.skipped[0].reason).toContain("collides");
  });

  it("imports the operations it can and skips the ones it can't, in one pass", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/pets": {
          get: { operationId: "listPets" },
          post: {
            operationId: "createPet",
            requestBody: {
              content: {
                "application/json": { schema: { type: "object", properties: { x: { allOf: [] } } } },
              },
            },
          },
        },
      })
    );

    expect(result.created.map((c) => c.name)).toEqual(["listPets"]);
    expect(result.skipped).toHaveLength(1);
    expect(createAction).toHaveBeenCalledTimes(1);
  });
});

describe("dry run", () => {
  it("reports what would be imported without creating anything", async () => {
    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({ "/pets": { get: { operationId: "listPets" } } }),
      { dryRun: true }
    );

    expect(result.dryRun).toBe(true);
    expect(result.created).toEqual([
      {
        name: "listPets",
        method: "GET",
        path: "/pets",
        urlTemplate: "https://api.example.com/v1/pets",
        warnings: [],
        governed: false,
        impact: null,
        requiresApproval: false,
        customized: false,
        suggestion: {
          risk: "read",
          reasons: ["GET reads and changes nothing."],
          requiresApproval: false,
          impact: null,
          impactNote: null,
        },
        proposedVerify: null,
        verifyNote: null,
      },
    ]);
    expect(result.suggestedAllowedHosts).toEqual(["api.example.com"]);
    expect(createAction).not.toHaveBeenCalled();
  });
});

describe("governed import", () => {
  const ONE_MUTATION = { dimension: "resource_mutations", amount: "1", bound: "exact" };
  const jsonBody = (properties: Record<string, unknown>, required: string[] = []) => ({
    required: true,
    content: { "application/json": { schema: { type: "object", properties, ...(required.length ? { required } : {}) } } },
  });
  const returns = (properties: Record<string, unknown>) => ({
    "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties } } } },
  });
  const petId = { name: "petId", in: "path", required: true, schema: { type: "string" } };

  it("imports every write with one exact resource mutation, and every read without", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": {
        get: { operationId: "listPets" },
        post: { operationId: "createPet", requestBody: jsonBody({ name: { type: "string" } }) },
      },
      "/pets/{petId}": {
        parameters: [petId],
        put: { operationId: "replacePet", requestBody: jsonBody({ name: { type: "string" } }) },
        patch: { operationId: "updatePet", requestBody: jsonBody({ name: { type: "string" } }) },
        delete: { operationId: "deletePet" },
      },
    }));

    expect(result.skipped).toEqual([]);
    const byName = Object.fromEntries(result.created.map((a) => [a.name, a]));
    expect(byName.listPets).toMatchObject({ governed: false, impact: null, proposedVerify: null, verifyNote: null });
    for (const name of ["createPet", "replacePet", "updatePet", "deletePet"]) {
      expect(byName[name], name).toMatchObject({ governed: true, impact: ONE_MUTATION });
    }
    const inputs = Object.fromEntries(createAction.mock.calls.map((call) => [call[1].name, call[1]]));
    expect(inputs.listPets.impact).toBeUndefined();
    expect(inputs.listPets.governed).toBeUndefined();
    for (const name of ["createPet", "replacePet", "updatePet", "deletePet"]) {
      expect(inputs[name].impact, name).toEqual(ONE_MUTATION);
      expect(inputs[name].verify, name).toBeUndefined();
    }
  });

  it("never infers money, however much a field looks like an amount", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/refunds": {
        post: {
          operationId: "createRefund",
          requestBody: jsonBody({ amount: { type: "integer" }, currency: { type: "string" }, price: { type: "number" }, total_cents: { type: "integer" } }, ["amount", "currency"]),
        },
      },
    }));
    expect(result.created[0].impact).toEqual(ONE_MUTATION);
    expect(createdInput().impact).toEqual(ONE_MUTATION);
    expect(JSON.stringify(createdInput().impact)).not.toMatch(/money|usd|input\./);
    expect(result.created[0].suggestion.impact).toMatchObject({ dimension: "money", amount: "input.amount" });
    expect(createdInput().requiresApproval).toBe(false);
  });

  it("proposes a read-back for a create from the item GET, by the id the response returns, and does not apply it", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: jsonBody({ name: { type: "string" }, tag: { type: "string" }, photo: { type: "object", properties: {} } }),
          responses: returns({ id: { type: "string" }, name: { type: "string" } }),
        },
      },
      "/pets/{petId}": {
        parameters: [petId],
        get: { operationId: "getPet", responses: returns({ id: { type: "string" }, name: { type: "string" }, tag: { type: "string" }, photo: { type: "object" } }) },
      },
    }, {}), { only: ["createPet"] });

    expect(result.created).toHaveLength(1);
    expect(result.created[0].proposedVerify).toEqual({
      url: "https://api.example.com/v1/pets/{{response.id}}",
      status: 200,
      match: [{ path: "name", equals: "{{input.name}}" }, { path: "tag", equals: "{{input.tag}}" }],
    });
    expect(result.created[0].verifyNote).toMatch(/not applied/);
    expect(createdInput().verify).toBeUndefined();
  });

  it("reads the id from a response field named after the path parameter when there is one", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": { post: { operationId: "createPet", requestBody: jsonBody({ name: { type: "string" } }), responses: returns({ petId: { type: "integer" }, id: { type: "string" } }) } },
      "/pets/{petId}": { parameters: [petId], get: { responses: returns({ name: { type: "string" } }) } },
    }), { only: ["createPet"], dryRun: true });
    expect(result.created[0].proposedVerify?.url).toBe("https://api.example.com/v1/pets/{{response.petId}}");
  });

  it("proposes a read-back for an update from the GET on the same path, by its own path input", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/owners/{ownerId}/pets/{petId}": {
        parameters: [{ name: "ownerId", in: "path", required: true, schema: { type: "string" } }, petId],
        get: { responses: returns({ status: { type: "string" } }) },
        patch: { operationId: "updatePet", requestBody: jsonBody({ status: { type: "string", enum: ["available", "sold"] } }) },
      },
    }), { only: ["updatePet"], dryRun: true });
    expect(result.created[0].proposedVerify).toEqual({
      url: "https://api.example.com/v1/owners/{{input.ownerId}}/pets/{{input.petId}}",
      status: 200,
      match: [{ path: "status", equals: "{{input.status}}" }],
    });
  });

  it("proposes nothing, and says why, when the spec has no GET sibling", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": { post: { operationId: "createPet", requestBody: jsonBody({ name: { type: "string" } }), responses: returns({ id: { type: "string" } }) } },
    }), { dryRun: true });
    expect(result.created[0]).toMatchObject({ governed: true, proposedVerify: null });
    expect(result.created[0].verifyNote).toMatch(/no GET that reads back/);
  });

  it("proposes nothing when the write's response returns no id to read it back by", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": { post: { operationId: "createPet", requestBody: jsonBody({ name: { type: "string" } }), responses: { "202": { description: "accepted" } } } },
      "/pets/{petId}": { parameters: [petId], get: { responses: returns({ name: { type: "string" } }) } },
    }), { only: ["createPet"], dryRun: true });
    expect(result.created[0].proposedVerify).toBeNull();
    expect(result.created[0].verifyNote).toMatch(/does not return an id/);
  });

  it("proposes nothing when no field of the request can be matched in the read", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets/{petId}": {
        parameters: [petId],
        get: { responses: returns({ display_name: { type: "string" } }) },
        patch: { operationId: "renamePet", requestBody: jsonBody({ name: { type: "string" } }) },
      },
    }), { only: ["renamePet"], dryRun: true });
    expect(result.created[0].proposedVerify).toBeNull();
    expect(result.created[0].verifyNote).toMatch(/nothing to match/);
  });

  it("proposes nothing for a delete, or when the read needs a query parameter the write does not supply", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets/{petId}": {
        parameters: [petId],
        get: { parameters: [{ name: "version", in: "query", required: true, schema: { type: "string" } }], responses: returns({ name: { type: "string" } }) },
        patch: { operationId: "renamePet", requestBody: jsonBody({ name: { type: "string" } }) },
        delete: { operationId: "deletePet" },
      },
    }), { only: ["renamePet", "deletePet"], dryRun: true });
    const byName = Object.fromEntries(result.created.map((a) => [a.name, a]));
    expect(byName.renamePet.proposedVerify).toBeNull();
    expect(byName.renamePet.verifyNote).toMatch(/query parameter "version"/);
    expect(byName.deletePet.proposedVerify).toBeNull();
    expect(byName.deletePet.verifyNote).toMatch(/nothing to read back/);
  });

  it("a proposed rule is one the executor's own parser accepts for that action", async () => {
    const { parseDeclarations } = await import("../src/core/effects/declarations.ts");
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": { post: { operationId: "createPet", requestBody: jsonBody({ name: { type: "string" } }), responses: returns({ id: { type: "string" } }) } },
      "/pets/{petId}": { parameters: [petId], get: { responses: returns({ name: { type: "string" } }) } },
    }), { only: ["createPet"], dryRun: true });
    const imported = result.created[0];
    expect(() => parseDeclarations({ impact: imported.impact, verify: imported.proposedVerify, governed: true }, imported.urlTemplate)).not.toThrow();
  });

  it("governed: false imports every operation as a plain template action, as before", async () => {
    const result = await importActionsFromOpenApi("ws_1", spec({
      "/pets": { post: { operationId: "createPet", requestBody: jsonBody({ name: { type: "string" } }), responses: returns({ id: { type: "string" } }) } },
      "/pets/{petId}": { parameters: [petId], get: { responses: returns({ name: { type: "string" } }) } },
    }), { only: ["createPet"], governed: false });
    expect(result.created[0]).toMatchObject({ governed: false, impact: null, proposedVerify: null, verifyNote: null });
    expect(createdInput().impact).toBeUndefined();
  });
});

describe("plan limits", () => {
  it("stops at the free plan's action cap and says why", async () => {
    selectWorkspace.mockResolvedValue([{ id: "ws_1", plan: "free" }]);
    countActions.mockResolvedValue(999);

    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({
        "/a": { get: { operationId: "a" } },
        "/b": { get: { operationId: "b" } },
        "/c": { get: { operationId: "c" } },
      })
    );

    expect(result.created.map((c) => c.name)).toEqual(["a"]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain("plan limit reached");
    expect(createAction).toHaveBeenCalledTimes(1);
  });

  it("does not cap a paygo workspace", async () => {
    selectWorkspace.mockResolvedValue([{ id: "ws_1", plan: "paygo" }]);
    countActions.mockResolvedValue(500);

    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({ "/a": { get: { operationId: "a" } }, "/b": { get: { operationId: "b" } } })
    );

    expect(result.created).toHaveLength(2);
  });
});

describe("rejections", () => {
  it("rejects a spec that is not OpenAPI 3.x", async () => {
    await expect(
      importActionsFromOpenApi("ws_1", { swagger: "2.0", paths: {} })
    ).rejects.toThrow(/OpenAPI 3/);
  });

  it("rejects a spec with no server and no baseUrl", async () => {
    await expect(
      importActionsFromOpenApi("ws_1", {
        openapi: "3.0.0",
        paths: { "/pets": { get: {} } },
      })
    ).rejects.toThrow(/baseUrl/);
  });

  it("reports a create failure against the operation it came from", async () => {
    createAction.mockRejectedValueOnce(new Error('An action named "listPets" already exists'));

    const result = await importActionsFromOpenApi(
      "ws_1",
      spec({ "/pets": { get: { operationId: "listPets" } } })
    );

    expect(result.created).toEqual([]);
    expect(result.skipped[0].reason).toContain("already exists");
  });
});
