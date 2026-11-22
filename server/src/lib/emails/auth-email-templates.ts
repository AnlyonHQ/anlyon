import { escapeHtml } from "../../utils/html.ts";
import {
  EMAIL_COLORS,
  emailBody,
  emailFooter,
  emailHeader,
  emailShell,
  fallbackLink,
  neutralPanel,
  primaryButton,
} from "./shared-email-template.ts";

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

function renderEmail(content: string, footerNote?: string, title?: string): string {
  return emailShell(`${emailHeader()}${emailBody(content)}${emailFooter(footerNote)}`, title);
}

function heading(title: string): string {
  return `<h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;color:${EMAIL_COLORS.text};letter-spacing:-0.3px;">${title}</h1>`;
}

function greeting(name: string): string {
  return `<p style="margin:0 0 20px;font-size:15px;line-height:24px;color:${EMAIL_COLORS.muted};">Hi ${escapeHtml(name)},</p>`;
}

function bodyText(content: string, margin = "0"): string {
  return `<p style="margin:${margin};font-size:15px;line-height:24px;color:${EMAIL_COLORS.body};">${content}</p>`;
}

export function getVerificationEmailTemplate(data: {
  userName: string;
  verificationUrl: string;
}): EmailTemplate {
  const { userName, verificationUrl } = data;
  const name = userName || "there";

  const subject = "Confirm your Anlyon email";

  const bodyContent = `
    ${heading("Confirm your email")}
    ${greeting(name)}
    ${bodyText("Verify your email address to finish setting up your Anlyon workspace.")}
    ${primaryButton("Verify email", verificationUrl)}
    ${bodyText("This link expires in 1 hour. If you did not sign up for Anlyon, you can safely ignore this email.", "0")}
    ${fallbackLink(verificationUrl)}
  `;

  const html = renderEmail(bodyContent, undefined, subject);

  const text = `
Anlyon - Confirm your email

Hi ${name},

Verify your email address to finish setting up your Anlyon workspace:

${verificationUrl}

This link expires in 1 hour. If you did not sign up for Anlyon, ignore this email.

© ${new Date().getFullYear()} Anlyon · anlyon.com
  `.trim();

  return { subject, html, text };
}

export function getPasswordResetEmailTemplate(data: {
  userName: string;
  resetUrl: string;
}): EmailTemplate {
  const { userName, resetUrl } = data;
  const name = userName || "there";

  const subject = "Reset your Anlyon password";

  const bodyContent = `
    ${heading("Reset your password")}
    ${greeting(name)}
    ${bodyText("We received a request to reset your Anlyon password. Use the button below to choose a new one. This link is valid for 1 hour.")}
    ${primaryButton("Reset password", resetUrl)}
    ${neutralPanel(`<p style="margin:0;font-size:13px;line-height:20px;color:${EMAIL_COLORS.body};"><strong>Did not request this?</strong> No action is needed. Your password has not changed. If you are concerned, contact <a href="mailto:support@anlyon.com" style="color:${EMAIL_COLORS.brand};text-decoration:none;">support@anlyon.com</a>.</p>`)}
    ${fallbackLink(resetUrl)}
  `;

  const html = renderEmail(bodyContent, undefined, subject);

  const text = `
Anlyon - Reset your password

Hi ${name},

We received a request to reset your Anlyon password. Use the link below. It is valid for 1 hour:

${resetUrl}

Did not request this? No action is needed. Your password has not changed.
If you are concerned, reach us at support@anlyon.com.

© ${new Date().getFullYear()} Anlyon · anlyon.com
  `.trim();

  return { subject, html, text };
}

