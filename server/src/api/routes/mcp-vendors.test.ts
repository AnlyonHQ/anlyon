import { KNOWN_VENDORS } from "@anlyon/known-vendors";
import { describe, expect, it } from "vitest";
import mcpVendorsRouter from "./mcp-vendors.ts";

describe("GET /api/v2/mcp-vendors", () => {
  it("lists every known vendor without credentials, with the fields copies need", async () => {
    const res = await mcpVendorsRouter.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    const body = (await res.json()) as { success: boolean; data: { checkedOn: string; source: string; vendors: Array<Record<string, unknown>> } };
    expect(body.success).toBe(true);
    expect(body.data.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.vendors).toHaveLength(KNOWN_VENDORS.length);
    const linear = body.data.vendors.find((vendor) => vendor.slug === "linear");
    expect(linear).toEqual({
      name: "Linear",
      slug: "linear",
      aliases: [],
      domains: ["linear.app"],
      githubOrgs: [],
      registryName: "app.linear/linear",
      url: "https://mcp.linear.app/mcp",
      proven: true,
      checkedOn: body.data.checkedOn,
    });
  });

  it("is read-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await mcpVendorsRouter.request("/", { method });
      expect(res.status, method).toBe(404);
    }
  });
});
