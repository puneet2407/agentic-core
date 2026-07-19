import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { config } from "../config/index.js";
import { logger } from "../observability/logger.js";
import { EmbeddingVectorStore } from "../memory/long-term.js";
import { JsonlStore } from "../persistence/jsonl-store.js";
import type { Embedder } from "../memory/embeddings.js";
import { createTransformersEmbedder } from "../memory/embeddings.js";

/**
 * Semantic code index (Layer 5 — Knowledge Base, applied to code).
 * Makes ANY codebase under WORKSPACE_ROOT searchable by meaning, not just
 * grep: files are chunked, embedded locally, and persisted. Agents query it
 * via the workspace_semantic_search tool ("where is retry logic handled?"
 * finds the code even when no file contains the word "retry").
 *
 * Incremental: files are content-hashed; only new/changed files re-embed,
 * chunks of deleted files are removed. Safe: read-only, skips secrets,
 * lockfiles, binaries, and anything outside the workspace root.
 */

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "java", "kt", "scala", "go", "py", "rb", "rs", "cs", "php", "swift",
  "sql", "sh", "yml", "yaml", "md", "html", "css", "scss", "proto", "tf", "gradle",
]);
const SKIP_FILES = [/^package-lock\.json$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/, /\.min\.(js|css)$/];
const SECRET_PATTERNS = [/^\.env/i, /\.(pem|key|p12|pfx|jks)$/i, /id_rsa/i, /credentials/i, /secrets?\./i];
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "target", ".git", ".next", "coverage", ".angular", "vendor", "__pycache__",
]);
const CHUNK_LINES = 60;
const MAX_FILE_BYTES = 200 * 1024;

interface IndexedFile {
  id: string; // repo-relative path
  hash: string;
  chunkIds: string[];
  indexedAt: string;
}

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  filesRemoved: number;
  chunks: number;
}

export class CodeIndex {
  private chunks: EmbeddingVectorStore;
  private files: JsonlStore<IndexedFile>;

  constructor(
    private readonly rootDir: string = config.workspaceRoot,
    opts: { storePrefix?: string; embedderFactory?: () => Promise<Embedder> } = {},
  ) {
    const prefix = opts.storePrefix ?? "code";
    this.chunks = new EmbeddingVectorStore(
      `${prefix}-chunks`,
      opts.embedderFactory ?? createTransformersEmbedder,
    );
    this.files = new JsonlStore<IndexedFile>(`${prefix}-files`);
  }

  private root(): string {
    if (!this.rootDir) throw new Error("WORKSPACE_ROOT is not set — nothing to index");
    return resolve(this.rootDir);
  }

  /** Index one repo (top-level folder) or the whole workspace. */
  async indexRepo(repo?: string): Promise<IndexStats> {
    const base = repo ? resolve(this.root(), repo) : this.root();
    if (base !== this.root() && !base.startsWith(this.root() + "/")) {
      throw new Error(`Repo path escapes workspace root: ${repo}`);
    }
    const stats: IndexStats = { filesScanned: 0, filesIndexed: 0, filesRemoved: 0, chunks: 0 };
    const seen = new Set<string>();

    for await (const abs of this.walk(base)) {
      const rel = relative(this.root(), abs);
      seen.add(rel);
      stats.filesScanned++;

      const raw = await readFile(abs, "utf8").catch(() => null);
      if (raw === null) continue;
      const hash = sha(raw);
      const existing = this.files.get(rel);
      if (existing?.hash === hash) continue; // unchanged

      // stale chunks out, new chunks in
      if (existing) for (const cid of existing.chunkIds) this.chunks.remove(cid);
      const chunkIds: string[] = [];
      const pieces = chunkLines(raw, CHUNK_LINES);
      const records = pieces.map((piece, i) => {
        const cid = `${rel}#${i}@${hash.slice(0, 8)}`;
        chunkIds.push(cid);
        return {
          id: cid,
          content: `// ${rel} (lines ${piece.start}-${piece.end})\n${piece.text}`,
          metadata: {
            path: rel,
            repo: rel.split("/")[0] ?? "",
            startLine: String(piece.start),
            endLine: String(piece.end),
          },
          createdAt: new Date().toISOString(),
        };
      });
      await this.chunks.upsert(records);
      this.files.put({ id: rel, hash, chunkIds, indexedAt: new Date().toISOString() });
      stats.filesIndexed++;
      stats.chunks += records.length;
    }

    // prune deleted files (within the scanned scope)
    const scopePrefix = repo ? `${repo}/` : "";
    for (const f of this.files.all()) {
      if (!f.id.startsWith(scopePrefix)) continue;
      if (seen.has(f.id)) continue;
      for (const cid of f.chunkIds) this.chunks.remove(cid);
      this.files.delete(f.id);
      stats.filesRemoved++;
    }

    logger.info("code index updated", { repo: repo ?? "(all)", ...stats });
    return stats;
  }

  /** Semantic search over indexed code; optionally scoped to one repo. */
  async search(query: string, opts: { repo?: string; topK?: number } = {}): Promise<string> {
    const topK = opts.topK ?? 5;
    // over-fetch, then filter by repo
    const hits = await this.chunks.query(query, opts.repo ? topK * 4 : topK);
    const filtered = (opts.repo ? hits.filter((h) => h.metadata["repo"] === opts.repo) : hits).slice(
      0,
      topK,
    );
    if (filtered.length === 0) {
      return this.files.size === 0
        ? "Code index is empty — run the workspace_index tool first."
        : "No relevant code found for that query.";
    }
    return filtered
      .map((h) => `### ${h.metadata["path"]} (lines ${h.metadata["startLine"]}-${h.metadata["endLine"]})\n${stripHeader(h.content)}`)
      .join("\n\n");
  }

  stats(): { files: number } {
    return { files: this.files.size };
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".") || EXCLUDED_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        yield* this.walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
      if (!CODE_EXTENSIONS.has(ext)) continue;
      if (SKIP_FILES.some((re) => re.test(e.name))) continue;
      if (SECRET_PATTERNS.some((re) => re.test(e.name))) continue;
      const info = await stat(abs).catch(() => null);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      yield abs;
    }
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function chunkLines(
  text: string,
  size: number,
): { start: number; end: number; text: string }[] {
  const lines = text.split("\n");
  const out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size);
    if (slice.join("").trim().length === 0) continue; // skip blank chunks
    out.push({ start: i + 1, end: i + slice.length, text: slice.join("\n") });
  }
  return out;
}

function stripHeader(content: string): string {
  const nl = content.indexOf("\n");
  return nl >= 0 ? content.slice(nl + 1) : content;
}

/** Lazy singleton — only constructed when workspace features are used. */
let _codeIndex: CodeIndex | null = null;
export function codeIndex(): CodeIndex {
  if (!_codeIndex) _codeIndex = new CodeIndex();
  return _codeIndex;
}
