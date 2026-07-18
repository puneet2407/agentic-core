import { describe, expect, it } from "vitest";
import { validateDag } from "../src/orchestration/planner.js";

describe("validateDag", () => {
  it("accepts a valid DAG", () => {
    expect(() =>
      validateDag([
        { id: "s1", dependsOn: [] },
        { id: "s2", dependsOn: ["s1"] },
        { id: "s3", dependsOn: ["s1", "s2"] },
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate step ids", () => {
    expect(() =>
      validateDag([
        { id: "s1", dependsOn: [] },
        { id: "s1", dependsOn: [] },
      ]),
    ).toThrow(/duplicate/i);
  });

  it("rejects unknown dependencies", () => {
    expect(() => validateDag([{ id: "s1", dependsOn: ["ghost"] }])).toThrow(/unknown/i);
  });

  it("rejects cycles", () => {
    expect(() =>
      validateDag([
        { id: "s1", dependsOn: ["s2"] },
        { id: "s2", dependsOn: ["s1"] },
      ]),
    ).toThrow(/cycle/i);
  });

  it("rejects self-dependency", () => {
    expect(() => validateDag([{ id: "s1", dependsOn: ["s1"] }])).toThrow(/cycle/i);
  });
});
