import type { Context, Next } from "hono";
import { CONNECT_PAGE_PATHS, connectPagesHost } from "../core/connections/consent-urls.ts";
import { sendConnectPage } from "./connect-pages/send.ts";
import { notFoundView } from "./connect-pages/views.ts";

const PAGE_PATHS = new Set<string>(CONNECT_PAGE_PATHS);

export function onConnectPagesHost(c: Context): boolean {
  const host = connectPagesHost();
  if (!host) return false;
  try {
    return new URL(c.req.url).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export async function connectPagesHostGate(c: Context, next: Next) {
  if (!onConnectPagesHost(c)) return next();
  const path = c.req.path.replace(/\/+$/, "") || "/";
  if (PAGE_PATHS.has(path) && (c.req.method === "GET" || c.req.method === "HEAD" || (c.req.method === "POST" && path === "/key"))) {
    return next();
  }
  return sendConnectPage(c, notFoundView());
}
