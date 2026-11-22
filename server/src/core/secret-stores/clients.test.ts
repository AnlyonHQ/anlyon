import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const transports = vi.hoisted(() => ({ safeFetch: vi.fn(), undiciFetch: vi.fn() }));
vi.mock("../../lib/safe-http.ts", () => ({ safeFetch: transports.safeFetch }));
vi.mock("undici", () => ({ fetch: transports.undiciFetch }));

const { storeHttp, StoreReadError, pickValue, defaultStoreFetch } = await import("./http.ts");
const { awsRead, awsCheck } = await import("./aws.ts");
const { vaultRead, vaultCheck, vaultPathIsValid } = await import("./vault.ts");
const { signAwsRequest, canonicalRequest } = await import("./sigv4.ts");
const { cacheClear } = await import("./cache.ts");

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[] = [];
let answers: Array<Response | Error> = [];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  answers = [];
  cacheClear();
  storeHttp.fetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = answers.shift();
    if (!next) throw new Error("unexpected store call");
    if (next instanceof Error) throw next;
    return next;
  });
});
afterEach(() => vi.useRealTimers());

const ctx = { cacheKey: "row-1|1", storeId: "sst_test", privateNetwork: false };
const awsKeys = { accessKeyId: "AKIDEXAMPLE0000000", secretAccessKey: "<your-secret-access-key>" };
const VALUE = "store_value_9f3a_not_a_key";

async function failure(promise: Promise<unknown>): Promise<InstanceType<typeof StoreReadError>> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StoreReadError);
  return error as InstanceType<typeof StoreReadError>;
}

