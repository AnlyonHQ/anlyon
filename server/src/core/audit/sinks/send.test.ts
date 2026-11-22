import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { verifyDeliverySignature } from "../../../utils/crypto.ts";
import { AUDIT_SCHEMA, type AuditExportEvent } from "../event-schema.ts";
import { assertDestination, datadogConfigSchema, destinationUrls, s3ConfigSchema, webhookConfigSchema } from "./config.ts";
import { type Fetcher, datadogPayload, s3ObjectKey, s3ObjectUrl, sendToSink, splunkBody, splunkUrl, webhookBody } from "./send.ts";
import { encodeS3Key, signV4 } from "./sigv4.ts";

const NOW = new Date("2026-10-19T12:34:56.000Z");

function event(overrides: Partial<AuditExportEvent> = {}): AuditExportEvent {
  return {
    schema: AUDIT_SCHEMA,
    id: "aud_first",
    sequence: 1,
    type: "approval.vote",
    category: "approval",
    occurredAt: "2026-10-19T08:09:10.000Z",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    environmentId: "22222222-2222-4222-8222-222222222222",
    actor: { type: "user", id: "user_1" },
    resource: { type: "approval", id: "apr_1" },
    outcome: "approve",
    data: { approvalId: "apr_1", decision: "approve" },
    context: null,
    ...overrides,
  };
}

function endpoint(status = 200, body = "") {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | Buffer }> = [];
  const fetcher: Fetcher = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return new Response(status === 204 ? null : body, { status });
  });
  return { calls, fetcher };
}

