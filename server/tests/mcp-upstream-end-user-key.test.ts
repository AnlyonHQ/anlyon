import { describe, expect, it } from "vitest";
import { hashTools } from "@anlyon-dev/risk";
import {
  assertNoHeaderTwice, endUserKeyHeader, readUpstreamKey, rowHoldsUpstreamKey, UPSTREAM_KEY_MAX_LENGTH, withEndUserKeyRef, withoutEndUserKeyHeader,
} from "../src/core/mcp-upstreams/end-user-key.ts";
import { buildMcpToolAdapter, type McpToolRequest } from "../src/core/effects/adapters/mcp-tool.ts";
import { ValidationError } from "../src/utils/errors.ts";

const CONNECTION = "mcp-11111111-2222-4333-8444-555555555555";
const HEADERS = { Authorization: "Bearer {{secret:NOTES_KEY}}", "X-Client": "anlyon" };

describe("the header an end user's key rides in", () => {
  it("is found whatever its case, and named as the headers spell it, with the operator's secret", () => {
    expect(endUserKeyHeader(HEADERS, "authorization")).toEqual({ header: "Authorization", secret: "NOTES_KEY" });
    expect(endUserKeyHeader({ "x-api-key": "{{ secret:K_1 }}" }, "X-API-Key")).toEqual({ header: "x-api-key", secret: "K_1" });
  });

  it("must be one of the headers and hold exactly one reference, a secret", () => {
    expect(() => endUserKeyHeader(HEADERS, "X-Api-Key")).toThrow(/not one of this server's headers/);
    for (const value of ["anlyon", "{{secret:A}} {{secret:B}}", "{{secret:A}}{{connection:hubspot}}", "{{secret:A}}{{input.x}}", "{{connection:hubspot}}"]) {
      expect(() => endUserKeyHeader({ Authorization: value }, "Authorization")).toThrow(/exactly one \{\{secret:NAME\}\} reference/);
    }
  });

  it("is refused when the headers give it twice in two spellings", () => {
    const twice = { Authorization: "Bearer {{secret:NOTES_KEY}}", authorization: "Bearer {{secret:OTHER_KEY}}" };
    expect(() => endUserKeyHeader(twice, "Authorization")).toThrow(/given twice/);
    expect(() => assertNoHeaderTwice(twice)).toThrow(ValidationError);
    expect(() => assertNoHeaderTwice({ "X-Api-Key": "a", "x-api-key": "b" })).toThrow(/given twice/);
    expect(() => assertNoHeaderTwice(HEADERS)).not.toThrow();
  });

  it("carries a connection reference in a request, with what surrounds it kept and other headers untouched", () => {
    expect(withEndUserKeyRef(HEADERS, { connection: CONNECTION, header: "Authorization" }))
      .toEqual({ Authorization: `Bearer {{connection:${CONNECTION}}}`, "X-Client": "anlyon" });
    expect(HEADERS.Authorization).toBe("Bearer {{secret:NOTES_KEY}}");
    expect(withoutEndUserKeyHeader(HEADERS, "AUTHORIZATION")).toEqual({ "X-Client": "anlyon" });
  });
});

describe("an end user's key", () => {
  it("is trimmed and kept as it is", () => {
    expect(readUpstreamKey("  sk_live_abc-123.DEF/+=~  ")).toBe("sk_live_abc-123.DEF/+=~");
    expect(readUpstreamKey("k".repeat(UPSTREAM_KEY_MAX_LENGTH))).toHaveLength(UPSTREAM_KEY_MAX_LENGTH);
  });

  it("cannot break out of its header or read as a reference", () => {
    for (const bad of [undefined, null, 42, "", "   ", "two words", "tab\there", "line\nbreak", "cr\r\nInjected: 1", "clé", "{{secret:OTHER}}", "a{{b", "k".repeat(UPSTREAM_KEY_MAX_LENGTH + 1)]) {
      expect(() => readUpstreamKey(bad)).toThrow(ValidationError);
    }
  });

  it("is told apart from a sign-in grant by its mark, on an upstream's key only", () => {
    expect(rowHoldsUpstreamKey({ integrationKey: CONNECTION, connectionConfig: { upstreamKey: true } })).toBe(true);
    expect(rowHoldsUpstreamKey({ integrationKey: CONNECTION, connectionConfig: {} })).toBe(false);
    expect(rowHoldsUpstreamKey({ integrationKey: CONNECTION, connectionConfig: null })).toBe(false);
    expect(rowHoldsUpstreamKey({ integrationKey: "github", connectionConfig: { upstreamKey: true } })).toBe(false);
  });
});

describe("the mcp.tool adapter, for a tool whose end users bring their own key", () => {
  const TOOL = { name: "create_note", description: "Creates a note.", inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } };
  const definition = async (mcp: Record<string, unknown> = {}, headers: Record<string, string> = HEADERS) => ({
    urlTemplate: "https://mcp.notes.example/mcp",
    headers,
    inputSchema: TOOL.inputSchema,
    mcp: { upstreamId: "mcpu_test", toolName: TOOL.name, toolHash: await hashTools([TOOL]), suggestedClass: "write", ...mcp },
    declarations: null,
  });

  it("names the key by reference in the normalized request, the same for every caller", async () => {
    const adapter = buildMcpToolAdapter(await definition({ endUserKey: { connection: CONNECTION, header: "Authorization" } }));
    const config = adapter.parseConfig(await definition({ endUserKey: { connection: CONNECTION, header: "Authorization" } }));
    const request = adapter.normalize(config, { title: "Hello" }).request as unknown as McpToolRequest;
    expect(request.headers).toEqual({ Authorization: `Bearer {{connection:${CONNECTION}}}`, "X-Client": "anlyon" });
    expect(JSON.stringify(request)).not.toContain("NOTES_KEY");
  });

  it("leaves a tool without the option exactly as it was", async () => {
    const adapter = buildMcpToolAdapter(await definition());
    const request = adapter.normalize(adapter.parseConfig(await definition()), { title: "Hello" }).request as unknown as McpToolRequest;
    expect(request.headers).toEqual(HEADERS);
  });

  it("refuses a binding that names no upstream, a header the action lacks, one with no secret, or OAuth as well", async () => {
    const build = async (mcp: Record<string, unknown>, headers?: Record<string, string>) => buildMcpToolAdapter(await definition(mcp, headers));
    await expect(build({ endUserKey: { connection: "hubspot", header: "Authorization" } })).rejects.toThrow(/must name its upstream/);
    await expect(build({ endUserKey: { connection: CONNECTION } })).rejects.toThrow(/must name its upstream/);
    await expect(build({ endUserKey: { connection: CONNECTION, header: "X-Api-Key" } })).rejects.toThrow(/not one of this server's headers/);
    await expect(build({ endUserKey: { connection: CONNECTION, header: "X-Client" } })).rejects.toThrow(/exactly one/);
    await expect(build({ endUserKey: { connection: CONNECTION, header: "Authorization" }, oauthConnection: CONNECTION })).rejects.toThrow(/not both/);
  });
});
