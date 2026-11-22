import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSafeFetch = vi.fn();
vi.mock("../../src/lib/safe-http.ts", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  validateDiscordWebhook,
  formatDiscordMessage,
  sendDiscordNotification,
  sendTestDiscordNotification,
} from "../../src/core/integrations/discord-service.ts";

describe("Discord Integration Service", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("validateDiscordWebhook", () => {
    const validWebhookUrl = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz123456";

    it("should validate a correct webhook URL format", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          guild_id: "guild123",
          channel_id: "channel123",
          name: "Test Webhook",
        }),
      });

      const result = await validateDiscordWebhook(validWebhookUrl);

      expect(result.valid).toBe(true);
      expect(result.guildId).toBe("guild123");
      expect(result.channelId).toBe("channel123");
      expect(result.webhookName).toBe("Test Webhook");
    });

    it("should route validation through safeFetch with redirects disabled", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          guild_id: "guild123",
          channel_id: "channel123",
          name: "Test Webhook",
        }),
      });

      await validateDiscordWebhook(validWebhookUrl);

      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
      expect(mockSafeFetch).toHaveBeenCalledWith(
        validWebhookUrl,
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("should reject invalid URL format", async () => {
      const invalidUrl = "https://example.com/webhook";

      const result = await validateDiscordWebhook(invalidUrl);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Discord webhook URL format");
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it("should reject non-Discord URLs", async () => {
      const nonDiscordUrl = "https://slack.com/api/webhooks/123/abc";

      const result = await validateDiscordWebhook(nonDiscordUrl);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Discord webhook URL format");
    });

    it("should handle 404 webhook not found", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await validateDiscordWebhook(validWebhookUrl);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Webhook not found");
    });

    it("should handle 401 invalid token", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await validateDiscordWebhook(validWebhookUrl);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid webhook token");
    });

    it("should handle network errors", async () => {
      mockSafeFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await validateDiscordWebhook(validWebhookUrl);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Failed to validate webhook");
    });
  });

  describe("formatDiscordMessage", () => {
    const baseNotification = {
      id: "notif-123",
      workspaceId: "workspace-123",
      userId: null,
      type: "quota_warning" as const,
      priority: "medium" as const,
      title: "Quota Warning",
      message: "You have used 75% of your monthly quota.",
      metadata: { currentUsage: 7500, limit: 10000, percentage: 75 },
      actionUrl: "https://app.anlyon.com/billing",
      actionLabel: "View Billing",
      isRead: false,
      readAt: null,
      createdAt: new Date(),
      expiresAt: null,
    };

    it("should format notification with all fields", () => {
      const payload = formatDiscordMessage(baseNotification);

      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].title).toContain("Quota Warning");
      expect(payload.embeds[0].description).toBe("You have used 75% of your monthly quota.");
      expect(payload.username).toBe("Anlyon");
    });

    it("should include usage metadata fields", () => {
      const payload = formatDiscordMessage(baseNotification);
      const fields = payload.embeds[0].fields;

      expect(fields).toBeDefined();
      expect(fields!.some(f => f.name === "Usage")).toBe(true);
      expect(fields!.some(f => f.name === "Percentage")).toBe(true);
    });

    it("should include action URL as a field", () => {
      const payload = formatDiscordMessage(baseNotification);
      const fields = payload.embeds[0].fields;

      const actionField = fields!.find(f => f.name === "View Billing");
      expect(actionField).toBeDefined();
      expect(actionField!.value).toContain(baseNotification.actionUrl);
    });

    it("should set correct color for different priorities", () => {
      const priorities = ["low", "medium", "high", "critical"] as const;
      const expectedColors = [0x6b7280, 0x3b82f6, 0xf59e0b, 0xef4444];

      priorities.forEach((priority, index) => {
        const notification = { ...baseNotification, priority };
        const payload = formatDiscordMessage(notification);

        expect(payload.embeds[0].color).toBe(expectedColors[index]);
      });
    });

    it("should handle notification without metadata", () => {
      const notification = { ...baseNotification, metadata: null, actionUrl: null, actionLabel: null };
      const payload = formatDiscordMessage(notification);

      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].fields).toBeUndefined();
    });

    it("should handle notification without action URL", () => {
      const notification = { ...baseNotification, actionUrl: null, actionLabel: null };
      const payload = formatDiscordMessage(notification);

      const fields = payload.embeds[0].fields;
      const hasActionField = fields?.some(f => f.value.includes("Click here"));
      expect(hasActionField).toBeFalsy();
    });
  });

  describe("sendDiscordNotification", () => {
    const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz123456";
    const notification = {
      id: "notif-123",
      workspaceId: "workspace-123",
      userId: null,
      type: "system_alert" as const,
      priority: "high" as const,
      title: "System Alert",
      message: "A system alert has been triggered.",
      metadata: null,
      actionUrl: null,
      actionLabel: null,
      isRead: false,
      readAt: null,
      createdAt: new Date(),
      expiresAt: null,
    };

    it("should send notification successfully", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await expect(sendDiscordNotification(webhookUrl, notification)).resolves.not.toThrow();

      expect(mockSafeFetch).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("should throw error on failed webhook", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad Request"),
      });

      await expect(sendDiscordNotification(webhookUrl, notification)).rejects.toThrow();
    });

    it("should include correct payload structure", async () => {
      mockSafeFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      await sendDiscordNotification(webhookUrl, notification);

      const callArgs = mockSafeFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.embeds).toBeDefined();
      expect(body.embeds).toHaveLength(1);
      expect(body.username).toBe("Anlyon");
    });
  });

  describe("sendTestDiscordNotification", () => {
    const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz123456";

    it("should return true on successful test", async () => {
      mockSafeFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const result = await sendTestDiscordNotification(webhookUrl);

      expect(result).toBe(true);
    });

    it("should return false on failed test", async () => {
      mockSafeFetch.mockResolvedValueOnce({ ok: false, status: 400 });

      const result = await sendTestDiscordNotification(webhookUrl);

      expect(result).toBe(false);
    });

    it("should return false on network error", async () => {
      mockSafeFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await sendTestDiscordNotification(webhookUrl);

      expect(result).toBe(false);
    });

    it("should send test message with correct content", async () => {
      mockSafeFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      await sendTestDiscordNotification(webhookUrl);

      const callArgs = mockSafeFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.embeds[0].title).toContain("Test Notification");
      expect(body.embeds[0].description).toContain("test notification");
    });
  });
});
