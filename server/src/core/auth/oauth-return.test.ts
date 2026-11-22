import { describe, expect, it } from "vitest";
import { authorizeQueryFromVerificationUrl, returnPathFromVerificationUrl } from "./oauth-return.ts";

const signed = "response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fanlyon.dev%2Fauth%2Fcallback&scope=openid+profile+email&exp=1900000000&sig=s1g";
const verification = (callback: string) =>
  `https://api.anlyon.com/api/auth/verify-email?token=t0k&callbackURL=${encodeURIComponent(callback)}`;

describe("authorizeQueryFromVerificationUrl", () => {
  it("keeps the signed authorize query of a login callback", () => {
    const query = authorizeQueryFromVerificationUrl(verification(`/auth/login?${signed}`));
    expect(new URLSearchParams(query).get("client_id")).toBe("abc");
    expect(new URLSearchParams(query).get("sig")).toBe("s1g");
    expect(new URLSearchParams(query).get("exp")).toBe("1900000000");
  });

  it("carries nothing for an ordinary sign-up", () => {
    expect(authorizeQueryFromVerificationUrl(verification("/"))).toBeUndefined();
    expect(authorizeQueryFromVerificationUrl("https://api.anlyon.com/api/auth/verify-email?token=t0k")).toBeUndefined();
  });

  it("never carries an absolute or protocol-relative callback", () => {
    expect(authorizeQueryFromVerificationUrl(verification(`https://evil.example/auth/login?${signed}`))).toBeUndefined();
    expect(authorizeQueryFromVerificationUrl(verification(`//evil.example/auth/login?${signed}`))).toBeUndefined();
  });

  it("carries only a query aimed at the login page, and only a signed one", () => {
    expect(authorizeQueryFromVerificationUrl(verification(`/dashboard?${signed}`))).toBeUndefined();
    expect(authorizeQueryFromVerificationUrl(verification("/auth/login?client_id=abc&exp=1900000000"))).toBeUndefined();
  });
});

describe("returnPathFromVerificationUrl", () => {
  const page = "/mcp-servers/new?url=https%3A%2F%2Fmcp.figma.com%2Fmcp&utm_source=anlyon.dev";

  it("keeps the console page a person signed up from, query and all", () => {
    expect(returnPathFromVerificationUrl(verification(page))).toBe(page);
  });

  it("carries nothing for an ordinary sign-up or a login callback", () => {
    expect(returnPathFromVerificationUrl(verification("/"))).toBeUndefined();
    expect(returnPathFromVerificationUrl("https://api.anlyon.com/api/auth/verify-email?token=t0k")).toBeUndefined();
    expect(returnPathFromVerificationUrl(verification(`/auth/login?${signed}`))).toBeUndefined();
    expect(returnPathFromVerificationUrl("not a url")).toBeUndefined();
  });

  it("never carries anywhere off the console", () => {
    for (const callback of ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "javascript:alert(1)", "/auth/signup"]) {
      expect(returnPathFromVerificationUrl(verification(callback)), callback).toBeUndefined();
    }
  });
});
