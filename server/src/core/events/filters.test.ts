import { describe, it, expect } from "vitest";
import { matchEventType } from "./filters.ts";

describe("matchEventType", () => {
  describe("wildcard *", () => {
    it('matches everything with "*"', () => {
      expect(matchEventType(["*"], "memory.ingest.completed")).toBe(true);
      expect(matchEventType(["*"], "order.created")).toBe(true);
      expect(matchEventType(["*"], "a")).toBe(true);
      expect(matchEventType(["*"], "")).toBe(true);
    });
  });

  describe("exact match", () => {
    it("matches exact event type", () => {
      expect(matchEventType(["workflow.run.completed"], "workflow.run.completed")).toBe(true);
    });

    it("does not match partial exact strings", () => {
      expect(matchEventType(["workflow.run"], "workflow.run.completed")).toBe(false);
      expect(matchEventType(["workflow.run.completed"], "workflow.run")).toBe(false);
    });
  });

  describe("prefix globs (segment.*)", () => {
    it('matches "memory.*" to nested types under memory', () => {
      expect(matchEventType(["memory.*"], "memory.ingest.completed")).toBe(true);
      expect(matchEventType(["memory.*"], "memory.x")).toBe(true);
      expect(matchEventType(["memory.*"], "memory.a.b.c")).toBe(true);
    });

    it('does NOT match "memory.*" to bare "memory" (needs 1+ segments after prefix)', () => {
      expect(matchEventType(["memory.*"], "memory")).toBe(false);
    });

    it("does not match sibling prefixes", () => {
      expect(matchEventType(["memory.*"], "memories.ingest")).toBe(false);
      expect(matchEventType(["memory.*"], "memoryx.ingest")).toBe(false);
      expect(matchEventType(["order.*"], "orders.created")).toBe(false);
    });
  });

  describe("no-match cases", () => {
    it("returns false when no patterns match", () => {
      expect(matchEventType(["order.created"], "user.created")).toBe(false);
      expect(matchEventType(["order.*"], "user.created")).toBe(false);
      expect(matchEventType([], "anything")).toBe(false);
    });

    it("does not treat non-glob patterns as prefixes", () => {
      expect(matchEventType(["order"], "order.created")).toBe(false);
    });
  });

  describe("multiple patterns (any-match)", () => {
    it("matches if any pattern matches", () => {
      expect(matchEventType(["user.*", "order.created"], "order.created")).toBe(true);
      expect(matchEventType(["user.*", "order.created"], "user.signup")).toBe(true);
      expect(matchEventType(["user.*", "order.created"], "payment.captured")).toBe(false);
    });
  });

  describe("whitespace trimming", () => {
    it("trims pattern whitespace before matching", () => {
      expect(matchEventType(["  *  "], "anything")).toBe(true);
      expect(matchEventType(["  order.created  "], "order.created")).toBe(true);
      expect(matchEventType(["  memory.*  "], "memory.ingest.completed")).toBe(true);
      expect(matchEventType(["  memory.*  "], "memory")).toBe(false);
    });
  });
});
