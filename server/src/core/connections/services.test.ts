import { describe, expect, it } from "vitest";
import { SERVICES, serviceIntegrations, serviceOfIntegration } from "@anlyon/known-vendors/services";
import { CATALOGUE, googleEntries } from "./catalogue.ts";

const entries = [...CATALOGUE, ...googleEntries(true), ...googleEntries(false)];
const byId = new Map(entries.map((entry) => [entry.id, entry]));

describe("services against the integration catalogue", () => {
  it("every integration belongs to a service", () => {
    for (const entry of entries) expect(serviceOfIntegration(entry.id), entry.id).not.toBeNull();
  });

  it("every integration a service names is in the catalogue", () => {
    for (const service of SERVICES) {
      for (const id of serviceIntegrations(service)) expect(byId.has(id), `${service.name}: ${id}`).toBe(true);
    }
  });

  it("offers sign-in exactly for OAuth integrations, and a key exactly where one is taken", () => {
    for (const service of SERVICES) {
      for (const id of serviceIntegrations(service)) {
        const entry = byId.get(id)!;
        const ways = service.ways.filter((way) => way.kind !== "mcp" && way.integration === id).map((way) => way.kind).sort();
        const expected = entry.auth.kind === "oauth"
          ? (entry.auth.apiKey ? ["api_key", "sign_in"] : ["sign_in"])
          : ["api_key"];
        expect(ways, `${service.name}: ${id}`).toEqual(expected);
      }
    }
  });
});
