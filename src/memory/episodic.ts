import type { TaskRun } from "../types/index.js";
import { JsonlStore } from "../persistence/jsonl-store.js";

/**
 * Episodic / Event Store (Layer 5) — history of completed runs.
 * Backed by an append-only JSONL file, so history survives restarts.
 * Swap JsonlStore for Postgres when you need multi-node or SQL queries.
 */
export class EpisodicStore {
  private store: JsonlStore<TaskRun>;

  constructor(name = "runs", private readonly maxRuns = 1000) {
    this.store = new JsonlStore<TaskRun>(name);
    this.prune();
  }

  save(run: TaskRun): void {
    this.store.put(run);
    this.prune();
  }

  get(runId: string): TaskRun | undefined {
    return this.store.get(runId);
  }

  list(limit = 50): TaskRun[] {
    return this.sorted().slice(0, limit);
  }

  private sorted(): TaskRun[] {
    return this.store.all().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private prune(): void {
    const all = this.sorted();
    for (const old of all.slice(this.maxRuns)) this.store.delete(old.id);
  }
}

export const episodicStore = new EpisodicStore();
