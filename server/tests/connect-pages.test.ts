import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  process.env.CONNECT_PUBLIC_URL = "https://api.anlyon.test";
  process.env.CONNECT_PAGES_URL = "https://connect.anlyon.test";
  return {
    settings: { workspaceName: "Acme" } as { workspaceName: string } | null,
    keyLink: null as null | { integration: string; workspaceName: string; redirectUrl: string | null },
    submit: { status: "connected", redirectTo: null } as Record<string, unknown>,
    endUserRedirect: null as string | null,
    recordConsent: "completed",
  };
});

vi.mock("../src/lib/redis.ts", () => ({ redis: {}, redisBlocking: {}, RedisKeys: {}, createBlockingConnection: () => ({}) }));
vi.mock("../src/core/connections/service.ts", () => ({
  recordConsent: async () => fake.recordConsent,
  recordConsentFailure: async () => undefined,
}));
vi.mock("../src/core/end-users/connect.ts", () => ({
  KEY_LINK_PATH: "/api/v2/connection-consent/key",
  connectSettings: async () => {
    if (!fake.settings) throw new Error("no environment");
    return fake.settings;
  },
  peekKeyLink: async (token: string) => (token === "kln_live" && fake.keyLink ? fake.keyLink : null),
  submitKeyLink: async () => fake.submit,
  recordEndUserConsent: async () => fake.endUserRedirect,
}));

const { setConnectionProviderForTests } = await import("../src/core/connections/provider.ts");
const { default: consentRouter, connectPagesRouter } = await import("../src/api/routes/connection-consent.ts");
const { connectPagesHostGate } = await import("../src/api/connect-host.ts");
const { consentUrl } = await import("../src/core/connections/consent-urls.ts");
const { consentRedirectUri } = await import("../src/core/end-users/oauth-apps.ts");
const { connectPageCsp, renderConnectPage } = await import("../src/api/connect-pages/render.ts");
const views = await import("../src/api/connect-pages/views.ts");
const { LOGOS } = await import("../src/api/connect-pages/logos.ts");
const { inlineSvg, isInertSvg } = await import("../src/api/connect-pages/svg.ts");
import type { ConnectionProvider, ConsentPeek, ConsentResult } from "../src/core/connections/types.ts";

const API = "https://api.anlyon.test";
const PAGES = "https://connect.anlyon.test";
const AUTHORIZE = "https://app.hubspot.com/oauth/authorize?client_id=fake&state=fake-state";
const subject = { endUserId: "alice", redirectUrl: "https://app.example.com/connected", confirm: true, flowId: "flw_fake" };

let peek: ConsentPeek | null;
let begin: () => Promise<string | null>;
let finish: () => Promise<ConsentResult>;

function provider(): ConnectionProvider {
  return {
    connectUrl: (token: string) => `${PAGES}/start?token=${token}`,
    peekConsent: async () => peek,
    beginConsent: () => begin(),
    finishConsent: () => finish(),
  } as unknown as ConnectionProvider;
}

