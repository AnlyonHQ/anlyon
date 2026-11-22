import { describe, it, expect } from "vitest";
import { pinnedActionsOf } from "../src/core/agents/service.ts";

describe("pins are read out of otherwise free-form config", () => {
  it("reads action name to action version id", () => {
    expect(pinnedActionsOf({ actions: { refund: "acv_1", lookup: "acv_2" } })).toEqual({
      refund: "acv_1",
      lookup: "acv_2",
    });
  });

  it("leaves the rest of the config alone", () => {
    expect(pinnedActionsOf({ model: "claude-opus-5", temp: 0, actions: { a: "acv_1" } })).toEqual({
      a: "acv_1",
    });
  });

  it("returns nothing for a config that pins nothing", () => {
    expect(pinnedActionsOf({})).toEqual({});
    expect(pinnedActionsOf({ model: "x" })).toEqual({});
  });
});

describe("malformed pins are ignored rather than half-applied", () => {
  it("ignores values that are not action version ids", () => {
    expect(pinnedActionsOf({ actions: { a: "act_1", b: 7, c: null, d: "acv_ok" } })).toEqual({
      d: "acv_ok",
    });
  });

  it("ignores an actions field that is not an object", () => {
    expect(pinnedActionsOf({ actions: "all" })).toEqual({});
    expect(pinnedActionsOf({ actions: ["acv_1"] })).toEqual({});
    expect(pinnedActionsOf({ actions: null })).toEqual({});
  });
});
