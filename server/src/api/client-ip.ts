export function trustedClientIp(header: (name: string) => string | undefined): string | undefined {
  const forwarded = header("x-forwarded-for")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const last = forwarded?.at(-1);
  if (last) return last;
  return header("x-real-ip")?.trim() || undefined;
}
