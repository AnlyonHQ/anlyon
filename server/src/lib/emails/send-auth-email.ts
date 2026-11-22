import { logger } from "../logger.ts";
import {
  getVerificationEmailTemplate,
  getPasswordResetEmailTemplate,
  getPasswordChangedEmailTemplate,
  getWelcomeEmailTemplate,
} from "./auth-email-templates.ts";
import { fromAddress, isEmailConfigured, resendClient as resend } from "../resend-client.ts";

export async function sendVerificationEmail(data: {
  email: string;
  userName: string;
  verificationUrl: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn("Email configuration missing, skipping verification email");
    return;
  }

  try {
    const template = getVerificationEmailTemplate({
      userName: data.userName,
      verificationUrl: data.verificationUrl,
    });

    await resend.emails.send({
      from: fromAddress(),
      to: data.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    logger.info({ email: data.email }, "Verification email sent");
  } catch (error) {
    logger.error({ email: data.email, error }, "Failed to send verification email");
    throw error;
  }
}

export async function sendPasswordResetEmail(data: {
  email: string;
  userName: string;
  resetUrl: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn("Email configuration missing, skipping password reset email");
    return;
  }
  try {
    const template = getPasswordResetEmailTemplate({
      userName: data.userName,
      resetUrl: data.resetUrl,
    });

    await resend.emails.send({
      from: fromAddress(),
      to: data.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    logger.info({ email: data.email }, "Password reset email sent");
  } catch (error) {
    logger.error({ email: data.email, error }, "Failed to send password reset email");
    throw error;
  }
}

export async function sendPasswordChangedEmail(data: {
  email: string;
  userName: string;
  ipAddress?: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn("Email configuration missing, skipping password changed email");
    return;
  }

  try {
    const template = getPasswordChangedEmailTemplate({
      userName: data.userName,
      userEmail: data.email,
      changeTime: new Date(),
      ipAddress: data.ipAddress,
    });

    await resend.emails.send({
      from: fromAddress(),
      to: data.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    logger.info({ email: data.email }, "Password changed notification sent");
  } catch (error) {
    logger.error({ email: data.email, error }, "Failed to send password changed email");
    throw error;
  }
}

export async function sendWelcomeEmail(data: {
  email: string;
  userName: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn("Email configuration missing, skipping welcome email");
    return;
  }

  try {
    const template = getWelcomeEmailTemplate({
      userName: data.userName,
      userEmail: data.email,
    });

    await resend.emails.send({
      from: fromAddress(),
      to: data.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    logger.info({ email: data.email }, "Welcome email sent");
  } catch (error) {
    logger.error({ email: data.email, error }, "Failed to send welcome email");
  }
}
