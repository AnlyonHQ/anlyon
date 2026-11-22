import { URL } from "url";
import dns from "dns/promises";
import type { LookupAddress } from "dns";
import net from "net";

const PRIVATE_IPV4_RANGES = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^192\.168\./,
  /^198\.(1[8-9])\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^22[4-9]\./,
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
];

const PRIVATE_IPV6_RANGES = [
  /^::1$/,
  /^::$/,
  /^::ffff:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
  /^ff[0-9a-f]{2}:/i,
];

export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export async function lookupWithTimeout(hostname: string, timeoutMs: number = DNS_LOOKUP_TIMEOUT_MS): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DNS lookup of ${hostname} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([dns.lookup(hostname, { all: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const BLOCKED_PROTOCOLS = ["file:", "ftp:", "gopher:", "data:"];
const BLOCKED_HOSTS = ["localhost", "0.0.0.0", "[::]", "[::1]"];

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  resolvedIps?: string[];
}

export function ipv6Hextets(ip: string): number[] | null {
  let address = ip.toLowerCase().split("%")[0];
  const dotted = address.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    address = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((hextet) => Number.parseInt(hextet, 16)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const hextets = [...head, ...new Array<number>(fill).fill(0), ...tail];
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : null;
}

export function embeddedIpv4(h: number[]): string | null {
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  const mapped = zeros(0, 5) && h[5] === 0xffff;
  const siit = zeros(0, 4) && h[4] === 0xffff && h[5] === 0;
  const compatible = zeros(0, 6) && h[6] !== 0;
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && (zeros(2, 6) || h[2] === 1);
  if (h[0] === 0x2002) return [h[1] >> 8, h[1] & 0xff, h[2] >> 8, h[2] & 0xff].join(".");
  if (!mapped && !siit && !compatible && !nat64) return null;
  return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join(".");
}

function isReservedIpv6(h: number[]): boolean {
  if (h.slice(0, 7).every((x) => x === 0) && h[7] <= 1) return true;
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;
  return h[0] === 0x2001 && h[1] === 0;
}

export function isPrivateIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return isPrivateIp(mapped[1]);

  if (net.isIPv4(ip)) {
    return PRIVATE_IPV4_RANGES.some((r) => r.test(ip)) || ip === "127.0.0.1";
  }
  if (net.isIPv6(ip)) {
    if (PRIVATE_IPV6_RANGES.some((r) => r.test(ip))) return true;
    const hextets = ipv6Hextets(ip);
    if (!hextets) return true;
    if (isReservedIpv6(hextets)) return true;
    const v4 = embeddedIpv4(hextets);
    return v4 !== null && isPrivateIp(v4);
  }
  return true;
}

export function validateUrl(urlString: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(urlString);

    if (BLOCKED_PROTOCOLS.includes(url.protocol)) {
      return { valid: false, error: "Protocol not allowed" };
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return { valid: false, error: "Only HTTP and HTTPS protocols are allowed" };
    }
    if (BLOCKED_HOSTS.includes(url.hostname.toLowerCase())) {
      return { valid: false, error: "Localhost and internal addresses are not allowed" };
    }
    if (url.hostname.includes("metadata") || url.hostname.includes("169.254.169.254")) {
      return { valid: false, error: "Metadata endpoints are not allowed" };
    }

    if (net.isIP(url.hostname) && isPrivateIp(url.hostname)) {
      return { valid: false, error: "Private IP addresses are not allowed" };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

export async function resolveAndValidateUrl(urlString: string): Promise<UrlValidationResult> {
  const basic = validateUrl(urlString);
  if (!basic.valid) return { valid: false, error: basic.error };

  try {
    const url = new URL(urlString);

    if (net.isIP(url.hostname)) {
      if (isPrivateIp(url.hostname)) {
        return { valid: false, error: "Private IP addresses are not allowed" };
      }
      return { valid: true, resolvedIps: [url.hostname] };
    }

    const addresses = await lookupWithTimeout(url.hostname);
    if (!addresses.length) {
      return { valid: false, error: "Failed to resolve hostname" };
    }

    const safeIps: string[] = [];
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return { valid: false, error: "Private IP addresses are not allowed" };
      }
      safeIps.push(addr.address);
    }

    return { valid: true, resolvedIps: safeIps };
  } catch {
    return { valid: false, error: "Failed to resolve hostname" };
  }
}
