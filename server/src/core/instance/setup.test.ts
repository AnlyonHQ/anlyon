import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  vi.stubEnv("EDITION", "community");
  vi.stubEnv("ANLYON_SETUP_TOKEN", "installer-token-0123456789abcdefghijklmnop");
  vi.stubEnv("CONSOLE_URL", "https://anlyon.example.com/");
  return import("./setup.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setup token", () => {
  it("accepts the installer's token and nothing else", async () => {
    const setup = await load();
    expect(await setup.verifySetupToken("installer-token-0123456789abcdefghijklmnop")).toBe(true);
    expect(await setup.verifySetupToken("installer-token-0123456789abcdefghijklmnoq")).toBe(false);
    expect(await setup.verifySetupToken("")).toBe(false);
    expect(await setup.verifySetupToken("installer-token")).toBe(false);
  });

  it("makes 256-bit tokens, different every time", async () => {
    const setup = await load();
    const a = setup.generateSetupToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setup.generateSetupToken()).not.toBe(a);
  });

  it("puts the token in the URL fragment, which no request carries", async () => {
    const setup = await load();
    expect(setup.setupUrl("tok")).toBe("https://anlyon.example.com/setup#token=tok");
  });

  it("is never pending on cloud", async () => {
    vi.resetModules();
    vi.stubEnv("EDITION", "cloud");
    const setup = await import("./setup.ts");
    expect(await setup.isSetupPending()).toBe(false);
  });
});
