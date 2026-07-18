import type { TaskRun } from "../types/index.js";

/**
 * Episodic / Event Store (Layer 5) — history of completed runs.
 * In-memory ring buffer for dev; replace with Postgres for durability.
 */
export class EpisodicStore {
  private runs: TaskRun[] = [];

  constructor(private readonly maxRuns = 200) {}

  save(run: TaskRun): void {
    this.runs = this.runs.filter((r) => r.id !== run.id);
    this.runs.push(run);
    while (this.runs.length > this.maxRuns) this.runs.shift();
  }

  get(runId: string): TaskRun | undefined {
    return this.runs.find((r) => r.id === runId);
  }

  list(limit = 50): TaskRun[] {
    return this.runs.slice(-limit).reverse();
  }
}

export const episodicStore = new EpisodicStore();
