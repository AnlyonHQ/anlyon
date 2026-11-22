import { describe, expect, it } from "vitest";
import {
  METHODOLOGY,
  postureChanges,
  postureFacts,
  postureFindings,
  postureTools,
  type RemotePosture,
} from "../src/index.ts";

const base: RemotePosture = {
  version: 1,
  endpoint: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  reachable: true,
  initializeStatus: 200,
  authRequired: false,
  toolsListAnonymous: true,
  protocolVersion: "2025-06-18",
  wwwAuthenticate: null,
  resourceMetadataUrl: null,
  protectedResource: null,
  legacySse: false,
  registration: null,
  anonymousTools: postureTools([
    { tool: "list_issues", class: "read" },
    { tool: "search_issues", class: "read" },
  ]),
  error: null,
};

const gated: RemotePosture = {
  ...base,
  initializeStatus: 401,
  authRequired: true,
  toolsListAnonymous: false,
  protocolVersion: null,
  wwwAuthenticate: true,
  anonymousTools: null,
};

const ids = (p: RemotePosture) => postureFindings(p).map((f) => f.id);

describe("unauth-remote-writes", () => {
  it("is high when an anonymous tools/list has a destructive tool", () => {
    const p = {
      ...base,
      anonymousTools: postureTools([
        { tool: "list_issues", class: "read" },
        { tool: "delete_issue", class: "destructive" },
        { tool: "create_issue", class: "write" },
      ]),
    };
    const [f] = postureFindings(p);
    expect(f).toMatchObject({ id: "unauth-remote-writes", severity: "high" });
    expect(f!.message).toContain("2 tools that change things (1 destructive, 1 write)");
    expect(f!.message).toContain("never called");
    expect(f!.evidence).toContain("delete_issue (destructive)");
  });

  it("is warn when the changing tools are writes only", () => {
    const p = { ...base, anonymousTools: postureTools([{ tool: "create_issue", class: "write" }]) };
    expect(postureFindings(p)).toMatchObject([{ id: "unauth-remote-writes", severity: "warn" }]);
  });

  it("is not set by an anonymous list of reads only (near miss)", () => {
    expect(ids(base)).toEqual([]);
  });

  it("is not set when the list needed credentials, whatever the tools", () => {
    expect(ids({ ...gated, anonymousTools: postureTools([{ tool: "delete_x", class: "destructive" }]) })).not.toContain(
      "unauth-remote-writes",
    );
  });
});

describe("remote-auth-metadata-missing", () => {
  it("is set by a 401 with no resource_metadata and no well-known document", () => {
    const [f] = postureFindings(gated);
    expect(f).toMatchObject({ id: "remote-auth-metadata-missing", severity: "warn" });
    expect(f!.evidence).toContain("HTTP 401, with a WWW-Authenticate header");
  });

  it("is not set when the 401 names resource_metadata (near miss)", () => {
    expect(ids({ ...gated, resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource" })).toEqual([]);
  });

  it("is not set when the well-known document exists (near miss)", () => {
    const p = {
      ...gated,
      protectedResource: { url: "https://mcp.example.com/.well-known/oauth-protected-resource", authorizationServers: [] },
    };
    expect(ids(p)).toEqual([]);
  });

  it("is not set by an endpoint that does not ask for credentials", () => {
    expect(ids({ ...base, anonymousTools: null, toolsListAnonymous: false })).toEqual([]);
  });

  it("is not set by an endpoint that did not answer", () => {
    expect(ids({ ...base, reachable: false, initializeStatus: null, toolsListAnonymous: false, anonymousTools: null })).toEqual([]);
  });
});

describe("postureFacts and postureChanges", () => {
  it("lists the same facts in the same order for any record", () => {
    expect(postureFacts(base).map((f) => f.id)).toEqual(postureFacts(gated).map((f) => f.id));
  });

  it("reports every fact as new against no earlier record", () => {
    expect(postureChanges(null, base)).toHaveLength(postureFacts(base).length);
  });

  it("reports nothing for the same record, even when tool names or the error differ", () => {
    const other = { ...base, error: "something else", anonymousTools: postureTools([{ tool: "get_x", class: "read" }, { tool: "get_y", class: "read" }]) };
    expect(postureChanges(base, other)).toEqual([]);
  });

  it("reports what moved when an endpoint closes its anonymous list", () => {
    const changes = postureChanges(base, gated).map((c) => [c.id, c.before, c.after]);
    expect(changes).toContainEqual(["initialize-status", "200", "401"]);
    expect(changes).toContainEqual(["tools-list-anonymous", "yes", "no"]);
    expect(changes).toContainEqual(["www-authenticate", "not observed", "yes"]);
  });

  it("sorts authorization servers so their order is not a change", () => {
    const a = { ...gated, protectedResource: { url: "u", authorizationServers: ["https://b", "https://a"] } };
    const b = { ...gated, protectedResource: { url: "u", authorizationServers: ["https://a", "https://b"] } };
    expect(postureChanges(a, b)).toEqual([]);
  });

  it("keeps at most 25 changing tools by name, and counts them all", () => {
    const tools = postureTools(Array.from({ length: 40 }, (_, i) => ({ tool: `delete_${i}`, class: "destructive" as const })));
    expect(tools.changing).toHaveLength(25);
    expect(tools.counts.destructive).toBe(40);
  });
});

describe("methodology", () => {
  it("has an entry for the posture record and both findings", () => {
    const ids = METHODOLOGY.map((m) => m.id);
    for (const id of ["remote-posture", "unauth-remote-writes", "remote-auth-metadata-missing"]) expect(ids).toContain(id);
  });
});
