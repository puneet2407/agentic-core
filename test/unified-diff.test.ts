import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/workspace/proposals.js";

describe("unifiedDiff", () => {
  it("produces a git-style header and hunk for an edit", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const next = "a\nb\nc\nd\nX\nf\ng\nh\n";
    const d = unifiedDiff(old, next, "svc/file.ts");
    expect(d).toContain("--- a/svc/file.ts");
    expect(d).toContain("+++ b/svc/file.ts");
    expect(d).toContain("@@ -2,7 +2,7 @@"); // 3 ctx before + 1 change + 3 ctx after
    expect(d).toContain("-e");
    expect(d).toContain("+X");
    expect(d).toContain(" d"); // context line
  });

  it("handles new files with /dev/null header", () => {
    const d = unifiedDiff(null, "one\ntwo\n", "svc/new.ts");
    expect(d).toContain("--- /dev/null");
    expect(d).toContain("+++ b/svc/new.ts");
    expect(d).toContain("@@ -0,0 +1,2 @@");
    expect(d).toContain("+one");
  });

  it("handles pure insertion at end of file", () => {
    const d = unifiedDiff("a\nb\n", "a\nb\nc\n", "f.ts");
    expect(d).toContain("@@ -1,2 +1,3 @@");
    expect(d).toContain("+c");
    expect(d).not.toContain("-a");
  });

  it("marks missing trailing newline", () => {
    const d = unifiedDiff("a\nold", "a\nnew", "f.ts");
    expect(d).toContain("\\ No newline at end of file");
    expect(d).toContain("-old");
    expect(d).toContain("+new");
  });

  it("returns empty string for identical content", () => {
    expect(unifiedDiff("same\n", "same\n", "f.ts")).toBe("");
  });
});
