import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadContract, loadContractAtRef, mergeContract, unresolvedRefs } from "../scripts/contract.ts";

const core = () => ({
  openapi: "3.0.3",
  tags: [{ name: "Things" }, { name: "Other" }],
  paths: { "/things": { get: { operationId: "listThings", responses: { "200": { $ref: "#/components/responses/Things" } } } } },
  components: {
    schemas: {
      Kind: { type: "string", enum: ["a", "c"] },
      Thing: { type: "object", required: ["id"], properties: { id: { type: "string" }, kind: { $ref: "#/components/schemas/Kind" } } },
    },
    responses: { Things: { description: "Things" } },
  },
});

const fragment = (document: Record<string, unknown>) => [{ name: "extra", file: "extra/openapi.yaml", document }];

describe("merging the core contract with an extension's share", () => {
  it("adds operations, components and tags, and extends core values in place", () => {
    const merged = mergeContract(core(), fragment({
      paths: { "/things": { post: { operationId: "createThing" } }, "/more": { get: { operationId: "listMore" } } },
      components: { schemas: { More: { type: "object" } } },
      "x-anlyon-extends": [
        { target: "#/tags", after: "Things", add: [{ name: "More" }] },
        { target: "#/components/schemas/Kind/enum", after: "a", add: ["b"] },
        { target: "#/components/schemas/Thing/properties", after: "id", add: { extra: { type: "string" } } },
        { target: "#/components/schemas/Thing/required", add: ["extra"] },
      ],
    }));
    expect(Object.keys(merged.paths)).toEqual(["/things", "/more"]);
    expect(Object.keys(merged.paths["/things"])).toEqual(["get", "post"]);
    expect(merged.tags.map((tag: { name: string }) => tag.name)).toEqual(["Things", "More", "Other"]);
    expect(merged.components.schemas.Kind.enum).toEqual(["a", "b", "c"]);
    expect(Object.keys(merged.components.schemas.Thing.properties)).toEqual(["id", "extra", "kind"]);
    expect(merged.components.schemas.Thing.required).toEqual(["id", "extra"]);
    expect(merged.components.schemas.More).toEqual({ type: "object" });
  });

  it("leaves the core document as it was", () => {
    const input = core();
    mergeContract(input, fragment({ "x-anlyon-extends": [{ target: "#/components/schemas/Kind/enum", add: ["b"] }] }));
    expect(input).toEqual(core());
  });

  it("is the core document when there is no extension", () => {
    expect(mergeContract(core(), [])).toEqual(core());
  });

  it("never overwrites", () => {
    expect(() => mergeContract(core(), fragment({ paths: { "/things": { get: { operationId: "again" } } } }))).toThrow(/GET \/things is already defined/);
    expect(() => mergeContract(core(), fragment({ components: { schemas: { Kind: { type: "string" } } } }))).toThrow(/components.schemas.Kind is already defined/);
    expect(() => mergeContract(core(), fragment({ "x-anlyon-extends": [{ target: "#/tags", add: [{ name: "Things", description: "twice" }] }] }))).toThrow(/already there/);
    expect(() => mergeContract(core(), fragment({ "x-anlyon-extends": [{ target: "#/components/schemas/Kind/enum", add: ["a"] }] }))).toThrow(/already there/);
    expect(() => mergeContract(core(), fragment({ "x-anlyon-extends": [{ target: "#/components/schemas/Thing/properties", add: { id: {} } }] }))).toThrow(/already there/);
  });

  it("refuses a fragment that is more than a share", () => {
    expect(() => mergeContract(core(), fragment({ info: { title: "mine" } }))).toThrow(/only tags, paths, components, x-anlyon-extends/);
    expect(() => mergeContract(core(), fragment({ "x-anlyon-extends": [{ target: "#/components/schemas/Missing/enum", add: ["x"] }] }))).toThrow(/does not exist/);
    expect(() => mergeContract(core(), fragment({ "x-anlyon-extends": [{ target: "#/components/schemas/Kind/enum", after: "z", add: ["x"] }] }))).toThrow(/is not there/);
  });

  it("finds references a document cannot resolve on its own", () => {
    const standalone = core();
    expect(unresolvedRefs(standalone)).toEqual([]);
    (standalone.paths["/things"].get.responses as Record<string, unknown>)["201"] = { $ref: "#/components/responses/Elsewhere" };
    expect(unresolvedRefs(standalone)).toEqual(["#/components/responses/Elsewhere"]);
  });
});

describe("loading the contract", () => {
  it("merges the core document with each extension's share, in the working tree and at a git ref", () => {
    const repo = mkdtempSync(join(tmpdir(), "contract-"));
    try {
      const server = join(repo, "server");
      mkdirSync(join(server, "src/extensions/extra"), { recursive: true });
      mkdirSync(join(server, "src/extensions/_skipped"), { recursive: true });
      writeFileSync(join(server, "openapi.yaml"), stringify(core()));
      writeFileSync(join(server, "src/extensions/extra/openapi.yaml"), stringify({ paths: { "/more": { get: { operationId: "listMore" } } } }));
      writeFileSync(join(server, "src/extensions/_skipped/openapi.yaml"), stringify({ paths: { "/never": { get: { operationId: "never" } } } }));
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
      };
      git("init", "-q");
      git("add", ".");
      git("commit", "-q", "-m", "contract");

      expect(Object.keys(loadContract(server).paths)).toEqual(["/things", "/more"]);
      expect(Object.keys(loadContract(server, "core").paths)).toEqual(["/things"]);
      expect(Object.keys(loadContractAtRef("HEAD", server).paths)).toEqual(["/things", "/more"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
