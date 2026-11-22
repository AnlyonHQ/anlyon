export function returnPathFromVerificationUrl(verificationUrl: string): string | undefined {
  let callback: string | null;
  try {
    callback = new URL(verificationUrl).searchParams.get("callbackURL");
  } catch {
    return undefined;
  }
  if (!callback || !callback.startsWith("/") || callback.startsWith("//") || callback.includes("\\")) return undefined;
  const base = "http://console.invalid";
  let parsed: URL;
  try {
    parsed = new URL(callback, base);
  } catch {
    return undefined;
  }
  if (parsed.origin !== base || parsed.pathname === "/" || parsed.pathname.startsWith("/auth/")) return undefined;
  return `${parsed.pathname}${parsed.search}`;
}

export function authorizeQueryFromVerificationUrl(verificationUrl: string): string | undefined {
  let callback: string | null;
  try {
    callback = new URL(verificationUrl).searchParams.get("callbackURL");
  } catch {
    return undefined;
  }
  if (!callback || !callback.startsWith("/") || callback.startsWith("//")) return undefined;

  const base = "http://console.invalid";
  let parsed: URL;
  try {
    parsed = new URL(callback, base);
  } catch {
    return undefined;
  }
  if (parsed.origin !== base || parsed.pathname !== "/auth/login") return undefined;

  const query = parsed.searchParams;
  if (!query.get("client_id") || !query.get("sig") || !query.get("exp")) return undefined;
  return query.toString();
}
