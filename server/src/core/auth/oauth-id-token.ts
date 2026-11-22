export interface IdTokenUser {
  name?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
  image?: string | null;
}

export function idTokenProfileClaims(user: IdTokenUser, scopes: readonly string[]): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  if (scopes.includes("profile")) {
    const parts = (user.name ?? "").split(" ").filter((part) => part !== "");
    claims.name = user.name ?? undefined;
    claims.picture = user.image ?? undefined;
    claims.given_name = parts.length > 1 ? parts.slice(0, -1).join(" ") : undefined;
    claims.family_name = parts.length > 1 ? parts.at(-1) : undefined;
  }
  if (scopes.includes("email")) {
    claims.email = user.email ?? undefined;
    claims.email_verified = user.emailVerified ?? false;
  }
  return claims;
}
