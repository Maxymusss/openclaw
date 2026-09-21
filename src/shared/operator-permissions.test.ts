import { describe, expect, it } from "vitest";
import {
  freezeOperatorPermissionCeiling,
  intersectOperatorPermissionCeilings,
  operatorModelAllowed,
} from "./operator-permissions.js";

describe("operator model ceiling", () => {
  it("preserves omitted limits and distinguishes an explicit empty allowlist", () => {
    expect(intersectOperatorPermissionCeilings(undefined, undefined)).toBeUndefined();
    expect(operatorModelAllowed(undefined, "provider", "model")).toBe(true);
    expect(operatorModelAllowed({ models: { allow: [] } }, "provider", "model")).toBe(false);
  });

  it("copies and freezes producer-owned arrays", () => {
    const allow = ["provider/first"];
    const permissions = freezeOperatorPermissionCeiling({ models: { allow } });
    allow.push("provider/second");
    expect(permissions).toEqual({ models: { allow: ["provider/first"] } });
    expect(Object.isFrozen(permissions)).toBe(true);
    expect(Object.isFrozen(permissions?.models)).toBe(true);
    expect(Object.isFrozen(permissions?.models?.allow)).toBe(true);
  });

  it.each([
    { current: undefined, expected: ["provider/first"] },
    {
      current: { models: { allow: ["provider/first", "provider/second"] } },
      expected: ["provider/first"],
    },
    { current: { models: { allow: ["provider/second"] } }, expected: [] },
    { current: { models: { allow: [] } }, expected: [] },
  ])("never widens the original restriction: $expected", ({ current, expected }) => {
    expect(
      intersectOperatorPermissionCeilings({ models: { allow: ["provider/first"] } }, current),
    ).toEqual({ models: { allow: expected } });
  });

  it("applies a newly narrowed current ceiling without manufacturing a grant", () => {
    expect(
      intersectOperatorPermissionCeilings(undefined, { models: { allow: ["provider/first"] } }),
    ).toEqual({ models: { allow: ["provider/first"] } });
    expect(
      operatorModelAllowed({ models: { allow: ["provider/first"] } }, "provider", "first"),
    ).toBe(true);
    expect(
      operatorModelAllowed({ models: { allow: ["provider/first"] } }, "provider", "second"),
    ).toBe(false);
  });
});
