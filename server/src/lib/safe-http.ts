import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import net from "net";
import { resolveAndValidateUrl, isPrivateIp, lookupWithTimeout, ipv6Hextets, embeddedIpv4 } from "../utils/url-validation.ts";

export interface SafeFetchResult {
  response: Response;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

type NodeFetchInit = Omit<UndiciRequestInit, "dispatcher">;

export interface SafeFetchOptions {
  allowPrivateNetwork?: boolean;
}

const AWS_IPV6_METADATA = [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254];

function isIpv4LinkLocalOrMetadata(ip: string): boolean {
  return /^169\.254\./.test(ip) || /^0\./.test(ip) || ip === "100.100.100.200";
}

export function isLinkLocalOrMetadata(ip: string): boolean {
  if (net.isIPv4(ip)) return isIpv4LinkLocalOrMetadata(ip);
  if (!net.isIPv6(ip)) return true;
  const hextets = ipv6Hextets(ip);
  if (!hextets) return true;
  const v4 = embeddedIpv4(hextets);
  if (v4 && isIpv4LinkLocalOrMetadata(v4)) return true;
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;
  if (hextets.every((h) => h === 0)) return true;
  return hextets.every((h, i) => h === AWS_IPV6_METADATA[i]);
}

export function isLoopback(ip: string): boolean {
  if (net.isIPv4(ip)) return /^127\./.test(ip);
  if (!net.isIPv6(ip)) return true;
  const hextets = ipv6Hextets(ip);
  if (!hextets) return true;
  const v4 = embeddedIpv4(hextets);
  if (v4) return /^127\./.test(v4);
  return hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
}

async function resolvePrivateNetworkUrl(urlString: string): Promise<{ valid: boolean; error?: string; resolvedIps?: string[] }> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { valid: false, error: "Only HTTP and HTTPS protocols are allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.includes("metadata")) return { valid: false, error: "Metadata endpoints are not allowed" };
  try {
    const addresses = net.isIP(host) ? [{ address: host }] : await lookupWithTimeout(host);
    if (addresses.length === 0) return { valid: false, error: "Failed to resolve hostname" };
    if (addresses.some((entry) => isLinkLocalOrMetadata(entry.address))) {
      return { valid: false, error: "Link-local and metadata addresses are not allowed" };
    }
    if (addresses.some((entry) => isLoopback(entry.address))) {
      return { valid: false, error: "Loopback addresses are not allowed" };
    }
    return { valid: true, resolvedIps: addresses.map((entry) => entry.address) };
  } catch {
    return { valid: false, error: "Failed to resolve hostname" };
  }
}

export async function safeFetch(
  url: string,
  init?: NodeFetchInit,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const validation = options.allowPrivateNetwork ? await resolvePrivateNetworkUrl(url) : await resolveAndValidateUrl(url);
  if (!validation.valid || !validation.resolvedIps || validation.resolvedIps.length === 0) {
    throw new SsrfBlockedError(validation.error || "URL failed SSRF validation");
  }
  if (validation.resolvedIps.some((ip) => isLinkLocalOrMetadata(ip))) {
    throw new SsrfBlockedError("Link-local and metadata addresses are not allowed");
  }
  const isBlocked = options.allowPrivateNetwork
    ? (ip: string) => isLinkLocalOrMetadata(ip) || isLoopback(ip)
    : (ip: string) => isPrivateIp(ip) || isLinkLocalOrMetadata(ip);

  const allowedIps = new Set(validation.resolvedIps);

  const orderedIps = [...validation.resolvedIps].sort(
    (a, b) => net.isIP(a) - net.isIP(b)
  );

  const agent = new Agent({
    connect: {
      lookup: (hostname, opts, cb) => {
        const answer = (ips: string[]) => {
          const entries = ips.map((ip) => ({
            address: ip,
            family: net.isIPv6(ip) ? 6 : 4,
          }));
          if ((opts as { all?: boolean }).all) {
            (cb as unknown as (err: Error | null, addrs: typeof entries) => void)(
              null,
              entries
            );
          } else {
            cb(null, entries[0].address, entries[0].family);
          }
        };

        if (net.isIP(hostname)) {
          if (!allowedIps.has(hostname) || isBlocked(hostname)) {
            return cb(new SsrfBlockedError(`Blocked IP at connect time: ${hostname}`), "", 0);
          }
          return answer([hostname]);
        }

        const safeIps = orderedIps.filter((ip) => !isBlocked(ip));
        if (safeIps.length === 0) {
          return cb(new SsrfBlockedError("No safe IP available at connect time"), "", 0);
        }
        answer(safeIps);
      },
    },
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
    connectTimeout: 10_000,
  });

  try {
    const response = await undiciFetch(url, {
      ...init,
      redirect: "error",
      dispatcher: agent,
    });
    return response as unknown as Response;
  } finally {
    agent.close().catch(() => {});
  }
}
