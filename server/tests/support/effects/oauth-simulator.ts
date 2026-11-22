import { randomBytes } from "node:crypto";
import { OAUTH_APPS } from "../../../src/core/connections/oauth-apps.ts";
import type { ConnectionProvider } from "../../../src/core/connections/types.ts";

export const OAUTH_SIM_CLIENT = { clientId: "sim-client-id-0001", clientSecret: "sim_client_secret_0000000000000000" };
export const OAUTH_SIM_ORIGIN = "https://api.anlyon.test";
export const OAUTH_SIM_ENCRYPTION_KEY = "test-connections-encryption-key-32chars";

export type OAuthFault = "unreachable" | "http_500";

interface Grant {
  accessToken: string;
  refreshToken: string;
  revoked: boolean;
  spent: Set<string>;
}

const hubspot = OAUTH_APPS.hubspot;
const sim = (n: number) => randomBytes(n).toString("hex");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class OAuthProviderSimulator {
  readonly grants: Grant[] = [];
  readonly codes = new Map<string, { redirectUri: string; challenge: string | null; grant: Grant }>();
  readonly requests: Array<{ url: string; method: string; body: string; authorization: string }> = [];
  readonly faults: { token: OAuthFault[]; revoke: OAuthFault[] } = { token: [], revoke: [] };
  refreshes = 0;
  revocations = 0;

  constructor(readonly options: { rotate?: boolean; expiresIn?: number } = {}) {}

  fault(where: "token" | "revoke", fault: OAuthFault) {
    this.faults[where].push(fault);
    return this;
  }

  approve(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    if (`${url.origin}${url.pathname}` !== hubspot.authorizeUrl) throw new Error(`not the authorize URL: ${authorizeUrl}`);
    if (url.searchParams.get("client_id") !== OAUTH_SIM_CLIENT.clientId) throw new Error("wrong client_id");
    const redirectUri = url.searchParams.get("redirect_uri")!;
    const grant: Grant = { accessToken: `sim_access_${sim(12)}`, refreshToken: `sim_refresh_${sim(12)}`, revoked: false, spent: new Set() };
    this.grants.push(grant);
    const code = `sim_code_${sim(8)}`;
    this.codes.set(code, { redirectUri, challenge: url.searchParams.get("code_challenge"), grant });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state")!);
    return back.toString();
  }

  deny(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", url.searchParams.get("state")!);
    return back.toString();
  }

  revoke(grant: Grant = this.grants.at(-1)!) {
    grant.revoked = true;
    return this;
  }

  latest(): Grant {
    return this.grants.at(-1)!;
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = new URLSearchParams(init.body ?? "");
    this.requests.push({ url, method: init.method ?? "GET", body: init.body ?? "", authorization: headers.authorization ?? "" });

    if (url === hubspot.tokenUrl) {
      const fault = this.faults.token.shift();
      if (fault === "unreachable") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (fault === "http_500") return json(500, { status: "error", message: `boom ${OAUTH_SIM_CLIENT.clientSecret}` });
      if (body.get("client_id") !== OAUTH_SIM_CLIENT.clientId || body.get("client_secret") !== OAUTH_SIM_CLIENT.clientSecret) {
        return json(401, { error: "invalid_client" });
      }
      if (body.get("grant_type") === "authorization_code") {
        const issued = this.codes.get(body.get("code") ?? "");
        if (!issued || issued.redirectUri !== body.get("redirect_uri")) return json(400, { error: "invalid_grant", status: "BAD_AUTH_CODE" });
        this.codes.delete(body.get("code")!);
        return this.tokenAnswer(issued.grant);
      }
      if (body.get("grant_type") === "refresh_token") {
        const presented = body.get("refresh_token") ?? "";
        const grant = this.grants.find((g) => g.refreshToken === presented || g.spent.has(presented));
        if (!grant || grant.revoked || grant.spent.has(presented)) {
          return json(400, { error: "invalid_grant", status: "BAD_REFRESH_TOKEN", message: `missing or unknown refresh token ${presented}` });
        }
        this.refreshes++;
        grant.accessToken = `sim_access_${sim(12)}`;
        if (this.options.rotate) {
          grant.spent.add(grant.refreshToken);
          grant.refreshToken = `sim_refresh_${sim(12)}`;
        }
        return this.tokenAnswer(grant, this.options.rotate === true);
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (url === hubspot.revoke!.url) {
      const fault = this.faults.revoke.shift();
      if (fault === "unreachable") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (fault === "http_500") return json(500, { message: "boom" });
      const grant = this.grants.find((g) => g.refreshToken === body.get("token"));
      if (grant) grant.revoked = true;
      this.revocations++;
      return new Response(null, { status: 204 });
    }

    return json(404, { message: "not found" });
  };

  private tokenAnswer(grant: Grant, withRefresh = true): Response {
    return json(200, {
      token_type: "bearer",
      access_token: grant.accessToken,
      ...(withRefresh ? { refresh_token: grant.refreshToken } : {}),
      expires_in: this.options.expiresIn ?? 1800,
      hub_id: 4242,
      scopes: ["crm.objects.contacts.read"],
    });
  }
}

export async function consentDirectly(
  provider: ConnectionProvider,
  simulator: OAuthProviderSimulator,
  scope: { workspaceId: string; environmentId: string },
  sessionId = `csn_${sim(8)}`,
) {
  const endUserId = `ws_${scope.workspaceId}:env_${scope.environmentId}:${sessionId}`;
  const { sessionToken } = await provider.createConnectSession({ endUserId, integrationKey: "hubspot" });
  const authorizeUrl = await provider.beginConsent(sessionToken);
  const back = new URL(simulator.approve(authorizeUrl!));
  const result = await provider.finishConsent({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: null });
  if (!result.ok) throw new Error(`consent failed: ${result.reason}`);
  return { connectionId: result.outcome.connectionId, grant: simulator.latest(), endUserId };
}
