import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EmbeddingVectorStore, LongTermMemory } from "../src/memory/long-term.js";
import { cosineSim, type Embedder } from "../src/memory/embeddings.js";

/**
 * Deterministic fake embedder: maps texts to fixed 3-dim "semantic" vectors
 * by topic keywords, so tests exercise real cosine ranking without a model.
 */
function fakeEmbedder(counter?: { calls: number }): Embedder {
  const vecFor = (text: string): number[] => {
    const t = text.toLowerCase();
    // topic axes: [payments, auth, food]
    let v = [0.01, 0.01, 0.01];
    if (/stripe|billing|payment|invoice|charge/.test(t)) v = [1, 0.05, 0];
    else if (/auth|jwt|token|login|oauth/.test(t)) v = [0.05, 1, 0];
    else if (/pizza|coffee|lunch/.test(t)) v = [0, 0.05, 1];
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  };
  return {
    name: "fake",
    async embed(texts) {
      if (counter) counter.calls += texts.length;
      return texts.map(vecFor);
    },
  };
}

describe("cosineSim", () => {
  it("is 1 for identical normalized vectors, ~0 for orthogonal", () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe("EmbeddingVectorStore", () => {
  it("ranks by semantic similarity, not keyword overlap", async () => {
    const store = new EmbeddingVectorStore(`emb-${randomUUID()}`, async () => fakeEmbedder());
    const mem = new LongTermMemory(store);
    await mem.remember("Invoices are charged via Stripe on the 1st");
    await mem.remember("Login uses JWT tokens with 15min expiry");
    await mem.remember("Team lunch is pizza on Fridays");

    // "billing" shares zero literal words with the stored fact — embeddings win.
    const hits = await mem.recall("how does billing work", 2);
    expect(hits[0]!.content).toContain("Stripe");

    const authHits = await mem.recall("oauth login flow", 1);
    expect(authHits[0]!.content).toContain("JWT");
  });

  it("persists embeddings — no re-embedding on reload", async () => {
    const name = `emb-${randomUUID()}`;
    const c1 = { calls: 0 };
    const a = new EmbeddingVectorStore(name, async () => fakeEmbedder(c1));
    await a.upsert([
      { id: "1", content: "payment via stripe", metadata: {}, createdAt: "t" },
    ]);
    expect(c1.calls).toBe(1);

    // Fresh instance (simulated restart) — record already has its vector.
    const c2 = { calls: 0 };
    const b = new EmbeddingVectorStore(name, async () => fakeEmbedder(c2));
    const hits = await b.query("billing charge", 1);
    expect(hits).toHaveLength(1);
    expect(c2.calls).toBe(1); // only the query itself, no backfill
  });

  it("backfills records stored before the embedder existed", async () => {
    const name = `emb-${randomUUID()}`;
    // Store with NO embedder (factory throws) — keyword-era records.
    const legacy = new EmbeddingVectorStore(name, async () => {
      throw new Error("not installed");
    });
    await legacy.upsert([
      { id: "1", content: "invoices charged via stripe", metadata: {}, createdAt: "t" },
    ]);

    // Later the package gets installed — same file, embedder now available.
    const upgraded = new EmbeddingVectorStore(name, async () => fakeEmbedder());
    const hits = await upgraded.query("billing", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.embedding).toBeDefined();
  });

  it("falls back to keyword recall when the embedder is unavailable", async () => {
    const store = new EmbeddingVectorStore(`emb-${randomUUID()}`, async () => {
      throw new Error("module not found");
    });
    const mem = new LongTermMemory(store);
    await mem.remember("the billing service uses stripe");
    const hits = await mem.recall("stripe billing");
    expect(hits).toHaveLength(1); // keyword overlap still works
  });
});
