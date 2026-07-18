import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";

/**
 * JsonlStore (Layer 9 — Data Storage).
 * Append-only JSONL file persistence with in-memory read model.
 * Zero external dependencies, survives restarts, portable across OSes.
 * Swap for Postgres/Redis later by keeping the same call sites.
 */
export class JsonlStore<T extends { id: string }> {
  private readonly file: string;
  private cache = new Map<string, T>();
  private appendsSinceCompact = 0;

  constructor(name: string, private readonly compactEvery = 500) {
    this.file = join(config.dataDir, `${name}.jsonl`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as T & { __deleted?: boolean };
        if (rec.__deleted) this.cache.delete(rec.id);
        else this.cache.set(rec.id, rec);
      } catch {
        logger.warn("skipping corrupt jsonl line", { file: this.file });
      }
    }
  }

  private ensureDir(): void {
    mkdirSync(dirname(this.file), { recursive: true });
  }

  put(record: T): void {
    this.cache.set(record.id, record);
    this.ensureDir();
    appendFileSync(this.file, JSON.stringify(record) + "\n");
    if (++this.appendsSinceCompact >= this.compactEvery) this.compact();
  }

  delete(id: string): void {
    if (!this.cache.delete(id)) return;
    this.ensureDir();
    appendFileSync(this.file, JSON.stringify({ id, __deleted: true }) + "\n");
  }

  get(id: string): T | undefined {
    return this.cache.get(id);
  }

  all(): T[] {
    return [...this.cache.values()];
  }

  get size(): number {
    return this.cache.size;
  }

  /** Rewrite the file with only live records (drops superseded/deleted lines). */
  compact(): void {
    this.ensureDir();
    const body = this.all().map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(this.file, body ? body + "\n" : "");
    this.appendsSinceCompact = 0;
  }
}

/**
 * AppendLog — pure append-only log (audit trails). No read model by id;
 * reads scan the file, filtered by predicate.
 */
export class AppendLog<T> {
  private readonly file: string;

  constructor(name: string) {
    this.file = join(config.dataDir, `${name}.jsonl`);
  }

  append(entry: T): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }

  read(filter?: (e: T) => boolean, limit = 1000): T[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    const out: T[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]!) as T;
        if (!filter || filter(e)) out.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
    return out.reverse();
  }
}
