import { describe, expect, it } from "vitest";
import {
  toPublicNotification,
  toPublicNotificationPreferences,
} from "./notification-service.ts";

describe("toPublicNotificationPreferences", () => {
  it("never returns the stored webhook secret", () => {
    const publicPreferences = toPublicNotificationPreferences({
      id: "pref-id",
      workspaceId: "workspace-id",
      emailEnabled: true,
      webhookEnabled: true,
      inAppEnabled: true,
      slackEnabled: false,
      discordEnabled: false,
      emailRecipients: [],
      webhookUrl: "https://example.com/webhook",
      webhookSecret: "super-secret",
      quotaAlertThresholds: [50, 90],
      enabledTypes: ["quota_warning"],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(publicPreferences).not.toHaveProperty("webhookSecret");
    expect(publicPreferences).not.toHaveProperty("workspaceId");
    expect(publicPreferences.hasWebhookSecret).toBe(true);
  });
});

describe("toPublicNotification", () => {
  it("omits tenant and user join identifiers", () => {
    const publicNotification = toPublicNotification({
      id: "123e4567-e89b-12d3-a456-426614174000",
      workspaceId: "123e4567-e89b-12d3-a456-426614174001",
      userId: "user-internal",
      type: "security_alert",
      priority: "high",
      title: "Security alert",
      message: "An API key is expiring",
      metadata: null,
      actionUrl: null,
      actionLabel: null,
      isRead: false,
      readAt: null,
      createdAt: new Date("2026-07-13T00:00:00Z"),
      expiresAt: null,
    });

    expect(publicNotification).not.toHaveProperty("workspaceId");
    expect(publicNotification).not.toHaveProperty("userId");
    expect(publicNotification.id).toBe("123e4567-e89b-12d3-a456-426614174000");
  });
});
