import { randomUUID } from "node:crypto";
import type { MemoryRecord, VectorStore } from "../types/index.js";

/**
 * Long-term memory (Layer 5 — Vector DB).
 *
 * InMemoryVectorStore is a dev implementation using keyword-overlap scoring
 * so the system runs with zero external services. It implements the same
 * VectorStore interface you'd back with pgvector / Pinecone / Weaviate —
 * swap the implementation, keep the callers.
 */
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

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export class LongTermMemory {
  constructor(private readonly store: VectorStore = new InMemoryVectorStore()) {}

  async remember(content: string, metadata: Record<string, string> = {}): Promise<string> {
    const id = randomUUID();
    await this.store.upsert([{ id, content, metadata, createdAt: new Date().toISOString() }]);
    return id;
  }

  async recall(query: string, topK = 5): Promise<MemoryRecord[]> {
    return this.store.query(query, topK);
  }
}

export const longTermMemory = new LongTermMemory();
