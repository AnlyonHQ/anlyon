import { describe, expect, it } from "vitest";
import { outcomeOfDispatchError } from "../src/core/actions/execute.ts";
import { SsrfBlockedError } from "../src/lib/safe-http.ts";
import { AuthorizationError, ValidationError } from "../src/utils/errors.ts";

function networkError(code: string): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
}

describe("classifying a dispatch failure", () => {
  describe("nothing left the process, so the call definitely did not happen", () => {
    it("an SSRF refusal, at validation or at connect time", () => {
      expect(outcomeOfDispatchError(new SsrfBlockedError("Blocked IP at connect time"))).toBe("failed");
    });

    it("a template or input the definition rejected before dispatch", () => {
      expect(outcomeOfDispatchError(new ValidationError("Invalid URL"))).toBe("failed");
    });

    it("a secret this caller may not use", () => {
      expect(outcomeOfDispatchError(new AuthorizationError("secrets:read required"))).toBe("failed");
    });

    it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EACCES"])(
      "a connection that was never established (%s)",
      (code) => {
        expect(outcomeOfDispatchError(networkError(code))).toBe("failed");
      },
    );
  });

  describe("the request may have been received, so the outcome is unknown", () => {
    it("a timeout — the whole point of the distinction", () => {
      const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      expect(outcomeOfDispatchError(timeout)).toBe("unknown");
    });

    it("a reset socket, which can arrive after the server read the request", () => {
      expect(outcomeOfDispatchError(networkError("ECONNRESET"))).toBe("unknown");
    });

    it("a broken pipe mid-request", () => {
      expect(outcomeOfDispatchError(networkError("EPIPE"))).toBe("unknown");
    });

    it("a response that failed to read after the request was sent", () => {
      expect(outcomeOfDispatchError(new Error("terminated"))).toBe("unknown");
    });

    it("anything it cannot classify, because the bias must be toward reconciling", () => {
      expect(outcomeOfDispatchError("a string nobody expected")).toBe("unknown");
      expect(outcomeOfDispatchError(undefined)).toBe("unknown");
    });
  });
});