describe("SigV4", () => {
  it("matches AWS's published worked example (IAM ListUsers, 2015-08-30)", () => {
    const input = {
      method: "GET" as const,
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      region: "us-east-1",
      service: "iam",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: ["wJalrXUtnFEMI", "K7MDENG+bPxRfiCYEXAMPLEKEY"].join("/") },
      now: new Date("2015-08-30T12:36:00Z"),
    };
    const { request } = canonicalRequest(input, { ...input.headers, host: "iam.amazonaws.com", "x-amz-date": "20150830T123600Z" });
    expect(crypto.createHash("sha256").update(request).digest("hex")).toBe("f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59");
    expect(signAwsRequest(input).authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("AWS Secrets Manager", () => {
  const config = { region: "eu-west-1", auth: "access_key" as const };

  it("signs one GetSecretValue call and returns the whole string when no key is named", async () => {
    answers.push(json(200, { SecretString: VALUE, VersionId: "v" }));
    await expect(awsRead(config, awsKeys, { path: "prod/stripe", key: null, version: null }, ctx)).resolves.toBe(VALUE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://secretsmanager.eu-west-1.amazonaws.com/", method: "POST" });
    expect(calls[0].headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE0000000\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request/);
    expect(JSON.parse(calls[0].body!)).toEqual({ SecretId: "prod/stripe" });
  });

  it("picks a JSON key, and sends a version id or a staging label as AWS names them", async () => {
    answers.push(json(200, { SecretString: JSON.stringify({ apiKey: VALUE, other: "x" }) }));
    answers.push(json(200, { SecretString: JSON.stringify({ apiKey: VALUE }) }));
    await expect(awsRead(config, awsKeys, { path: "p", key: "apiKey", version: "AWSPREVIOUS" }, ctx)).resolves.toBe(VALUE);
    await expect(awsRead(config, awsKeys, { path: "p", key: "apiKey", version: "a1b2c3d4-0000-4000-8000-000000000001" }, ctx)).resolves.toBe(VALUE);
    expect(JSON.parse(calls[0].body!)).toEqual({ SecretId: "p", VersionStage: "AWSPREVIOUS" });
    expect(JSON.parse(calls[1].body!)).toEqual({ SecretId: "p", VersionId: "a1b2c3d4-0000-4000-8000-000000000001" });
  });

  it("names each failure for the person who has to fix it", async () => {
    answers.push(json(400, { __type: "ResourceNotFoundException", message: "Secrets Manager can't find arn:aws:secretsmanager:..." }));
    expect((await failure(awsRead(config, awsKeys, { path: "p", key: null, version: null }, ctx))).reason).toBe("reference_not_found");
    answers.push(json(400, { __type: "AccessDeniedException" }));
    expect((await failure(awsRead(config, awsKeys, { path: "p", key: null, version: null }, ctx))).reason).toBe("store_denied");
    answers.push(json(400, {}, { "x-amzn-errortype": "UnrecognizedClientException:http://internal.amazon.com/" }));
    expect((await failure(awsRead(config, awsKeys, { path: "p", key: null, version: null }, ctx))).reason).toBe("store_denied");
    answers.push(json(503, {}));
    expect((await failure(awsRead(config, awsKeys, { path: "p", key: null, version: null }, ctx))).reason).toBe("store_unreachable");
    answers.push(new TypeError("fetch failed"));
    expect((await failure(awsRead(config, awsKeys, { path: "p", key: null, version: null }, ctx))).reason).toBe("store_unreachable");
    answers.push(json(200, { SecretString: JSON.stringify({ other: VALUE }) }));
    const missingKey = await failure(awsRead(config, awsKeys, { path: "p", key: "apiKey", version: null }, ctx));
    expect(missingKey.reason).toBe("reference_not_found");
    expect(missingKey.message).not.toContain(VALUE);
    answers.push(json(200, { SecretBinary: "AAAA" }));
    expect((await failure(awsRead(config, awsKeys, { path: "p", key: null, version: null }, ctx))).reason).toBe("reference_not_found");
  });

  it("assumes the role once, signs with its session, and reuses it until shortly before it expires", async () => {
    const roleConfig = { region: "us-east-1", auth: "assume_role" as const, roleArn: "arn:aws:iam::123456789012:role/anlyon-reader", externalId: "anlyon-ws-1" };
    const expiration = new Date(Date.now() + 15 * 60_000).toISOString();
    answers.push(new Response(
      `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIATEMPORARY0000</AccessKeyId><SecretAccessKey>&lt;your-temporary-key&gt;</SecretAccessKey><SessionToken>&lt;your-session-token&gt;</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      { status: 200 },
    ));
    answers.push(json(200, { SecretString: VALUE }));
    answers.push(json(200, { SecretString: VALUE }));
    await awsRead(roleConfig, awsKeys, { path: "p", key: null, version: null }, ctx);
    await awsRead(roleConfig, awsKeys, { path: "p", key: null, version: null }, ctx);
    expect(calls.map((c) => c.url)).toEqual([
      "https://sts.us-east-1.amazonaws.com/",
      "https://secretsmanager.us-east-1.amazonaws.com/",
      "https://secretsmanager.us-east-1.amazonaws.com/",
    ]);
    const sts = new URLSearchParams(calls[0].body!);
    expect(Object.fromEntries(sts)).toMatchObject({
      Action: "AssumeRole", RoleArn: roleConfig.roleArn, ExternalId: "anlyon-ws-1", RoleSessionName: "anlyon-sst_test", DurationSeconds: "900",
    });
    expect(calls[1].headers["x-amz-security-token"]).toBe("<your-session-token>");
    expect(calls[1].headers.authorization).toContain("Credential=ASIATEMPORARY0000/");
  });

  it("a refused AssumeRole is store_denied, and a check makes no secret read", async () => {
    answers.push(new Response("<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>", { status: 403 }));
    const roleConfig = { region: "us-east-1", auth: "assume_role" as const, roleArn: "arn:aws:iam::123456789012:role/r" };
    expect((await failure(awsCheck(roleConfig, awsKeys, ctx))).reason).toBe("store_denied");
    answers.push(new Response("<GetCallerIdentityResponse/>", { status: 200 }));
    await awsCheck(config, awsKeys, ctx);
    expect(new URLSearchParams(calls[1].body!).get("Action")).toBe("GetCallerIdentity");
  });
});

describe("HashiCorp Vault KV v2", () => {
  const tokenConfig = { address: "https://vault.example.com:8200", namespace: "team-a", mount: "secret", auth: "token" as const };
  const token = { token: "<your-vault-token>" };

  it("reads one key at the version named, with the token and namespace headers", async () => {
    answers.push(json(200, { data: { data: { apiKey: VALUE, other: "x" }, metadata: { version: 3 } } }));
    await expect(vaultRead(tokenConfig, token, { path: "payments/stripe", key: "apiKey", version: "3" }, ctx)).resolves.toBe(VALUE);
    expect(calls[0]).toMatchObject({ url: "https://vault.example.com:8200/v1/secret/data/payments/stripe?version=3", method: "GET" });
    expect(calls[0].headers).toMatchObject({ "x-vault-token": "<your-vault-token>", "x-vault-namespace": "team-a" });
  });

  it("names each failure, and a deleted version is not found", async () => {
    const loc = { path: "p", key: "k", version: null };
    answers.push(json(404, { errors: [] }));
    expect((await failure(vaultRead(tokenConfig, token, loc, ctx))).reason).toBe("reference_not_found");
    answers.push(json(403, { errors: ["permission denied"] }));
    expect((await failure(vaultRead(tokenConfig, token, loc, ctx))).reason).toBe("store_denied");
    answers.push(json(500, {}));
    expect((await failure(vaultRead(tokenConfig, token, loc, ctx))).reason).toBe("store_unreachable");
    answers.push(json(200, { data: { data: null, metadata: { deletion_time: "2026-10-01T00:00:00Z" } } }));
    expect((await failure(vaultRead(tokenConfig, token, loc, ctx))).reason).toBe("reference_not_found");
    answers.push(new Error("ECONNREFUSED"));
    expect((await failure(vaultRead(tokenConfig, token, loc, ctx))).reason).toBe("store_unreachable");
  });

  it("logs in with AppRole once, reuses the token, and logs in again when Vault refuses it early", async () => {
    const approle = { address: "https://vault.example.com", mount: "kv", auth: "approle" as const };
    const cred = { roleId: "role-id-placeholder", secretId: "secret-id-placeholder" };
    const loc = { path: "p", key: "k", version: null };
    answers.push(json(200, { auth: { client_token: "hvs.first", lease_duration: 3600 } }));
    answers.push(json(200, { data: { data: { k: VALUE } } }));
    answers.push(json(200, { data: { data: { k: VALUE } } }));
    answers.push(json(403, { errors: ["permission denied"] }));
    answers.push(json(200, { auth: { client_token: "hvs.second", lease_duration: 3600 } }));
    answers.push(json(200, { data: { data: { k: VALUE } } }));
    await vaultRead(approle, cred, loc, ctx);
    await vaultRead(approle, cred, loc, ctx);
    await vaultRead(approle, cred, loc, ctx);
    expect(calls.map((c) => c.url)).toEqual([
      "https://vault.example.com/v1/auth/approle/login",
      "https://vault.example.com/v1/kv/data/p",
      "https://vault.example.com/v1/kv/data/p",
      "https://vault.example.com/v1/kv/data/p",
      "https://vault.example.com/v1/auth/approle/login",
      "https://vault.example.com/v1/kv/data/p",
    ]);
    expect(JSON.parse(calls[0].body!)).toEqual({ role_id: "role-id-placeholder", secret_id: "secret-id-placeholder" });
    expect(calls[5].headers["x-vault-token"]).toBe("hvs.second");
  });

  it("a refused AppRole login is store_denied, and a check reads no secret", async () => {
    answers.push(json(400, { errors: ["invalid role or secret ID"] }));
    const approle = { address: "https://vault.example.com", mount: "secret", auth: "approle" as const };
    const failed = await failure(vaultCheck(approle, { roleId: "r", secretId: "s-placeholder" }, ctx));
    expect(failed.reason).toBe("store_denied");
    expect(failed.message).not.toContain("s-placeholder");
    answers.push(json(200, { data: { id: "x" } }));
    await vaultCheck(tokenConfig, token, ctx);
    expect(calls[1].url).toBe("https://vault.example.com:8200/v1/auth/token/lookup-self");
  });

  it("accepts only plain relative paths", () => {
    expect(vaultPathIsValid("payments/stripe")).toBe(true);
    for (const bad of ["", "/abs", "trailing/", "a//b", "a/../b", "a/./b", "a?b"]) expect(vaultPathIsValid(bad)).toBe(false);
  });
});

describe("pickValue", () => {
  it("takes strings, numbers and booleans, and refuses empty or nested values", () => {
    expect(pickValue({ a: "x1" }, "a")).toBe("x1");
    expect(pickValue({ a: 42 }, "a")).toBe("42");
    expect(() => pickValue({ a: "" }, "a")).toThrow(StoreReadError);
    expect(() => pickValue({ a: { b: 1 } }, "a")).toThrow(StoreReadError);
    expect(() => pickValue("not json", "a")).toThrow(StoreReadError);
    expect(() => pickValue({ a: "x" }, null)).toThrow(StoreReadError);
  });
});

describe("the store transport", () => {
  it("always goes through the SSRF guard; a private network only relaxes its range check", async () => {
    transports.safeFetch.mockResolvedValue(new Response("{}"));
    transports.undiciFetch.mockResolvedValue(new Response("{}"));
    await defaultStoreFetch("https://vault.example.com/v1/x", { method: "GET", headers: {} });
    expect(transports.safeFetch).toHaveBeenCalledTimes(1);
    expect(transports.safeFetch.mock.calls[0][2]).toEqual({ allowPrivateNetwork: false });
    expect(transports.safeFetch.mock.calls[0][1]).not.toHaveProperty("privateNetwork");

    await defaultStoreFetch("http://10.0.0.5:8200/v1/x", { method: "GET", headers: {}, privateNetwork: true });
    expect(transports.safeFetch).toHaveBeenCalledTimes(2);
    expect(transports.safeFetch.mock.calls[1][2]).toEqual({ allowPrivateNetwork: true });
    expect(transports.safeFetch.mock.calls[1][1]).not.toHaveProperty("privateNetwork");
    expect(transports.undiciFetch).not.toHaveBeenCalled();
  });

  it("tells Vault requests whether the private network is allowed", async () => {
    answers.push(json(200, { data: { data: { k: VALUE } } }));
    const original = storeHttp.fetch;
    const seen: unknown[] = [];
    storeHttp.fetch = vi.fn(async (url, init) => { seen.push(init.privateNetwork); return original(url, init); });
    await vaultRead({ address: "http://10.0.0.5:8200", mount: "secret", auth: "token" }, { token: "<your-vault-token>" },
      { path: "p", key: "k", version: null }, { ...ctx, privateNetwork: true });
    expect(seen).toEqual([true]);
  });
});
