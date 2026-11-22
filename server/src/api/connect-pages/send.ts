import type { Context } from "hono";
import { connectPageCsp, renderConnectPage, type ConnectPageView } from "./render.ts";

export function connectPageHeaders(c: Context): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

export function sendConnectPage(c: Context, view: ConnectPageView) {
  connectPageHeaders(c);
  c.header("Content-Security-Policy", connectPageCsp(view));
  c.header("X-Frame-Options", "DENY");
  return c.html(renderConnectPage(view), view.status);
}
