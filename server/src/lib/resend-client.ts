import { Resend } from "resend";
import { createTransport, type Transporter } from "nodemailer";
import { env } from "../config/env.ts";
import { instanceSetting } from "../core/instance/settings.ts";

export type MailTransport = "resend" | "smtp" | "none";

export function mailTransport(): MailTransport {
  if (env.RESEND_API_KEY) return "resend";
  if (instanceSetting("email.smtp_url")) return "smtp";
  return "none";
}

export function fromAddress(): string | undefined {
  return instanceSetting("email.from");
}

export function isEmailConfigured(): boolean {
  return mailTransport() !== "none" && Boolean(fromAddress());
}

export interface OutgoingEmail {
  from?: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

let resend: Resend | null = null;
let smtp: { url: string; transport: Transporter } | null = null;

function smtpTransport(): Transporter {
  const url = instanceSetting("email.smtp_url") ?? "";
  if (smtp?.url !== url) {
    smtp?.transport.close();
    smtp = { url, transport: createTransport(url) };
  }
  return smtp.transport;
}

async function send(outgoing: OutgoingEmail): Promise<{ id: string | null }> {
  const message = { ...outgoing, from: outgoing.from || fromAddress() || "" };
  switch (mailTransport()) {
    case "resend": {
      resend ??= new Resend(env.RESEND_API_KEY);
      const { data, error } = await resend.emails.send(message);
      return { id: error ? null : (data?.id ?? null) };
    }
    case "smtp": {
      const info = await smtpTransport().sendMail(message);
      return { id: info.messageId ?? null };
    }
    case "none":
      throw new Error("Email is not configured: set an SMTP server and a sender address in the instance settings");
  }
}

export const resendClient = { emails: { send } };
