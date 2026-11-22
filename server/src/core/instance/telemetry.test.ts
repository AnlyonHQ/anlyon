import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTelemetryPayload, postTelemetry, type TelemetryPayload } from "./telemetry.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const sample = (): TelemetryPayload =>
  buildTelemetryPayload({
    instanceId: "8a7c0f1e-1111-4222-8333-944445555666",
    version: "abc1234",
    edition: "community",
    now: new Date("2026-10-20T12:00:00Z"),
    counts: {
      workspaces: 2,
      members: 5,
      actions: 12,
      invocations: 40,
      effectsByGrade: { confirmed: 30, failed: 2, made_up_grade: 99 },
      approvalsRequested: 6,
      approvalsDecided: 5,
    },
  });

describe("telemetry payload", () => {
  it("is exactly the documented document, and nothing else", () => {
    expect(sample()).toEqual({
      schema: "anlyon.telemetry.v1",
      instanceId: "8a7c0f1e-1111-4222-8333-944445555666",
      version: "abc1234",
      edition: "community",
      day: "2026-10-20",
      counts: {
        workspaces: 2,
        members: 5,
        actions: 12,
        invocations: 40,
        effectsByGrade: { confirmed: 30, acknowledged: 0, unknown: 0, failed: 2, refused: 0, denied: 0, pending: 0 },
        approvalsRequested: 6,
        approvalsDecided: 5,
      },
    });
  });

  it("carries only numbers besides its five identifying fields", () => {
    const strings: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string") strings.push(path);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    };
    walk(sample(), "$");
    expect(strings.sort()).toEqual(["$.day", "$.edition", "$.instanceId", "$.schema", "$.version"]);
  });
});

describe("postTelemetry", () => {
  it("never throws, and says whether the report arrived", async () => {
    const refused = vi.fn(async () => ({ ok: false, status: 503 }));
    expect(await postTelemetry(sample(), "https://telemetry.example.com/v1/ping", refused)).toBe(false);
    const failing = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND telemetry.example.com");
    });
    expect(await postTelemetry(sample(), "https://telemetry.example.com/v1/ping", failing)).toBe(false);
    const accepted = vi.fn(async () => ({ ok: true, status: 204 }));
    expect(await postTelemetry(sample(), "https://telemetry.example.com/v1/ping", accepted)).toBe(true);
  });

  it("posts the JSON document with a timeout", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => ({ ok: true, status: 204 }));
    await postTelemetry(sample(), "https://telemetry.example.com/v1/ping", fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://telemetry.example.com/v1/ping");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(sample());
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("telemetryEnabled", () => {
  async function load(edition: "cloud" | "community") {
    vi.resetModules();
    vi.stubEnv("EDITION", edition);
    vi.stubEnv("ANLYON_TELEMETRY", undefined);
    return import("./telemetry.ts");
  }

  it("is on by default outside cloud and off with ANLYON_TELEMETRY=off", async () => {
    const telemetry = await load("community");
    expect(telemetry.telemetryEnabled()).toBe(true);
    vi.stubEnv("ANLYON_TELEMETRY", "off");
    expect(telemetry.telemetryEnabled()).toBe(false);
  });

  it("is never on for cloud, whatever is set", async () => {
    const telemetry = await load("cloud");
    vi.stubEnv("ANLYON_TELEMETRY", "on");
    expect(telemetry.telemetryEnabled()).toBe(false);
  });
});

describe("reportTelemetryIfDue", () => {
  async function load(pending: boolean) {
    vi.resetModules();
    vi.stubEnv("EDITION", "community");
    vi.stubEnv("ANLYON_TELEMETRY", undefined);
    const written: string[] = [];
    vi.doMock("./setup.ts", () => ({ isSetupPending: async () => pending }));
    vi.doMock("./internal.ts", () => ({
      readInternal: async () => null,
      writeInternal: async (key: string) => { written.push(key); },
      claimInternal: async () => true,
    }));
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(String(url)); return new Response(null, { status: 204 }); });
    const telemetry = await import("./telemetry.ts");
    return { telemetry, written, fetched };
  }
  afterEach(() => {
    vi.doUnmock("./setup.ts");
    vi.doUnmock("./internal.ts");
    vi.unstubAllGlobals();
  });

  it("sends nothing, and records no attempt, while nobody has set the install up", async () => {
    const { telemetry, written, fetched } = await load(true);
    await telemetry.reportTelemetryIfDue(new Date("2026-11-12T00:00:00Z"));
    expect(fetched).toEqual([]);
    expect(written).toEqual([]);
  });
});
