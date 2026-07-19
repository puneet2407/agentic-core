import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalManager, simpleDiff } from "../src/workspace/proposals.js";

async function makeRoot(): Promise<string> {
  const root = join(".test-data", `props-${randomUUID()}`);
  await mkdir(join(root, "svc/src"), { recursive: true });
  await writeFile(join(root, "svc/src/a.ts"), "const x = 1;\n");
  return root;
}

function manager(root: string): ProposalManager {
  return new ProposalManager(root, `proposals-${randomUUID()}`);
}

describe("simpleDiff", () => {
  it("marks new files", () => {
    expect(simpleDiff(null, "a\nb")).toContain("new file");
  });

  it("trims common prefix/suffix to a single hunk", () => {
    const d = simpleDiff("a\nb\nc\nd", "a\nX\nc\nd");
    expect(d).toContain("- b");
    expect(d).toContain("+ X");
    expect(d).not.toContain("- a");
    expect(d).not.toContain("- d");
  });
});

describe("ProposalManager", () => {
  it("propose → apply writes the file (new + edit)", async () => {
    const root = await makeRoot();
    const pm = manager(root);

    const edit = await pm.propose({
      path: "svc/src/a.ts",
      content: "const x = 2;\n",
      description: "bump x",
    });
    expect(edit.status).toBe("proposed");
    expect(edit.diff).toContain("+ const x = 2;");

    await pm.apply(edit.id);
    expect(await readFile(join(root, "svc/src/a.ts"), "utf8")).toBe("const x = 2;\n");
    expect(pm.get(edit.id)?.status).toBe("applied");

    const create = await pm.propose({
      path: "svc/src/new.ts",
      content: "export const fresh = true;\n",
      description: "add new module",
    });
    await pm.apply(create.id);
    expect(await readFile(join(root, "svc/src/new.ts"), "utf8")).toContain("fresh");
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to apply when the file changed since the proposal (stale)", async () => {
    const root = await makeRoot();
    const pm = manager(root);
    const p = await pm.propose({
      path: "svc/src/a.ts",
      content: "const x = 2;\n",
      description: "bump x",
    });
    // Someone edits the file in the meantime.
    await writeFile(join(root, "svc/src/a.ts"), "const x = 99;\n");

    await expect(pm.apply(p.id)).rejects.toThrow(/changed on disk/);
    expect(pm.get(p.id)?.status).toBe("rejected");
    // File untouched by the failed apply.
    expect(await readFile(join(root, "svc/src/a.ts"), "utf8")).toBe("const x = 99;\n");
    await rm(root, { recursive: true, force: true });
  });

  it("blocks path escapes and secret files", async () => {
    const root = await makeRoot();
    const pm = manager(root);
    await expect(
      pm.propose({ path: "../evil.ts", content: "x", description: "escape attempt" }),
    ).rejects.toThrow(/escapes/);
    await expect(
      pm.propose({ path: "svc/.env", content: "KEY=1", description: "touch secrets" }),
    ).rejects.toThrow(/secret/i);
    await rm(root, { recursive: true, force: true });
  });

  it("reject blocks later apply; identical content is refused", async () => {
    const root = await makeRoot();
    const pm = manager(root);
    const p = await pm.propose({
      path: "svc/src/a.ts",
      content: "const x = 3;\n",
      description: "bump",
    });
    pm.reject(p.id);
    await expect(pm.apply(p.id)).rejects.toThrow(/already rejected/);

    await expect(
      pm.propose({ path: "svc/src/a.ts", content: "const x = 1;\n", description: "no-op" }),
    ).rejects.toThrow(/identical/);
    await rm(root, { recursive: true, force: true });
  });
});
