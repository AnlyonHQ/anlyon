import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => [] as Array<{ message: string; level: string }>);
vi.mock("../src/lib/sentry.ts", () => ({
  captureMessage: (message: string, level: string) => { captured.push({ message, level }); },
}));

const { emailVolumeAlert, notificationEmailAlertThreshold } = await import("../src/core/notifications/email-service.ts");

const base = { workspaceId: "ws_1", month: "2026-10" };

afterEach(() => {
  captured.length = 0;
  delete process.env.NOTIFICATION_EMAIL_ALERT_THRESHOLD;
});

describe("notification email volume alert", () => {
  it("alerts once each time the month's count crosses a multiple of the threshold", () => {
    expect(emailVolumeAlert({ ...base, used: 9_999, count: 1, threshold: 10_000 })).toBe(false);
    expect(emailVolumeAlert({ ...base, used: 10_002, count: 3, threshold: 10_000 })).toBe(true);
    expect(emailVolumeAlert({ ...base, used: 10_003, count: 1, threshold: 10_000 })).toBe(false);
    expect(emailVolumeAlert({ ...base, used: 20_000, count: 1, threshold: 10_000 })).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ level: "warning" });
    expect(captured[0].message).toContain("10002 this month");
  });

  it("is off at 0, and reads the admin setting with a default of 10,000", () => {
    expect(emailVolumeAlert({ ...base, used: 50_000, count: 50_000, threshold: 0 })).toBe(false);
    expect(notificationEmailAlertThreshold()).toBe(10_000);
    process.env.NOTIFICATION_EMAIL_ALERT_THRESHOLD = "2500";
    expect(notificationEmailAlertThreshold()).toBe(2_500);
  });
});
