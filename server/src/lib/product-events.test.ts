import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capture, captureMcpToolCall, captureMilestoneOnce, captureUserSignedUp, productEventsEnabled, resetProductEventSink,
  setProductEventSink, type ProductEventSink,
} from "./product-events.ts";
import { recordHostedToolCall } from "./mcp-analytics.ts";

afterEach(() => resetProductEventSink());

function sink(enabled = true) {
  return {
    enabled: vi.fn(() => enabled),
    capture: vi.fn(),
    captureMilestoneOnce: vi.fn(),
    captureUserSignedUp: vi.fn(),
    captureMcpToolCall: vi.fn(),
  } satisfies ProductEventSink;
}

const caller = { distinctId: "user_1", isPerson: true };

describe("product events", () => {
  it("are a no-op without a sink, and never time a call", async () => {
    expect(productEventsEnabled()).toBe(false);
    capture("x", "ws");
    captureMilestoneOnce("ws", "first_x");
    captureUserSignedUp("user_1");
    const call = vi.fn(async () => ({ content: [] }));
    await recordHostedToolCall({ serverName: "s", toolName: "t", caller }, call);
    expect(call).toHaveBeenCalledOnce();
  });

  it("go to the registered sink with defaults filled in", async () => {
    const target = sink();
    setProductEventSink(target);
    capture("workspace_created", "ws");
    captureMilestoneOnce("ws", "first_publish");
    captureUserSignedUp("user_1", { method: "email" });
    expect(target.capture).toHaveBeenCalledWith("workspace_created", "ws", {}, {});
    expect(target.captureMilestoneOnce).toHaveBeenCalledWith("ws", "first_publish", {});
    expect(target.captureUserSignedUp).toHaveBeenCalledWith("user_1", { method: "email" });
    await recordHostedToolCall({ serverName: "s", toolName: "t", caller }, async () => ({ content: [] }));
    expect(target.captureMcpToolCall).toHaveBeenCalledWith(expect.objectContaining({ kind: "hosted", serverName: "s", toolName: "t", isError: false, caller }));
  });

  it("send nothing while the sink says it is off", () => {
    const target = sink(false);
    setProductEventSink(target);
    capture("x", "ws");
    captureMcpToolCall({ kind: "upstream", serverName: "s", toolName: "t", startedAt: new Date(), durationMs: 1, isError: false, caller });
    expect(target.capture).not.toHaveBeenCalled();
    expect(target.captureMcpToolCall).not.toHaveBeenCalled();
  });

  it("never let a sink failure reach the caller", () => {
    const target = sink();
    target.capture.mockImplementation(() => { throw new Error("down"); });
    setProductEventSink(target);
    expect(() => capture("x", "ws")).not.toThrow();
  });

  it("take one sink per process", () => {
    setProductEventSink(sink());
    expect(() => setProductEventSink(sink())).toThrow(/already registered/);
  });
});
