import { env } from "../../config/env.ts";
import { escapeHtml } from "../../utils/html.ts";

export const EMAIL_COLORS = {
  primary: "#171717",
  primaryForeground: "#fafafa",
  brand: "#16A34A",
  bg: "#ffffff",
  text: "#0a0a0a",
  body: "#555555",
  muted: "#555555",
  subtle: "#888888",
  border: "#ededed",
  panel: "#f5f5f5",
};

export const EMAIL_LOGO_URL = `${(env.API_BASE_URL || env.BETTER_AUTH_URL).replace(/\/$/, "")}/assets/anlyon-logo.png`;

export function emailShell(content: string, title = "Anlyon"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.bg};font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${EMAIL_COLORS.bg};">
    <tr>
      <td style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
          ${content}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

export function emailHeader(): string {
  return `
  <tr>
    <td style="padding:0 0 22px;border-bottom:1px solid ${EMAIL_COLORS.border};">
      <a href="https://anlyon.com" style="text-decoration:none;">
        <img src="${EMAIL_LOGO_URL}" width="32" height="32" alt="Anlyon" style="display:block;border:0;outline:none;text-decoration:none;height:32px;width:32px;">
      </a>
    </td>
  </tr>`;
}

export function emailBody(content: string): string {
  return `
  <tr>
    <td style="padding:28px 0;">
      ${content}
    </td>
  </tr>`;
}

export function emailFooter(note?: string): string {
  const safeNote = note ? escapeHtml(note) : "";

  return `
  <tr>
    <td style="padding:22px 0 0;border-top:1px solid ${EMAIL_COLORS.border};">
      ${safeNote ? `<p style="margin:0 0 10px;font-size:13px;line-height:20px;color:${EMAIL_COLORS.muted};">${safeNote}</p>` : ""}
      <p style="margin:0;font-size:12px;line-height:18px;color:${EMAIL_COLORS.subtle};">© ${new Date().getFullYear()} Anlyon · <a href="https://anlyon.com" style="color:${EMAIL_COLORS.subtle};text-decoration:none;">anlyon.com</a></p>
    </td>
  </tr>`;
}

export function primaryButton(label: string, url: string): string {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label);

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="border-radius:12px;background-color:${EMAIL_COLORS.primary};">
        <a href="${safeUrl}" style="display:inline-block;padding:9px 16px;color:${EMAIL_COLORS.primaryForeground};text-decoration:none;font-weight:600;font-size:14px;line-height:20px;">${safeLabel}</a>
      </td>
    </tr>
  </table>`;
}

export function fallbackLink(url: string): string {
  const safeUrl = escapeHtml(url);

  return `
  <div style="margin-top:22px;padding-top:18px;border-top:1px solid ${EMAIL_COLORS.border};">
    <p style="margin:0 0 6px;font-size:12px;line-height:18px;color:${EMAIL_COLORS.muted};">Button not working? Paste this into your browser:</p>
    <p style="margin:0;font-size:12px;line-height:18px;color:${EMAIL_COLORS.brand};word-break:break-all;">${safeUrl}</p>
  </div>`;
}

export function neutralPanel(content: string): string {
  return `
  <div style="padding:14px 16px;background-color:${EMAIL_COLORS.panel};border:1px solid ${EMAIL_COLORS.border};border-radius:12px;">
    ${content}
  </div>`;
}
