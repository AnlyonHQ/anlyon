import { describe, expect, it } from "vitest";
import { formatRelative } from "./time";

const NOW = new Date("2026-10-23T21:40:00Z").getTime();
const ago = (ms: number) => NOW - ms;

describe("formatRelative", () => {
	it("reads short and human", () => {
		expect(formatRelative(ago(10_000), NOW)).toBe("just now");
		expect(formatRelative(ago(2 * 60_000), NOW)).toBe("2 min ago");
		expect(formatRelative(ago(59 * 60_000), NOW)).toBe("59 min ago");
		expect(formatRelative(ago(3 * 3_600_000), NOW)).toBe("3 hr ago");
		expect(formatRelative(ago(30 * 3_600_000), NOW)).toBe("yesterday");
		expect(formatRelative(ago(5 * 86_400_000), NOW)).toBe("5 days ago");
	});

	it("says when something is still to come", () => {
		expect(formatRelative(NOW + 5 * 60_000, NOW)).toBe("in 5 min");
		expect(formatRelative(NOW + 10_000, NOW)).toBe("in a moment");
	});

	it("falls back to a date for anything older than a month, and to nothing for garbage", () => {
		expect(formatRelative(ago(90 * 86_400_000), NOW)).not.toMatch(/ago/);
		expect(formatRelative("not a date", NOW)).toBe("");
	});
});
