import { describe, it, expect } from "vitest";
import { effectiveDefinition } from "../src/core/actions/execute.ts";

function action(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    environmentId: "env_1",
    actionId: "act_1",
    name: "refund",
    method: "POST",
    urlTemplate: "https://api.example.com/refund",
    headers: { "X-Env": "prod" },
    bodyTemplate: { amount: "{{input.amount}}" },
    ...over,
  } as never;
}

function invocation(over: Record<string, unknown> = {}) {
  return { id: "uuid-1", invocationId: "inv_1", input: {}, definitionSnapshot: null, ...over } as never;
}

const SNAPSHOT = {
  method: "POST",
  urlTemplate: "https://api.example.com/refund",
  headers: { "X-Env": "prod" },
  bodyTemplate: { amount: "{{input.amount}}" },
};

describe("a snapshot pins the request", () => {
  it("ignores a urlTemplate edited after the request  the TOCTOU this closes", () => {
    const edited = action({ urlTemplate: "https://attacker.example/collect" });

    const definition = effectiveDefinition(edited, invocation({ definitionSnapshot: SNAPSHOT }));

    expect(definition.urlTemplate).toBe("https://api.example.com/refund");
  });

  it("ignores an edited method, so a GET cannot become a DELETE", () => {
    const edited = action({ method: "DELETE" });

    expect(effectiveDefinition(edited, invocation({ definitionSnapshot: SNAPSHOT })).method).toBe(
      "POST"
    );
  });

  it("ignores edited headers, which could redirect a credential", () => {
    const edited = action({ headers: { Authorization: "Bearer {{secret:STRIPE_KEY}}" } });

    expect(effectiveDefinition(edited, invocation({ definitionSnapshot: SNAPSHOT })).headers).toEqual(
      { "X-Env": "prod" }
    );
  });

  it("ignores an edited body template", () => {
    const edited = action({ bodyTemplate: { amount: 999999 } });

    expect(
      effectiveDefinition(edited, invocation({ definitionSnapshot: SNAPSHOT })).bodyTemplate
    ).toEqual({ amount: "{{input.amount}}" });
  });

  it("keeps a null body template from the snapshot rather than inheriting one", () => {
    const definition = effectiveDefinition(
      action(),
      invocation({ definitionSnapshot: { ...SNAPSHOT, bodyTemplate: null } })
    );

    expect(definition.bodyTemplate).toBeNull();
  });
});

describe("falling back to the live action", () => {
  it("uses the action when there is no snapshot (rows predating the column)", () => {
    const definition = effectiveDefinition(action(), invocation());

    expect(definition).toMatchObject({
      method: "POST",
      urlTemplate: "https://api.example.com/refund",
    });
  });

  it("uses the action when the snapshot is malformed rather than sending nothing", () => {
    const definition = effectiveDefinition(action(), invocation({ definitionSnapshot: { junk: 1 } }));

    expect(definition.urlTemplate).toBe("https://api.example.com/refund");
  });
});
