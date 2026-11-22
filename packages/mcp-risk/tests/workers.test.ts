import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("the source", () => {
  it("is all read", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(10);
  });

  it("imports only its own modules", () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(/g)];
      for (const m of imports) {
        const specifier = m[1] ?? m[2] ?? "require(";
        expect(specifier.startsWith("./"), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("uses no Node globals", () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\b(process|Buffer|__dirname|__filename|global|setImmediate)\b(?!\s*:)/);
      expect(code, file).not.toMatch(/node:/);
    }
  });

  it("hashes with crypto.subtle", () => {
    expect(SOURCES["../src/hash.ts"]).toContain("crypto.subtle.digest");
  });
});

describe("the package", () => {
  it("has no runtime dependencies, and only vitest and typescript for development", () => {
    expect((pkg as Record<string, unknown>).dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["typescript", "vitest"]);
    expect(pkg.name).toBe("@anlyon-dev/risk");
    expect(pkg.type).toBe("module");
  });
});