function api() {
  const app = new Hono({ strict: false });
  app.use("*", connectPagesHostGate);
  app.route("/api/v2/connection-consent", consentRouter);
  app.route("/", connectPagesRouter);
  app.get("/api/v2/workspaces", (c) => c.json({ data: "the API" }));
  app.notFound((c) => c.json({ code: "NOT_FOUND" }, 404));
  return app;
}
const get = (url: string) => api().request(url);
const postKey = (url: string, fields: Record<string, string>) => api().request(url, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

const STATIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function expectPage(res: Response, status: number, text: string): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action [^;]+; frame-ancestors 'none'$/);
  const html = await res.text();
  expect(html).toContain(text);
  expect(html).toContain("Secured by");
  expect(html).not.toMatch(/<script|<link\b|<img\b|\bsrc=|@import|url\((?!#)/i);
  return html;
}

beforeEach(() => {
  fake.settings = { workspaceName: "Acme" };
  fake.keyLink = { integration: "github", workspaceName: "Acme", redirectUrl: "https://app.example.com/connected" };
  fake.submit = { status: "connected", redirectTo: null };
  fake.endUserRedirect = null;
  fake.recordConsent = "completed";
  peek = { integrationKey: "hubspot", workspaceId: "ws", environmentId: "env", subject, ownApp: false, expiresAt: new Date(Date.now() + 60_000) };
  begin = async () => AUTHORIZE;
  finish = async () => ({ ok: false, reason: "expired", endUserId: null });
  setConnectionProviderForTests(provider());
});
afterEach(() => setConnectionProviderForTests(undefined));

describe("connect URLs", () => {
  it("use the pages origin's short paths when CONNECT_PAGES_URL is set", () => {
    expect(consentUrl("link")).toBe(`${PAGES}/link`);
    expect(consentUrl("key")).toBe(`${PAGES}/key`);
    expect(consentUrl("start")).toBe(`${PAGES}/start`);
    expect(consentRedirectUri()).toBe(`${PAGES}/callback`);
  });
});

describe("the pages host", () => {
  it("answers the four page paths and nothing else: the API is never served under its origin", async () => {
    await expectPage(await get(`${PAGES}/link?token=cst_x`), 200, "Connect HubSpot to Acme");
    for (const path of ["/", "/api/v2/workspaces", "/api/auth/get-session", "/api/v2/connection-consent/link?token=cst_x", "/link/extra", "/favicon.ico"]) {
      await expectPage(await get(`${PAGES}${path}`), 404, "There is nothing here");
    }
    const post = await api().request(`${PAGES}/start`, { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("on the API host the long paths keep working and the short ones do not exist", async () => {
    await expectPage(await get(`${API}/api/v2/connection-consent/link?token=cst_x`), 200, "Connect HubSpot to Acme");
    for (const path of ["/link?token=cst_x", "/key?token=kln_live", "/start?token=cst_x", "/callback?state=x"]) {
      const res = await get(`${API}${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ code: "NOT_FOUND" });
    }
    expect(await (await get(`${API}/api/v2/workspaces`)).json()).toEqual({ data: "the API" });
  });
});

describe("an end user's connect link", () => {
  it("with Anlyon's shared app shows who is asking, that the provider will show Anlyon, and a way back", async () => {
    const res = await get(`${PAGES}/link?token=cst_x`);
    expect(res.headers.get("content-security-policy")).toBe(STATIC_CSP);
    const html = await expectPage(res, 200, "Connect HubSpot to Acme");
    expect(html).toContain("Acme is asking to act in your HubSpot account.");
    expect(html).toContain("You sign in at HubSpot, not here.");
    expect(html).toContain("HubSpot will show Anlyon, which connects your account for Acme.");
    expect(html).toContain("Acme never sees your password.");
    expect(html).toContain(`href="${PAGES}/start?token=cst_x"`);
    expect(html).toContain("Continue to HubSpot");
    expect(html).toContain('href="https://app.example.com/connected?integration=hubspot&amp;anlyon_status=declined"');
    expect(html).toContain("Cancel and go back");
    expect(html).not.toContain("alice");
    expect(html).toContain('viewBox="0 0 24 24"');
  });

  it("has no way back when it has no redirect", async () => {
    peek = { ...peek!, subject: { ...subject, redirectUrl: null } };
    const html = await (await get(`${PAGES}/link?token=cst_x`)).text();
    expect(html).not.toContain("Cancel and go back");
  });

  it("with the environment's own app goes straight to the provider, with no page", async () => {
    peek = { ...peek!, ownApp: true };
    const res = await get(`${PAGES}/link?token=cst_x`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(AUTHORIZE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("says so when it expired, when sign-in could not start, and when signing in is not set up", async () => {
    peek = null;
    await expectPage(await get(`${PAGES}/link?token=cst_x`), 410, "This link has expired");
    peek = { integrationKey: "hubspot", workspaceId: "ws", environmentId: "env", subject: null, ownApp: false, expiresAt: new Date() };
    await expectPage(await get(`${PAGES}/link?token=cst_x`), 410, "This link has expired");
    peek = { ...peek, subject, ownApp: true };
    begin = async () => { throw new Error("provider down"); };
    await expectPage(await get(`${PAGES}/link?token=cst_x`), 502, "Sign-in could not start");
    setConnectionProviderForTests(null);
    await expectPage(await get(`${PAGES}/link?token=cst_x`), 501, "Signing in is not available");
  });

  it("escapes the workspace name", async () => {
    fake.settings = { workspaceName: `<img src=x onerror="alert(1)">` };
    const html = await (await get(`${PAGES}/link?token=cst_x`)).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("start", () => {
  it("redirects to the provider, or says the sign-in link expired or could not start", async () => {
    const res = await get(`${PAGES}/start?token=cst_x`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(AUTHORIZE);
    begin = async () => null;
    await expectPage(await get(`${PAGES}/start?token=cst_x`), 410, "This sign-in link has expired");
    begin = async () => { throw new Error("no app"); };
    await expectPage(await get(`${API}/api/v2/connection-consent/start?token=cst_x`), 502, "Sign-in could not start");
  });
});

describe("a key link", () => {
  it("shows the form, posting back to the path it came from, with its redirect's origin allowed", async () => {
    const res = await get(`${PAGES}/key?token=kln_live`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' https://app.example.com; frame-ancestors 'none'");
    const html = await expectPage(res, 200, "Connect GitHub to Acme");
    expect(html).toContain('<form method="post" action="/key"');
    expect(html).toContain('name="token" value="kln_live"');
    expect(html).toContain('name="f_apiKey" type="password"');
    expect(html).toContain("Your key is checked with GitHub before it is saved.");
    expect(html).toContain("Cancel and go back");

    const long = await (await get(`${API}/api/v2/connection-consent/key?token=kln_live`)).text();
    expect(long).toContain('action="/api/v2/connection-consent/key"');
  });

  it("allows only this origin when there is no redirect", async () => {
    fake.keyLink = { ...fake.keyLink!, redirectUrl: null };
    const res = await get(`${PAGES}/key?token=kln_live`);
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(await res.text()).not.toContain("Cancel and go back");
  });

  it("shows the form again after a refused key, with tries left, never the key", async () => {
    fake.submit = { status: "refused", message: "GitHub refused the key.", attemptsLeft: 4 };
    const html = await expectPage(await postKey(`${PAGES}/key`, { token: "kln_live", f_apiKey: "fake-refused-value" }), 400, "4 tries are left on this link.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("GitHub refused the key.");
    expect(html).toContain('<form method="post" action="/key"');
    expect(html).not.toContain("fake-refused-value");

    fake.submit = { status: "refused", message: "GitHub refused the key.", attemptsLeft: 1 };
    expect(await (await postKey(`${PAGES}/key`, { token: "kln_live", f_apiKey: "x" })).text()).toContain("One try is left on this link.");

    fake.submit = { status: "refused", message: "GitHub refused the key.", attemptsLeft: 0 };
    const usedUp = await expectPage(await postKey(`${PAGES}/key`, { token: "kln_live", f_apiKey: "x" }), 400, "GitHub did not accept the key");
    expect(usedUp).not.toContain("<form");
    expect(usedUp).toContain("anlyon_status=error");
  });

  it("sends the browser back, or says it is connected, or that the link expired", async () => {
    fake.submit = { status: "connected", redirectTo: "https://app.example.com/connected?anlyon_status=pending_confirmation" };
    const back = await postKey(`${PAGES}/key`, { token: "kln_live", f_apiKey: "x" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("https://app.example.com/connected?anlyon_status=pending_confirmation");
    fake.submit = { status: "connected", redirectTo: null };
    await expectPage(await postKey(`${PAGES}/key`, { token: "kln_live", f_apiKey: "x" }), 200, "GitHub is connected");
    fake.submit = { status: "expired" };
    await expectPage(await postKey(`${PAGES}/key`, { token: "kln_live", f_apiKey: "x" }), 410, "This link has expired");
    await expectPage(await get(`${PAGES}/key?token=kln_gone`), 410, "This link has expired");
  });
});

describe("the callback", () => {
  const outcome = { operation: "creation" as const, integrationKey: "hubspot", connectionId: "oc_x", endUserId: "e" };
  const endUser = { ...subject, workspaceId: "ws", environmentId: "env", integrationKey: "hubspot", pendingUntil: null };

  it("shows each way a sign-in can end", async () => {
    await expectPage(await get(`${PAGES}/callback?state=x`), 410, "This sign-in has expired");

    finish = async () => ({ ok: false, reason: "declined", endUserId: "e" });
    await expectPage(await get(`${PAGES}/callback?state=x`), 200, "Access was not approved");
    finish = async () => ({ ok: false, reason: "provider_error", endUserId: "e" });
    await expectPage(await get(`${PAGES}/callback?state=x`), 502, "The account was not connected");
    finish = async () => ({ ok: false, reason: "declined", endUserId: "e", subject: endUser });
    await expectPage(await get(`${PAGES}/callback?state=x`), 200, "Nothing was connected");
    finish = async () => { throw new Error("boom"); };
    await expectPage(await get(`${PAGES}/callback?state=x`), 502, "The account was not connected");

    finish = async () => ({ ok: true, outcome });
    const console = await expectPage(await get(`${PAGES}/callback?state=x`), 200, "HubSpot is connected");
    expect(console).toContain("go back to Anlyon.");
    fake.recordConsent = "session_expired";
    await expectPage(await get(`${PAGES}/callback?state=x`), 400, "The account was not connected");

    finish = async () => ({ ok: true, outcome: { ...outcome, subject: endUser } });
    expect(await (await get(`${PAGES}/callback?state=x`)).text()).toContain("go back to Acme&#39;s app.");
    fake.endUserRedirect = "https://app.example.com/connected?anlyon_status=connected";
    const back = await get(`${API}/api/v2/connection-consent/callback?state=x`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(fake.endUserRedirect);
  });
});

describe("the page renderer", () => {
  it("renders every state as a static page", () => {
    const all = [
      views.linkView({ integration: { id: "hubspot", name: "HubSpot" }, app: "Acme", continueHref: "https://x.test/start", cancelHref: null }),
      views.keyFormView({ integration: { id: "zendesk", name: "Zendesk" }, app: "Acme", token: "kln_x", action: "/key", fields: [{ name: "subdomain", label: "Subdomain", hint: "Before .zendesk.com", secret: false }], cancelHref: null, redirectOrigin: null }),
      views.keyUsedUpView({ integration: { id: "github", name: "GitHub" }, app: "Acme", message: "Refused.", backHref: null }),
      views.expiredLinkView(), views.expiredSignInLinkView(), views.expiredSignInView(), views.signInCouldNotStartView(),
      views.connectedView({ integration: { id: "hubspot", name: "HubSpot" }, app: "Acme" }), views.connectedView({ integration: null, app: undefined }),
      views.accessNotApprovedView(), views.nothingConnectedView(200), views.notConnectedView(502, "No."), views.unavailableView(), views.notFoundView(),
    ];
    for (const view of all) {
      const html = renderConnectPage(view);
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).not.toMatch(/<script|<link\b|<img\b|\bsrc=/i);
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    }
  });

  it("names the host an MCP server's key is sent to, and does not say the app never sees it", () => {
    const base = { integration: { id: "mcp-00000000-0000-4000-8000-000000000001", name: "GitHub" }, app: "Acme", token: "kln_x", action: "/key", fields: [], cancelHref: null, redirectOrigin: null };
    const page = JSON.stringify(views.keyFormView({ ...base, destination: { host: "mcp.attacker.example" } }));
    expect(page).toContain("a server at mcp.attacker.example");
    expect(page).toContain("Your key is sent to mcp.attacker.example, the server Acme chose");
    expect(page).not.toContain("never sees it");
    expect(page).not.toContain("checked with GitHub");
    expect(JSON.stringify(views.keyFormView(base))).toContain("Acme never sees it");
    expect(JSON.stringify(views.keyFormView({ ...base, destination: { host: null } }))).toContain("Your key is sent to that server, the server Acme chose");
  });

  it("an integration without a mark gets its initial; a form target that is not an origin is dropped", () => {
    const html = renderConnectPage(views.linkView({ integration: { id: "zeta-crm", name: "Zeta CRM" }, app: "Acme", continueHref: "https://x.test", cancelHref: null }));
    expect(html).toContain('<span class="letter">Z</span>');
    const view = views.keyFormView({ integration: { id: "github", name: "GitHub" }, app: "Acme", token: "kln_x", action: "/key", fields: [], cancelHref: null, redirectOrigin: "https://ok.test; script-src *" });
    expect(connectPageCsp(view)).toContain("form-action 'self';");
  });

  it("the inlined marks are the console's, and draw only", () => {
    const dir = resolve(__dirname, "../../dashboard/public/integrations");
    const files = readdirSync(dir).filter((name) => name.endsWith(".svg"));
    expect(Object.keys(LOGOS).sort(), "run scripts/connect-page-logos.ts").toEqual(files.map((name) => name.replace(/\.svg$/, "")).sort());
    for (const name of files) {
      expect(LOGOS[name.replace(/\.svg$/, "")], `${name}: run scripts/connect-page-logos.ts`).toBe(inlineSvg(readFileSync(resolve(dir, name), "utf8")));
    }
    for (const svg of Object.values(LOGOS)) expect(isInertSvg(svg)).toBe(true);
  });
});
