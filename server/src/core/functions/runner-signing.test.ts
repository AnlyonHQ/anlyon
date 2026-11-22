import { describe, expect, it } from "vitest";
import { RUNNER_SIGNATURE_WINDOW_SECONDS, signRunnerRequest, verifyRunnerRequest } from "./runner-signing.ts";

const SECRET = "test-runner-shared-secret-at-least-32-chars";
const AT = 1_792_800_000_000;

describe("runner request signing", () => {
  it("matches the vector the runner's implementation is pinned to", () => {
    expect(signRunnerRequest(SECRET, "POST", "/run", '{"a":1}', AT)).toBe(
      "t=1792800000,v1=481de9b41dd154923384e6bcf5f648ff26aadea5b4dcaffc6f1aff0655d183cb",
    );
  });

  it("verifies inside the window and refuses outside it", () => {
    const header = signRunnerRequest(SECRET, "POST", "/x", "{}", AT);
    expect(verifyRunnerRequest(SECRET, header, "POST", "/x", "{}", AT + RUNNER_SIGNATURE_WINDOW_SECONDS * 1000)).toBe(true);
    expect(verifyRunnerRequest(SECRET, header, "POST", "/x", "{}", AT - (RUNNER_SIGNATURE_WINDOW_SECONDS + 1) * 1000)).toBe(false);
  });

  it("refuses another body, path, method, secret, or no secret at all", () => {
    const header = signRunnerRequest(SECRET, "POST", "/x", "{}", AT);
    expect(verifyRunnerRequest(SECRET, header, "POST", "/x", '{"a":2}', AT)).toBe(false);
    expect(verifyRunnerRequest(SECRET, header, "POST", "/y", "{}", AT)).toBe(false);
    expect(verifyRunnerRequest(SECRET, header, "PUT", "/x", "{}", AT)).toBe(false);
    expect(verifyRunnerRequest(`${SECRET}!`, header, "POST", "/x", "{}", AT)).toBe(false);
    expect(verifyRunnerRequest(undefined, header, "POST", "/x", "{}", AT)).toBe(false);
    expect(verifyRunnerRequest(SECRET, null, "POST", "/x", "{}", AT)).toBe(false);
  });
});
