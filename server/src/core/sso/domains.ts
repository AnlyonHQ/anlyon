import { resolveTxt as nodeResolveTxt } from "node:dns/promises";
import { ValidationError } from "../../utils/errors.ts";

export const DOMAIN_VERIFICATION_LABEL = "_anlyon-sso";
const RECORD_PREFIX = "anlyon-sso-verification=";

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

export function normalizeDomains(domains: string[]): string[] {
  const out = [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
  if (out.length === 0) throw new ValidationError("At least one email domain is required");
  if (out.length > 20) throw new ValidationError("At most 20 email domains per workspace");
  for (const domain of out) {
    if (!HOSTNAME.test(domain)) throw new ValidationError(`"${domain}" is not a valid domain`);
  }
  return out;
}

export function verificationRecord(domain: string, token: string): { name: string; type: "TXT"; value: string } {
  return { name: `${DOMAIN_VERIFICATION_LABEL}.${domain}`, type: "TXT", value: `${RECORD_PREFIX}${token}` };
}

export type ResolveTxt = (hostname: string) => Promise<string[][]>;

export async function unverifiedDomains(
  domains: string[],
  token: string,
  resolveTxt: ResolveTxt = nodeResolveTxt,
): Promise<string[]> {
  const missing: string[] = [];
  for (const domain of domains) {
    const { name, value } = verificationRecord(domain, token);
    let records: string[] = [];
    try {
      records = (await resolveTxt(name)).map((chunks) => chunks.join("").trim());
    } catch {
      records = [];
    }
    if (!records.includes(value)) missing.push(domain);
  }
  return missing;
}
