import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  generateSlackAuthUrl,
  exchangeSlackCode,
  testSlackToken,
  listSlackChannels,
  formatSlackMessage,
  sendSlackNotification,
  sendTestSlackNotification,
} from "../../src/core/integrations/slack-service.ts";
import { env } from "../../src/config/env.ts";

describe("Slack Integration Service", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("generateSlackAuthUrl", () => {
    it("should generate valid OAuth URL", () => {
      if (!env.SLACK_CLIENT_ID) {
        expect(true).toBe(true);
        return;
      }

      const state = "test-state-123";
      const redirectUri = "https://app.anlyon.com/api/v2/integrations/slack/callback";

      const authUrl = generateSlackAuthUrl(state, redirectUri);

      expect(authUrl).toContain("https://slack.com/oauth/v2/authorize");
      expect(authUrl).toContain(`client_id=${env.SLACK_CLIENT_ID}`);
      expect(authUrl).toContain(`state=${state}`);
      expect(authUrl).toContain(encodeURIComponent(redirectUri));
    });

    it("should throw error when SLACK_CLIENT_ID is not configured", () => {
      if (!env.SLACK_CLIENT_ID) {
        expect(() => generateSlackAuthUrl("state", "https://example.com/callback")).toThrow();
        return;
      }

      expect(() => generateSlackAuthUrl("state", "https://example.com/callback")).not.toThrow();
    });

    it("should include required scopes when configured", () => {
      if (!env.SLACK_CLIENT_ID) {
        expect(true).toBe(true);
        return;
      }

      const authUrl = generateSlackAuthUrl("state", "https://example.com/callback");

      expect(authUrl).toContain("scope=");
      expect(authUrl).toContain("chat%3Awrite");
      expect(authUrl).toContain("channels%3Aread");
    });
  });

  describe("exchangeSlackCode", () => {
    const code = "test-oauth-code";
    const redirectUri = "https://app.anlyon.com/callback";

    it("should exchange code for token successfully", async () => {
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
        await expect(exchangeSlackCode(code, redirectUri)).rejects.toThrow();
        return;
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          access_token: "xoxb-test-token",
          token_type: "bot",
          scope: "chat:write,channels:read",
          bot_user_id: "U123ABC",
          app_id: "A123ABC",
          team: { id: "T123ABC", name: "Test Team" },
        }),
      });

      const result = await exchangeSlackCode(code, redirectUri);

      expect(result.ok).toBe(true);
      expect(result.access_token).toBe("xoxb-test-token");
      expect(result.team?.name).toBe("Test Team");
    });

    it("should throw error on failed exchange", async () => {
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
        await expect(exchangeSlackCode(code, redirectUri)).rejects.toThrow();
        return;
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: false,
          error: "invalid_code",
        }),
      });

      await expect(exchangeSlackCode(code, redirectUri)).rejects.toThrow("Slack OAuth failed");
    });

    it("should throw error when credentials not configured", async () => {
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
        await expect(exchangeSlackCode(code, redirectUri)).rejects.toThrow("Slack OAuth credentials are not configured");
        return;
      }

      expect(true).toBe(true);
    });

    it("should send correct request format", async () => {
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
        expect(true).toBe(true);
        return;
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          access_token: "xoxb-test-token",
          team: { id: "T123", name: "Team" },
        }),
      });

      await exchangeSlackCode(code, redirectUri);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://slack.com/api/oauth.v2.access",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
      );
    });
  });

  describe("testSlackToken", () => {
    const accessToken = "xoxb-test-token";

    it("should return valid result for good token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          team_id: "T123ABC",
          team: "Test Team",
          bot_id: "B123ABC",
        }),
      });

      const result = await testSlackToken(accessToken);

      expect(result.valid).toBe(true);
      expect(result.teamId).toBe("T123ABC");
      expect(result.teamName).toBe("Test Team");
    });

    it("should return invalid result for bad token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: false,
          error: "invalid_auth",
        }),
      });

      const result = await testSlackToken(accessToken);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_auth");
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await testSlackToken(accessToken);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Network error");
    });
  });

  describe("listSlackChannels", () => {
    const accessToken = "xoxb-test-token";

    it("should list channels successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          channels: [
            { id: "C123", name: "general", is_private: false, is_member: true },
            { id: "C456", name: "random", is_private: false, is_member: true },
          ],
          response_metadata: { next_cursor: "" },
        }),
      });

      const channels = await listSlackChannels(accessToken);

      expect(channels).toHaveLength(2);
      expect(channels[0].name).toBe("general");
    });

    it("should filter out private channels user is not member of", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          channels: [
            { id: "C123", name: "general", is_private: false, is_member: true },
            { id: "C456", name: "secret", is_private: true, is_member: false },
            { id: "C789", name: "team-private", is_private: true, is_member: true },
          ],
          response_metadata: { next_cursor: "" },
        }),
      });

      const channels = await listSlackChannels(accessToken);

      expect(channels).toHaveLength(2);
      expect(channels.map(c => c.name)).toContain("general");
      expect(channels.map(c => c.name)).toContain("team-private");
      expect(channels.map(c => c.name)).not.toContain("secret");
    });

    it("should handle pagination", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            channels: [{ id: "C123", name: "general", is_private: false, is_member: true }],
            response_metadata: { next_cursor: "cursor123" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            channels: [{ id: "C456", name: "random", is_private: false, is_member: true }],
            response_metadata: { next_cursor: "" },
          }),
        });

      const channels = await listSlackChannels(accessToken);

      expect(channels).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should throw error on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: false,
          error: "token_revoked",
        }),
      });

      await expect(listSlackChannels(accessToken)).rejects.toThrow();
    });

    it("should sort channels alphabetically", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          channels: [
            { id: "C3", name: "zebra", is_private: false, is_member: true },
            { id: "C1", name: "alpha", is_private: false, is_member: true },
            { id: "C2", name: "beta", is_private: false, is_member: true },
          ],
          response_metadata: { next_cursor: "" },
        }),
      });

      const channels = await listSlackChannels(accessToken);

      expect(channels[0].name).toBe("alpha");
      expect(channels[1].name).toBe("beta");
      expect(channels[2].name).toBe("zebra");
    });
  });

  describe("formatSlackMessage", () => {
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

    it("labels an AI approval suggestion as not a decision, with at most three reasons", () => {
      const payload = formatSlackMessage({
        ...baseNotification,
        type: "approval_requested" as never,
        metadata: {
          approvalId: "apr_1",
          advice: { recommendation: "approve", risk: "low", confidence: 0.934, reasons: ["a", "b", "c", "d"] },
        },
      });
      const section = payload.blocks.find((b) => b.type === "section" && JSON.stringify(b).includes("Vigil suggestion"));
      const text = (section as { text: { text: string } }).text.text;
      expect(text).toContain("Vigil suggestion (not a decision): approve · risk low · confidence 0.93");
      expect(text).toContain("• c");
      expect(text).not.toContain("• d");
    });

    it("sends no suggestion section without advice", () => {
      const payload = formatSlackMessage(baseNotification);
      expect(JSON.stringify(payload.blocks)).not.toContain("Vigil suggestion");
    });

    it("should format notification with blocks", () => {
      const payload = formatSlackMessage(baseNotification);

      expect(payload.blocks).toBeDefined();
      expect(payload.blocks.length).toBeGreaterThan(0);
      expect(payload.text).toBeDefined();
    });

    it("should include header with title", () => {
      const payload = formatSlackMessage(baseNotification);

      const headerBlock = payload.blocks.find(b => b.type === "header");
      expect(headerBlock).toBeDefined();
      expect(headerBlock!.text?.text).toContain("Quota Warning");
    });

    it("should include message in section", () => {
      const payload = formatSlackMessage(baseNotification);

      const sectionBlock = payload.blocks.find(b =>
        b.type === "section" && b.text?.text === baseNotification.message
      );
      expect(sectionBlock).toBeDefined();
    });

    it("should include action button when URL present", () => {
      const payload = formatSlackMessage(baseNotification);

      const actionsBlock = payload.blocks.find(b => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock!.elements).toBeDefined();
      expect(actionsBlock!.elements![0].url).toBe(baseNotification.actionUrl);
    });

    it("should include context footer", () => {
      const payload = formatSlackMessage(baseNotification);

      const contextBlock = payload.blocks.find(b => b.type === "context");
      expect(contextBlock).toBeDefined();
      expect(contextBlock!.elements![0].text).toContain("Sent from Anlyon");
    });

    it("should set correct color for priority", () => {
      const priorities = ["low", "medium", "high", "critical"] as const;
      const expectedColors = ["#6b7280", "#3b82f6", "#f59e0b", "#ef4444"];

      priorities.forEach((priority, index) => {
        const notification = { ...baseNotification, priority };
        const payload = formatSlackMessage(notification);

        expect(payload.attachments?.[0]?.color).toBe(expectedColors[index]);
      });
    });

    it("should handle notification without action URL", () => {
      const notification = { ...baseNotification, actionUrl: null };
      const payload = formatSlackMessage(notification);

      const actionsBlock = payload.blocks.find(b => b.type === "actions");
      expect(actionsBlock).toBeUndefined();
    });
  });

  describe("sendSlackNotification", () => {
    const accessToken = "xoxb-test-token";
    const channelId = "C123ABC";
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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          channel: channelId,
          ts: "1234567890.123456",
        }),
      });

      await expect(sendSlackNotification(accessToken, channelId, notification)).resolves.not.toThrow();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://slack.com/api/chat.postMessage",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: `Bearer ${accessToken}`,
          }),
        })
      );
    });

    it("should throw error on Slack API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: false,
          error: "channel_not_found",
        }),
      });

      await expect(sendSlackNotification(accessToken, channelId, notification)).rejects.toThrow("Slack API error");
    });

    it("should include channel in request body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: channelId, ts: "123" }),
      });

      await sendSlackNotification(accessToken, channelId, notification);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.channel).toBe(channelId);
    });
  });

  describe("sendTestSlackNotification", () => {
    const accessToken = "xoxb-test-token";
    const channelId = "C123ABC";

    it("should return success: true on successful test", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: channelId, ts: "123" }),
      });

      const result = await sendTestSlackNotification(accessToken, channelId);

      expect(result.success).toBe(true);
    });

    it("should return success: false on failed test", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: false, error: "channel_not_found" }),
      });

      const result = await sendTestSlackNotification(accessToken, channelId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("channel_not_found");
    });

    it("should return success: false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await sendTestSlackNotification(accessToken, channelId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("should send test message with correct content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: channelId, ts: "123" }),
      });

      await sendTestSlackNotification(accessToken, channelId);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.blocks).toBeDefined();
      const headerBlock = body.blocks.find((b: any) => b.type === "header");
      expect(headerBlock?.text?.text).toContain("Test Notification");
    });
  });
});
