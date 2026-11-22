import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net, { type AddressInfo } from "node:net";

const SECRET = "sk_live_SECRET_IN_URL";
const envelopes: string[] = [];
const receivedRequests: string[] = [];
let server: net.Server;
let sentry: typeof import("../../src/lib/sentry.ts");

beforeAll(async () => {
  process.env.SENTRY_DSN = "https://publickey@o0.ingest.sentry.io/0";
  process.env.SENTRY_TRACES_SAMPLE_RATE = "1";
  const Sentry = await import("@sentry/node");
  sentry = await import("../../src/lib/sentry.ts");
  sentry.initSentry();
  Sentry.getClient()!.on("beforeEnvelope", (envelope) => envelopes.push(JSON.stringify(envelope)));

  server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      receivedRequests.push(chunk.toString("latin1"));
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { fetch: undiciFetch } = await import("undici");
  await Sentry.startSpan({ name: "action invoke" }, async () => {
    await (await undiciFetch(`${base}/bot${SECRET}/send?api_key=${SECRET}`)).text();
  });
  sentry.captureException(new Error("a later, unrelated failure"));
  await sentry.flush(2000);
});

afterAll(() => server?.close());

describe("Sentry and secrets on the wire", () => {
  it("sends envelopes (the probe is live)", () => {
    expect(envelopes.length).toBeGreaterThan(0);
  });

  it("never contains a secret from an outbound URL, in the query or the path", () => {
    expect(envelopes.join("\n")).not.toContain(SECRET);
  });

  it("does not propagate Sentry trace headers to outbound destinations", () => {
    expect(receivedRequests).toHaveLength(1);
    const head = receivedRequests[0].toLowerCase();
    expect(head).not.toContain("sentry-trace:");
    expect(head).not.toContain("baggage:");
  });
});

describe("scrubSentryPayload", () => {
  it("strips query strings and credential headers anywhere in a payload", () => {
    const scrubbed = sentry.scrubSentryPayload({
      request: {
        url: "https://api.anlyon.com/api/auth/verify-email?token=abc",
        query_string: "token=abc",
        headers: { Authorization: "Bearer x", "origin-secret": "y", "Stripe-Signature": "z", accept: "json" },
      },
      spans: [{ data: { "url.full": "https://h.example/p?k=v#frag", "http.query": "k=v" } }],
      message: "not a url?keep",
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/token=abc|Bearer x|"y"|"z"|k=v|frag/);
    expect(scrubbed.request.url).toBe("https://api.anlyon.com/api/auth/verify-email");
    expect(scrubbed.request.headers).toEqual({ accept: "json" });
    expect(scrubbed.message).toBe("not a url?keep");
  });

  it("does not throw on read-only properties, which would drop the event", () => {
    const frozen = Object.freeze({ url: "https://h.example/p?k=v" });
    const withGetter = Object.defineProperty({}, "url", { get: () => "https://h.example/p?k=v", enumerable: true });
    expect(() => sentry.scrubSentryPayload({ frozen, withGetter })).not.toThrow();
  });
});