describe("SigV4", () => {
  it("matches AWS's published GET Object example", () => {
    const authorization = signV4({
      method: "GET",
      path: "/test.txt",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "test-access-key-id",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=test-access-key-id/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("encodes keys per segment and keeps the slashes", () => {
    expect(encodeS3Key("a b/c(1)*!/d.ndjson.gz")).toBe("a%20b/c%281%29%2A%21/d.ndjson.gz");
  });
});

describe("webhook sink", () => {
  it("signs the body the way every Anlyon delivery is signed, and the SDK check accepts it", async () => {
    const { calls, fetcher } = endpoint(204);
    const secret = "whsec_test_secret_value_0123456789";
    const result = await sendToSink(
      { type: "webhook", config: { url: "https://siem.example.com/hook" }, credentials: { signingSecret: secret } },
      [event()],
      { batchId: "batch_1", fetcher, now: new Date() },
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("POST");
    expect(call.headers["Anlyon-Batch-Id"]).toBe("batch_1");
    expect(call.headers["Anlyon-Timestamp"]).toMatch(/^\d+$/);
    expect(verifyDeliverySignature(call.body as string, call.headers["Anlyon-Signature"], secret).valid).toBe(true);
    expect(verifyDeliverySignature(call.body as string, call.headers["Anlyon-Signature"], "whsec_other").valid).toBe(false);
    const parsed = JSON.parse(call.body as string);
    expect(parsed).toMatchObject({ schema: "anlyon.audit.batch.v1", batchId: "batch_1" });
    expect(parsed.events[0].id).toBe("aud_first");
  });

  it("reports a refusal with the status and the start of the body", async () => {
    const { fetcher } = endpoint(503, "upstream   unavailable\n");
    const result = await sendToSink(
      { type: "webhook", config: { url: "https://siem.example.com/hook" }, credentials: { signingSecret: "whsec_x".padEnd(20, "x") } },
      [event()],
      { batchId: "b", fetcher },
    );
    expect(result).toMatchObject({ ok: false, status: 503, error: "HTTP 503: upstream unavailable" });
  });

  it("reports a network failure instead of throwing", async () => {
    const fetcher: Fetcher = async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const result = await sendToSink(
      { type: "webhook", config: { url: "https://siem.example.com/hook" }, credentials: { signingSecret: "whsec_x".padEnd(20, "x") } },
      [event()],
      { batchId: "b", fetcher },
    );
    expect(result).toMatchObject({ ok: false, status: null, error: "fetch failed (ECONNREFUSED)" });
  });

  it("keeps the batch envelope stable", () => {
    expect(JSON.parse(webhookBody([event()], "b1"))).toEqual({ schema: "anlyon.audit.batch.v1", batchId: "b1", events: [event()] });
  });
});

describe("S3 sink", () => {
  it("writes one gzip NDJSON object under a date path, signed for the bucket's region", async () => {
    const { calls, fetcher } = endpoint(200);
    const events = [event(), event({ id: "aud_second", sequence: 2 })];
    const result = await sendToSink(
      {
        type: "s3",
        config: { bucket: "acme-audit", region: "eu-west-1", prefix: "anlyon/prod" },
        credentials: { accessKeyId: "AKIAEXAMPLEKEY", secretAccessKey: "<your-secret-access-key>" },
      },
      events,
      { batchId: "aud_first-2", fetcher, now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.location).toBe("anlyon/prod/2026/10/19/080910Z-aud_first-2.ndjson.gz");
    const call = calls[0];
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://acme-audit.s3.eu-west-1.amazonaws.com/anlyon/prod/2026/10/19/080910Z-aud_first-2.ndjson.gz");
    expect(call.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY\/20261019\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(call.headers["x-amz-date"]).toBe("20261019T123456Z");
    expect(call.headers).not.toHaveProperty("host");
    const lines = gunzipSync(call.body as Buffer).toString("utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["aud_first", "aud_second"]);
  });

  it("signs the session token when temporary credentials are used", async () => {
    const { calls, fetcher } = endpoint(200);
    await sendToSink(
      {
        type: "s3",
        config: { bucket: "acme-audit", region: "us-east-1" },
        credentials: { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "<secret>", sessionToken: "<token>" },
      },
      [event()],
      { batchId: "b", fetcher, now: NOW },
    );
    expect(calls[0].headers["x-amz-security-token"]).toBe("<token>");
    expect(calls[0].headers.authorization).toContain("x-amz-security-token");
  });

  it("uses path-style addressing for an S3-compatible endpoint", () => {
    expect(s3ObjectUrl({ bucket: "audit", region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com" }, "a/b.gz")).toEqual({
      url: "https://acct.r2.cloudflarestorage.com/audit/a/b.gz",
      host: "acct.r2.cloudflarestorage.com",
      path: "/audit/a/b.gz",
    });
    expect(s3ObjectUrl({ bucket: "audit", region: "auto", endpoint: "https://minio.example.com", forcePathStyle: false }, "k").host).toBe(
      "audit.minio.example.com",
    );
  });

  it("derives the same key for the same batch, so a retry overwrites instead of duplicating", () => {
    expect(s3ObjectKey({}, [event()], "aud_first-1")).toBe(s3ObjectKey({}, [event()], "aud_first-1"));
    expect(s3ObjectKey({ prefix: "/x/" }, [event()], "b")).toBe("x/2026/10/19/080910Z-b.ndjson.gz");
  });
});

describe("Datadog sink", () => {
  it("posts to the site's v2 logs intake with the API key header", async () => {
    const { calls, fetcher } = endpoint(202);
    const result = await sendToSink(
      { type: "datadog", config: { site: "datadoghq.eu", tags: ["team:sec"] }, credentials: { apiKey: "<your-dd-api-key>" } },
      [event()],
      { batchId: "b", fetcher },
    );
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
    expect(calls[0].headers["DD-API-KEY"]).toBe("<your-dd-api-key>");
    const [log] = JSON.parse(calls[0].body as string);
    expect(log.ddsource).toBe("anlyon");
    expect(log.ddtags).toBe("source:anlyon,team:sec,category:approval,environment_id:22222222-2222-4222-8222-222222222222");
    expect(JSON.parse(log.message).id).toBe("aud_first");
  });

  it("puts each event in its own log entry", () => {
    expect(datadogPayload({ site: "datadoghq.com" }, [event(), event({ id: "aud_2" })])).toHaveLength(2);
  });

  it("refuses a site that is not a Datadog intake", () => {
    expect(datadogConfigSchema.safeParse({ site: "evil.example.com" }).success).toBe(false);
  });
});

describe("Splunk HEC sink", () => {
  it("posts concatenated events with the Splunk token", async () => {
    const { calls, fetcher } = endpoint(200, '{"text":"Success","code":0}');
    const result = await sendToSink(
      { type: "splunk", config: { url: "https://splunk.example.com:8088", index: "security" }, credentials: { token: "<your-hec-token>" } },
      [event(), event({ id: "aud_2" })],
      { batchId: "b", fetcher },
    );
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("https://splunk.example.com:8088/services/collector/event");
    expect(calls[0].headers.Authorization).toBe("Splunk <your-hec-token>");
    const lines = (calls[0].body as string).split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ sourcetype: "anlyon:audit", index: "security", time: Date.parse("2026-10-19T08:09:10.000Z") / 1000 });
    expect(lines[0].event.id).toBe("aud_first");
  });

  it("accepts a URL that already names the collector", () => {
    expect(splunkUrl({ url: "https://s.example.com/services/collector" })).toBe("https://s.example.com/services/collector/event");
    expect(splunkUrl({ url: "https://s.example.com/services/collector/event/" })).toBe("https://s.example.com/services/collector/event");
  });

  it("omits the index when none is set", () => {
    expect(JSON.parse(splunkBody({ url: "https://s.example.com" }, [event()]))).not.toHaveProperty("index");
  });
});

describe("sink configuration", () => {
  it("refuses plain HTTP whatever the workspace allows", () => {
    expect(webhookConfigSchema.safeParse({ url: "http://siem.example.com/hook" }).success).toBe(false);
    expect(s3ConfigSchema.safeParse({ bucket: "audit", region: "us-east-1", endpoint: "http://minio.example.com" }).success).toBe(false);
  });

  it("refuses private destinations unless the workspace may use them, and metadata always", () => {
    for (const url of ["https://localhost/hook", "https://10.0.0.5:8088", "https://192.168.1.20/minio"]) {
      expect(() => assertDestination(url, false), url).toThrow(/cannot be used as a destination/);
      expect(() => assertDestination(url, true), url).not.toThrow();
    }
    for (const url of ["https://169.254.169.254/latest", "https://metadata.google.internal/x", "https://[fe80::1]/x"]) {
      expect(() => assertDestination(url, true), url).toThrow(/metadata and link-local/);
    }
    expect(() => assertDestination("https://siem.example.com/hook", false)).not.toThrow();
  });

  it("checks every URL a configuration names", () => {
    expect(destinationUrls("webhook", { url: "https://a.example.com" })).toEqual(["https://a.example.com"]);
    expect(destinationUrls("s3", { bucket: "b", region: "r" })).toEqual([]);
    expect(destinationUrls("s3", { bucket: "b", region: "r", endpoint: "https://minio.internal" })).toEqual(["https://minio.internal"]);
    expect(destinationUrls("datadog", { site: "datadoghq.com" })).toEqual([]);
  });

  it("refuses an unknown field rather than ignoring it", () => {
    expect(webhookConfigSchema.safeParse({ url: "https://siem.example.com", secret: "x" }).success).toBe(false);
  });
});
