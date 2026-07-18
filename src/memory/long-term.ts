import { createHash, randomUUID } from "node:crypto";
import type { MemoryRecord, VectorStore } from "../types/index.js";
import { JsonlStore } from "../persistence/jsonl-store.js";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";
import { cosineSim, createTransformersEmbedder, type Embedder } from "./embeddings.js";

/**
 * Long-term memory (Layer 5 — Vector DB).
 *
 * PersistentVectorStore keeps records in a JSONL file (survives restarts) and
 * scores with keyword overlap so the system runs with zero external services.
 * It implements the same VectorStore interface you'd back with pgvector /
 * Pinecone / Weaviate — swap the implementation, keep the callers.
 *
 * Provenance: every record carries metadata.provenance —
 *   "seed"    — operator-authored facts (trusted)
 *   "user"    — provided by an end user
 *   "derived" — produced by the system itself (run summaries etc.; UNTRUSTED:
 *               may contain content that originated from the open web)
 * Callers that inject memories into prompts must label non-seed records as
 * untrusted context to limit memory-poisoning blast radius.
 */
export type Provenance = "seed" | "user" | "derived";

export class PersistentVectorStore implements VectorStore {
  private store: JsonlStore<MemoryRecord>;

  constructor(name = "memory") {
    this.store = new JsonlStore<MemoryRecord>(name);
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    for (const r of records) this.store.put(r);
  }

  async query(text: string, topK = 5): Promise<MemoryRecord[]> {
    const terms = tokenize(text);
    return this.store
      .all()
      .map((r) => ({ r, score: overlap(terms, tokenize(r.content)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.r);
  }
}

/**
 * EmbeddingVectorStore — real semantic retrieval on top of the same JSONL
 * persistence. Embeds records at upsert and queries at recall (cosine
 * similarity); lazily backfills embeddings for records stored before the
 * embedder existed. If the embedder can't load (optional package missing,
 * model unavailable), it degrades to keyword-overlap scoring with one warning.
 */
export class EmbeddingVectorStore implements VectorStore {
  private store: JsonlStore<MemoryRecord>;
  private embedder: Embedder | null = null;
  private embedderFailed = false;

  constructor(
    name = "memory",
    private readonly embedderFactory: () => Promise<Embedder> = createTransformersEmbedder,
  ) {
    this.store = new JsonlStore<MemoryRecord>(name);
  }

  private async getEmbedder(): Promise<Embedder | null> {
    if (this.embedder) return this.embedder;
    if (this.embedderFailed) return null;
    try {
      this.embedder = await this.embedderFactory();
      return this.embedder;
    } catch (err) {
      this.embedderFailed = true;
      logger.warn(
        "local embedder unavailable — falling back to keyword recall " +
          "(npm install @huggingface/transformers to enable)",
        { error: String(err).slice(0, 200) },
      );
      return null;
    }
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    const embedder = await this.getEmbedder();
    if (embedder) {
      const missing = records.filter((r) => !r.embedding);
      if (missing.length > 0) {
        const vectors = await embedder.embed(missing.map((r) => r.content));
        missing.forEach((r, i) => (r.embedding = vectors[i]));
      }
    }
    for (const r of records) this.store.put(r);
  }

  async query(text: string, topK = 5): Promise<MemoryRecord[]> {
    const embedder = await this.getEmbedder();
    if (!embedder) return keywordQuery(this.store.all(), text, topK);

    await this.backfill(embedder);
    const [qv] = await embedder.embed([text]);
    return this.store
      .all()
      .filter((r) => r.embedding)
      .map((r) => ({ r, score: cosineSim(qv!, r.embedding!) }))
      .filter((x) => x.score > 0.15) // drop clearly unrelated memories
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.r);
  }

  /** Embed records persisted before the embedder was available (bounded batch). */
  private async backfill(embedder: Embedder, maxBatch = 256): Promise<void> {
    const missing = this.store.all().filter((r) => !r.embedding).slice(0, maxBatch);
    if (missing.length === 0) return;
    const vectors = await embedder.embed(missing.map((r) => r.content));
    missing.forEach((r, i) => {
      r.embedding = vectors[i];
      this.store.put(r);
    });
    logger.info("backfilled memory embeddings", { count: missing.length });
  }
}

/** In-memory variant, used in tests. */
export class InMemoryVectorStore implements VectorStore {
  private records: MemoryRecord[] = [];

  async upsert(records: MemoryRecord[]): Promise<void> {
    for (const r of records) {
      const idx = this.records.findIndex((x) => x.id === r.id);
      if (idx >= 0) this.records[idx] = r;
      else this.records.push(r);
    }
  }

  async query(text: string, topK = 5): Promise<MemoryRecord[]> {
    const terms = tokenize(text);
    return this.records
      .map((r) => ({ r, score: overlap(terms, tokenize(r.content)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.r);
  }
}

function keywordQuery(records: MemoryRecord[], text: string, topK: number): MemoryRecord[] {
  const terms = tokenize(text);
  return records
    .map((r) => ({ r, score: overlap(terms, tokenize(r.content)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.r);
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export class LongTermMemory {
  constructor(private readonly store: VectorStore = new PersistentVectorStore()) {}

  /**
   * Store a fact. `provenance` defaults to "derived" (least trusted).
   * Pass `id` for idempotent upserts (e.g. content-hash for seeds).
   */
  async remember(
    content: string,
    metadata: Record<string, string> = {},
    opts: { provenance?: Provenance; id?: string } = {},
  ): Promise<string> {
    const id = opts.id ?? randomUUID();
    await this.store.upsert([
      {
        id,
        content,
        metadata: { provenance: opts.provenance ?? "derived", ...metadata },
        createdAt: new Date().toISOString(),
      },
    ]);
    return id;
  }

  async recall(query: string, topK = 5): Promise<MemoryRecord[]> {
    return this.store.query(query, topK);
  }
}

/** Stable id for idempotent seeding. */
export function contentHashId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function createDefaultStore(): VectorStore {
  return config.embeddings === "local"
    ? new EmbeddingVectorStore("memory")
    : new PersistentVectorStore("memory");
}

export const longTermMemory = new LongTermMemory(createDefaultStore());
