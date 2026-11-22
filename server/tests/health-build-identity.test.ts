import { afterEach, describe, expect, it, vi } from "vitest";

async function freshHealthApp() {
  vi.resetModules();
  return (await import("../src/api/routes/health.ts")).default;
}

describe("GET /health build identity", () => {
  afterEach(() => {
    delete process.env.BUILD_SHA;
    delete process.env.BUILD_TIME;
    vi.resetModules();
  });

  it("reports the commit the image was built from", async () => {
    process.env.BUILD_SHA = "0f54b91aa0000000000000000000000000000000";
    process.env.BUILD_TIME = "2026-09-08T10:00:00Z";

    const res = await (await freshHealthApp()).request("/");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      build: { commit: "0f54b91aa0000000000000000000000000000000", builtAt: "2026-09-08T10:00:00Z" },
    });
  }, 60_000);

  it("says 'unknown' rather than inventing one when the image was not stamped", async () => {
    const res = await (await freshHealthApp()).request("/");

    expect((await res.json()).build).toEqual({ commit: "unknown", builtAt: null });
  }, 60_000);
});