export function getPasswordChangedEmailTemplate(data: {
  userName: string;
  userEmail: string;
  changeTime: Date;
  ipAddress?: string;
}): EmailTemplate {
  const { userName, userEmail, changeTime, ipAddress } = data;
  const name = userName || "there";
  const safeUserEmail = escapeHtml(userEmail);

  const subject = "Your Anlyon password was changed";

  const formattedTime = changeTime.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const safeFormattedTime = escapeHtml(formattedTime);
  const rawIp = typeof ipAddress === "string" ? ipAddress : "";
  const cleanIp = /^[0-9a-fA-F:.]{1,45}$/.test(rawIp) ? rawIp : "";
  const safeIp = escapeHtml(cleanIp);

  const details = neutralPanel(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:20px;color:${EMAIL_COLORS.text};">
      <tr>
        <td style="padding:3px 0;width:96px;color:${EMAIL_COLORS.muted};">Account</td>
        <td style="padding:3px 0;font-weight:600;">${safeUserEmail}</td>
      </tr>
      <tr>
        <td style="padding:3px 0;color:${EMAIL_COLORS.muted};">Changed at</td>
        <td style="padding:3px 0;font-weight:600;">${safeFormattedTime}</td>
      </tr>
      ${safeIp ? `
      <tr>
        <td style="padding:3px 0;color:${EMAIL_COLORS.muted};">IP address</td>
        <td style="padding:3px 0;font-weight:600;">${safeIp}</td>
      </tr>` : ""}
    </table>
  `);

  const bodyContent = `
    ${heading("Password changed")}
    ${greeting(name)}
    ${bodyText("Your Anlyon password was updated successfully.", "0 0 22px")}
    ${details}
    <div style="height:20px;line-height:20px;">&nbsp;</div>
    ${neutralPanel(`<p style="margin:0;font-size:13px;line-height:20px;color:${EMAIL_COLORS.body};"><strong>Was not you?</strong> Reset your password immediately and contact <a href="mailto:support@anlyon.com" style="color:${EMAIL_COLORS.brand};text-decoration:none;">support@anlyon.com</a>.</p>`)}
  `;

  const html = renderEmail(bodyContent, "This is a security notification for your account.", subject);

  const text = `
Anlyon - Password changed

Hi ${name},

Your Anlyon password was updated successfully.

Account: ${userEmail}
Changed at: ${formattedTime}${cleanIp ? `\nIP address: ${cleanIp}` : ""}

Was not you? Reset your password and contact support@anlyon.com immediately.

© ${new Date().getFullYear()} Anlyon · anlyon.com
  `.trim();

  return { subject, html, text };
}

export function getWelcomeEmailTemplate(data: {
  userName: string;
  userEmail: string;
}): EmailTemplate {
  const { userName } = data;
  const name = userName || "there";
  const safeName = escapeHtml(name);

  const subject = "Welcome to Anlyon";

  const stepStyle = `font-size:14px;line-height:22px;color:${EMAIL_COLORS.body};`;
  const bodyContent = `
    ${heading(`Welcome, ${safeName}.`)}
    ${bodyText("Your Anlyon workspace is ready. Use these steps to invoke your first action and see every call it makes.", "0 0 24px")}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;">
      <tr>
        <td style="padding:0 0 14px;width:28px;vertical-align:top;font-weight:700;color:${EMAIL_COLORS.text};${stepStyle}">1.</td>
        <td style="padding:0 0 14px;vertical-align:top;${stepStyle}"><strong style="color:${EMAIL_COLORS.text};">Generate an API key</strong><br><span style="color:${EMAIL_COLORS.muted};">Open Settings, then API Keys.</span></td>
      </tr>
      <tr>
        <td style="padding:0 0 14px;width:28px;vertical-align:top;font-weight:700;color:${EMAIL_COLORS.text};${stepStyle}">2.</td>
        <td style="padding:0 0 14px;vertical-align:top;${stepStyle}"><strong style="color:${EMAIL_COLORS.text};">Define an action and invoke it</strong><br><span style="color:${EMAIL_COLORS.muted};">Wrap a real endpoint once, with its credential referenced from your secrets, then invoke it by name.</span></td>
      </tr>
      <tr>
        <td style="padding:0;width:28px;vertical-align:top;font-weight:700;color:${EMAIL_COLORS.text};${stepStyle}">3.</td>
        <td style="padding:0;vertical-align:top;${stepStyle}"><strong style="color:${EMAIL_COLORS.text};">Review what happened</strong><br><span style="color:${EMAIL_COLORS.muted};">See invocations, approvals, and logs in the dashboard.</span></td>
      </tr>
    </table>

    ${primaryButton("Open dashboard", "https://console.anlyon.com")}

    <div style="margin-top:24px;padding-top:22px;border-top:1px solid ${EMAIL_COLORS.border};">
      <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:${EMAIL_COLORS.text};">Useful links</p>
      <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:${EMAIL_COLORS.muted};"><a href="https://docs.anlyon.com/quickstart" style="color:${EMAIL_COLORS.brand};text-decoration:none;font-weight:600;">Quickstart guide</a> - invoke your first action</p>
      <p style="margin:0 0 8px;font-size:14px;line-height:22px;color:${EMAIL_COLORS.muted};"><a href="https://docs.anlyon.com/sdks/typescript" style="color:${EMAIL_COLORS.brand};text-decoration:none;font-weight:600;">TypeScript SDK</a> - @anlyonhq/sdk on npm</p>
      <p style="margin:0;font-size:14px;line-height:22px;color:${EMAIL_COLORS.muted};"><a href="https://docs.anlyon.com/trust-control/approvals" style="color:${EMAIL_COLORS.brand};text-decoration:none;font-weight:600;">Approvals</a> - hold a sensitive action until a person decides</p>
    </div>
  `;

  const html = renderEmail(bodyContent, "Questions? Reply to this email or reach us at support@anlyon.com", subject);

  const text = `
Welcome to Anlyon, ${name}.

Your Anlyon workspace is ready. Use these steps to invoke your first action and see every call it makes.

GET STARTED IN 3 STEPS:

1. Generate an API key
   Open Settings, then API Keys.

2. Define an action and invoke it
   Wrap a real endpoint once, with its credential referenced from your secrets, then invoke it by name.

3. Review what happened
   See invocations, approvals, and logs in the dashboard.

Open dashboard: https://console.anlyon.com

USEFUL LINKS:
- Quickstart guide (invoke your first action): https://docs.anlyon.com/quickstart
- TypeScript SDK (@anlyonhq/sdk): https://docs.anlyon.com/sdks/typescript
- Approvals: https://docs.anlyon.com/trust-control/approvals

Questions? Reply to this email or reach us at support@anlyon.com

© ${new Date().getFullYear()} Anlyon · anlyon.com
  `.trim();

  return { subject, html, text };
}
