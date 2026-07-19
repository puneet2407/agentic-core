import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodeIndex } from "../src/workspace/code-index.js";
import type { Embedder } from "../src/memory/embeddings.js";

/** Deterministic fake embedder keyed on topics found in code text. */
function fakeEmbedder(): Embedder {
  const vecFor = (text: string): number[] => {
    const t = text.toLowerCase();
    let v = [0.01, 0.01, 0.01];
    if (/retry|backoff|attempt/.test(t)) v = [1, 0.05, 0];
    else if (/login|auth|password/.test(t)) v = [0.05, 1, 0];
    else if (/invoice|billing/.test(t)) v = [0, 0.05, 1];
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  };
  return { name: "fake", embed: async (texts) => texts.map(vecFor) };
}

async function makeWorkspace(): Promise<string> {
  const root = join(".test-data", `ws-${randomUUID()}`);
  await mkdir(join(root, "svc-a/src"), { recursive: true });
  await mkdir(join(root, "svc-b/src"), { recursive: true });
  await writeFile(
    join(root, "svc-a/src/resilience.ts"),
    "export function withBackoff() {\n  // attempt again on failure\n}\n",
  );
  await writeFile(
    join(root, "svc-b/src/session.ts"),
    "export function checkPassword(u: string) {\n  return u.length > 0;\n}\n",
  );
  await writeFile(join(root, "svc-a/.env"), "SECRET=nope\n"); // must be skipped
  await writeFile(join(root, "svc-a/package-lock.json"), "{}\n"); // must be skipped
  return root;
}

function makeIndex(root: string): CodeIndex {
  return new CodeIndex(root, {
    storePrefix: `codeidx-${randomUUID()}`,
    embedderFactory: async () => fakeEmbedder(),
  });
}

describe("CodeIndex", () => {
  it("indexes code and finds it by meaning, skipping secrets/lockfiles", async () => {
    const root = await makeWorkspace();
    const idx = makeIndex(root);
    const stats = await idx.indexRepo();
    expect(stats.filesIndexed).toBe(2); // .env and lockfile excluded

    // "retry logic" appears nowhere literally — semantic match on backoff/attempt.
    const hit = await idx.search("where is the retry logic");
    expect(hit).toContain("svc-a/src/resilience.ts");

    const auth = await idx.search("user login handling", { repo: "svc-b" });
    expect(auth).toContain("svc-b/src/session.ts");
    await rm(root, { recursive: true, force: true });
  });

  it("is incremental: unchanged files are not re-indexed; edits are picked up", async () => {
    const root = await makeWorkspace();
    const idx = makeIndex(root);
    await idx.indexRepo();

    const again = await idx.indexRepo();
    expect(again.filesIndexed).toBe(0); // nothing changed

    await writeFile(
      join(root, "svc-b/src/session.ts"),
      "export function issueInvoice() {\n  // billing entry\n}\n",
    );
    const after = await idx.indexRepo();
    expect(after.filesIndexed).toBe(1);

    const billing = await idx.search("billing invoices");
    expect(billing).toContain("svc-b/src/session.ts");
    await rm(root, { recursive: true, force: true });
  });

  it("removes deleted files from the index", async () => {
    const root = await makeWorkspace();
    const idx = makeIndex(root);
    await idx.indexRepo();

    await rm(join(root, "svc-a/src/resilience.ts"));
    const stats = await idx.indexRepo();
    expect(stats.filesRemoved).toBe(1);

    const hit = await idx.search("where is the retry logic");
    expect(hit).not.toContain("resilience.ts");
    await rm(root, { recursive: true, force: true });
  });

  it("rejects repo paths escaping the workspace root", async () => {
    const root = await makeWorkspace();
    const idx = makeIndex(root);
    await expect(idx.indexRepo("../outside")).rejects.toThrow(/escapes/);
    await rm(root, { recursive: true, force: true });
  });
});
