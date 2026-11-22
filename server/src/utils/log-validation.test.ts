import { describe, expect, it } from "vitest";
import { logExportQuerySchema, logsQuerySchema } from "./validation.ts";

describe("log query validation", () => {
  it("coerces bounded pagination and duration filters", () => {
    const result = logsQuerySchema.parse({ page: "2", limit: "50", minDuration: "10" });
    expect(result).toMatchObject({ page: 2, limit: 50, minDuration: 10 });
  });

  it("rejects invalid dates, pagination, and inverted duration ranges", () => {
    expect(logsQuerySchema.safeParse({ startDate: "yesterday" }).success).toBe(false);
    expect(logsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(logsQuerySchema.safeParse({ minDuration: "20", maxDuration: "10" }).success).toBe(false);
  });

  it("rejects unsupported export formats and malformed HTTP status lists", () => {
    expect(logExportQuerySchema.safeParse({ format: "xml" }).success).toBe(false);
    expect(logExportQuerySchema.safeParse({ httpStatus: "200, nope" }).success).toBe(false);
  });
});
