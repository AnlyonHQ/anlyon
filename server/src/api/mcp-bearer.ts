import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type JWTVerifyOptions } from "jose";
import { mcpUnauthorized } from "./mcp-challenge.ts";

export interface McpVerifyOptions {
  jwksUrl: string;
  verifyOptions: JWTVerifyOptions & { audience: string; issuer: string };
}

const KEY_SET_FAILURES = new Set<string>([errors.JWKSTimeout.code, errors.JWKSInvalid.code, errors.JWKSMultipleMatchingKeys.code]);

export function tokenRefusal(error: unknown): string | null {
  if (error instanceof errors.JWTExpired) return "token expired";
  if (error instanceof errors.JOSEError) {
    if (KEY_SET_FAILURES.has(error.code) || error.code === errors.JOSEError.code) return null;
    return "invalid access token";
  }
  return null;
}

function bearerOf(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? undefined;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : authorization;
}

function isJws(token: string): boolean {
  try {
    decodeProtectedHeader(token);
    return true;
  } catch {
    return false;
  }
}

function isUnsigned(token: string): boolean {
  const { alg } = decodeProtectedHeader(token);
  return !alg || alg.toLowerCase() === "none";
}

export function mcpHandler(
  options: McpVerifyOptions,
  handler: (request: Request, jwt: JWTPayload) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (request) => {
    const token = bearerOf(request);
    if (!token) return mcpUnauthorized("missing authorization header");
    if (!isJws(token)) return mcpUnauthorized("no token payload");
    if (isUnsigned(token)) return mcpUnauthorized("invalid access token");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, options.verifyOptions));
    } catch (error) {
      const refusal = tokenRefusal(error);
      if (refusal) return mcpUnauthorized(refusal);
      throw error;
    }
    if (payload.azp) payload.client_id = payload.azp;
    return handler(request, payload);
  };
}
