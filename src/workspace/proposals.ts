import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../config/index.js";
import { JsonlStore } from "../persistence/jsonl-store.js";
import { logger } from "../observability/logger.js";

/**
 * Code-change proposals (Layer 7 human-in-the-loop + Layer 8 policy).
 * Agents NEVER write to your repos directly. They call propose_code_change,
 * which records the full new file content + a diff here. A human reviews via
 * GET /proposals and applies with POST /proposals/:id/apply — which refuses
 * to apply if the file changed on disk since the proposal was made.
 */

export interface Proposal {
  id: string;
  runId: string;
  /** Workspace-root-relative path of the target file. */
  path: string;
  description: string;
  /** File content at proposal time; null = new file. */
  oldContent: string | null;
  newContent: string;
  diff: string;
  status: "proposed" | "applied" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  error?: string;
}

const SECRET_PATTERNS = [/^\.env/i, /\.(pem|key|p12|pfx|jks)$/i, /id_rsa/i, /credentials/i, /secrets?\./i];

/** Compact single-hunk diff: trims common prefix/suffix lines. */
export function simpleDiff(oldStr: string | null, newStr: string, maxLines = 400): string {
  const n = newStr.split("\n");
  if (oldStr === null) {
    return [`@@ new file (${n.length} lines) @@`, ...n.slice(0, maxLines).map((l) => `+ ${l}`)].join("\n");
  }
  const o = oldStr.split("\n");
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let endO = o.length - 1;
  let endN = n.length - 1;
  while (endO >= start && endN >= start && o[endO] === n[endN]) {
    endO--;
    endN--;
  }
  const removed = o.slice(start, endO + 1);
  const added = n.slice(start, endN + 1);
  if (removed.length === 0 && added.length === 0) return "@@ no changes @@";
  return [
    `@@ lines ${start + 1}-${endO + 1} → ${start + 1}-${endN + 1} @@`,
    ...removed.slice(0, maxLines / 2).map((l) => `- ${l}`),
    ...added.slice(0, maxLines / 2).map((l) => `+ ${l}`),
  ].join("\n");
}

/**
 * Proper unified diff (git-apply compatible). Single contiguous hunk with
 * 3 lines of context — sufficient because proposals are whole-file replacements
 * whose changes are computed by common prefix/suffix trimming.
 * Apply from WORKSPACE_ROOT with: git apply <file>.patch
 */
export function unifiedDiff(oldStr: string | null, newStr: string, path: string, context = 3): string {
  const split = (s: string): { arr: string[]; noNl: boolean } => {
    const arr = s.split("\n");
    let noNl = false;
    if (arr[arr.length - 1] === "") arr.pop();
    else noNl = true;
    return { arr, noNl };
  };
  const NO_NL = "\\ No newline at end of file";
  const { arr: n, noNl: nNoNl } = split(newStr);

  if (oldStr === null) {
    const body = n.map((l) => `+${l}`);
    if (nNoNl) body.push(NO_NL);
    return [
      `--- /dev/null`,
      `+++ b/${path}`,
      `@@ -0,0 +${n.length === 0 ? 0 : 1},${n.length} @@`,
      ...body,
    ].join("\n") + "\n";
  }

  const { arr: o, noNl: oNoNl } = split(oldStr);
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;

  const oldChanged = o.slice(p, o.length - s);
  const newChanged = n.slice(p, n.length - s);
  if (oldChanged.length === 0 && newChanged.length === 0) return "";

  const ctxStart = Math.max(0, p - context);
  const ctxBefore = o.slice(ctxStart, p);
  const ctxAfter = o.slice(o.length - s, Math.min(o.length, o.length - s + context));

  const oldCount = ctxBefore.length + oldChanged.length + ctxAfter.length;
  const newCount = ctxBefore.length + newChanged.length + ctxAfter.length;
  const oldStart = oldCount === 0 ? 0 : ctxStart + 1;
  const newStart = newCount === 0 ? 0 : ctxStart + 1;

  const body: string[] = [
    ...ctxBefore.map((l) => ` ${l}`),
    ...oldChanged.map((l) => `-${l}`),
    ...(s === 0 && oNoNl && oldChanged.length > 0 ? [NO_NL] : []),
    ...newChanged.map((l) => `+${l}`),
    ...(s === 0 && nNoNl && newChanged.length > 0 ? [NO_NL] : []),
    ...ctxAfter.map((l) => ` ${l}`),
  ];

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
  ].join("\n") + "\n";
}

export class ProposalManager {
  private store: JsonlStore<Proposal>;

  constructor(
    private readonly rootDir: string = config.workspaceRoot,
    storeName = "proposals",
  ) {
    this.store = new JsonlStore<Proposal>(storeName);
  }

  private safePath(relPath: string): string {
    if (!this.rootDir) throw new Error("WORKSPACE_ROOT is not set");
    const root = resolve(this.rootDir);
    const p = resolve(root, relPath);
    if (p !== root && !p.startsWith(root + "/")) {
      throw new Error(`Path escapes workspace root: ${relPath}`);
    }
    const base = p.split("/").pop() ?? "";
    if (SECRET_PATTERNS.some((re) => re.test(base))) {
      throw new Error(`Refusing to touch secret-like file: ${base}`);
    }
    return p;
  }

  async propose(input: {
    path: string;
    content: string;
    description: string;
    runId?: string;
  }): Promise<Proposal> {
    const abs = this.safePath(input.path);
    const oldContent = await readFile(abs, "utf8").catch(() => null);
    if (oldContent === input.content) throw new Error("Proposed content is identical to the current file");
    const proposal: Proposal = {
      id: randomUUID(),
      runId: input.runId ?? "unknown",
      path: input.path,
      description: input.description,
      oldContent,
      newContent: input.content,
      diff: simpleDiff(oldContent, input.content),
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    this.store.put(proposal);
    logger.info("code change proposed", { id: proposal.id, path: input.path });
    return proposal;
  }

  list(status?: Proposal["status"]): Proposal[] {
    return this.store
      .all()
      .filter((p) => !status || p.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Proposal | undefined {
    return this.store.get(id);
  }

  /** Apply after human review. Fails if the file changed since the proposal. */
  async apply(id: string): Promise<Proposal> {
    const p = this.store.get(id);
    if (!p) throw new Error(`Unknown proposal: ${id}`);
    if (p.status !== "proposed") throw new Error(`Proposal is already ${p.status}`);

    const abs = this.safePath(p.path);
    const current = await readFile(abs, "utf8").catch(() => null);
    if (current !== p.oldContent) {
      const updated = { ...p, status: "rejected" as const, resolvedAt: new Date().toISOString(), error: "File changed on disk since the proposal was created — re-propose against the current version" };
      this.store.put(updated);
      throw new Error(updated.error);
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, p.newContent, "utf8");
    const applied = { ...p, status: "applied" as const, resolvedAt: new Date().toISOString() };
    this.store.put(applied);
    logger.info("proposal applied", { id, path: p.path });
    return applied;
  }

  reject(id: string): Proposal {
    const p = this.store.get(id);
    if (!p) throw new Error(`Unknown proposal: ${id}`);
    if (p.status !== "proposed") throw new Error(`Proposal is already ${p.status}`);
    const rejected = { ...p, status: "rejected" as const, resolvedAt: new Date().toISOString() };
    this.store.put(rejected);
    return rejected;
  }
}

/** Lazy singleton. */
let _proposals: ProposalManager | null = null;
export function proposals(): ProposalManager {
  if (!_proposals) _proposals = new ProposalManager();
  return _proposals;
}
