import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mcpHandler } from "./mcp-bearer.ts";
import { MCP_RESOURCE_METADATA_URL } from "./mcp-challenge.ts";

const issuer = "https://auth.test/api/auth";
const audience = "https://auth.test/mcp";
const jwksUrl = `${issuer}/jwks`;

let privateKey: CryptoKey;
let keySet: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  privateKey = pair.privateKey;
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }] };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function serveKeys(response: () => Response = () => Response.json(keySet)) {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
}

const sign = (claims: Record<string, unknown>, options: { aud?: string; exp?: string | number } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(options.aud ?? audience)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "15m")
    .sign(privateKey);

const bearer = (token?: string) => new Request(audience, { method: "POST", headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

function guard() {
  const seen: Array<Record<string, unknown>> = [];
  const handle = mcpHandler({ jwksUrl, verifyOptions: { audience, issuer } }, (_request, jwt) => {
    seen.push(jwt);
    return new Response("ok");
  });
  return { handle, seen };
}

async function expectChallenge(response: Response, description: string) {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}"`);
  expect(await response.json()).toEqual({ error: "invalid_token", error_description: description });
}

describe("mcpHandler", () => {
  it("passes a verified token through, with client_id taken from azp", async () => {
    serveKeys();
    const { handle, seen } = guard();
    const response = await handle(bearer(await sign({ sub: "user_1", azp: "client_1", scope: "anlyon:actions" })));
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sub: "user_1", azp: "client_1", client_id: "client_1", aud: audience });
  });

  it("challenges a request with no bearer, without fetching keys", async () => {
    serveKeys();
    const { handle, seen } = guard();
    await expectChallenge(await handle(bearer()), "missing authorization header");
    await expectChallenge(await handle(new Request(audience, { method: "POST", headers: { authorization: "" } })), "missing authorization header");
    expect(seen).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("challenges an opaque token: /mcp accepts only JWTs", async () => {
    serveKeys();
    const { handle } = guard();
    await expectChallenge(await handle(bearer("YlutvTCcjOgjjnVmIyuZGFjKTyyDDott")), "no token payload");
  });

  it("challenges a token for another audience, an expired one, and a forged one", async () => {
    serveKeys();
    const { handle, seen } = guard();
    await expectChallenge(await handle(bearer(await sign({ sub: "user_1" }, { aud: "https://elsewhere.example/mcp" }))), "invalid access token");
    await expectChallenge(await handle(bearer(await sign({ sub: "user_1" }, { exp: Math.floor(Date.now() / 1000) - 60 }))), "token expired");
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await new SignJWT({ sub: "user_1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("15m")
      .sign(other.privateKey);
    await expectChallenge(await handle(bearer(forged)), "invalid access token");
    expect(seen).toHaveLength(0);
  });

  it("challenges an unsigned token on its header, without fetching keys", async () => {
    serveKeys();
    const { handle, seen } = guard();
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "none" })}.${part({ sub: "attacker", aud: audience, iss: issuer })}.`;
    await expectChallenge(await handle(bearer(unsigned)), "invalid access token");
    expect(seen).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send a client round the OAuth flow when the keys cannot be fetched", async () => {
    serveKeys(() => new Response("unavailable", { status: 503 }));
    const { handle } = guard();
    await expect(handle(bearer(await sign({ sub: "user_1" })))).rejects.toThrow();
  });
});
