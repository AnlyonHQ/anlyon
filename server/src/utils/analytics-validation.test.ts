import { describe, expect, it } from "vitest";
import {
  analyticsLimitQuerySchema,
  analyticsQuerySchema,
} from "./validation.ts";

describe("analytics query validation", () => {
  it("rejects reversed date ranges", () => {
    const result = analyticsQuerySchema.safeParse({
      startDate: "2026-07-14T00:00:00.000Z",
      endDate: "2026-07-13T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it.each(["hour", "day", "week", "month"])("accepts %s granularity", (granularity) => {
    expect(analyticsQuerySchema.parse({ granularity }).granularity).toBe(granularity);
  });

  it("coerces and bounds analytics limits", () => {
    expect(analyticsLimitQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(analyticsLimitQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(analyticsLimitQuerySchema.safeParse({ limit: "invalid" }).success).toBe(false);
  });

  it("accepts only UUID environment filters", () => {
    expect(
      analyticsQuerySchema.parse({
        environmentId: "123e4567-e89b-42d3-a456-426614174000",
      }).environmentId,
    ).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(analyticsQuerySchema.safeParse({ environmentId: "production" }).success).toBe(false);
  });
});
