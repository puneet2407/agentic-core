import { randomUUID } from "node:crypto";
import type { RunStatus, TaskRun } from "../types/index.js";
import { episodicStore } from "../memory/episodic.js";

/**
 * State & Context Manager (Layer 2).
 * Tracks live runs in memory; persists finished runs to the episodic store.
 * For horizontal scaling, back this with Redis/Postgres.
 */
export class StateManager {
  private active = new Map<string, TaskRun>();
  private cancelRequests = new Set<string>();

  createRun(goal: string): TaskRun {
    const run: TaskRun = {
      id: randomUUID(),
      goal,
      status: "planning",
      context: {},
      usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
      startedAt: new Date().toISOString(),
      traceId: randomUUID(),
    };
    this.active.set(run.id, run);
    return run;
  }

  get(runId: string): TaskRun | undefined {
    return this.active.get(runId) ?? episodicStore.get(runId);
  }

  update(runId: string, patch: Partial<TaskRun>): TaskRun {
    const run = this.active.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    Object.assign(run, patch);
    return run;
  }

  finish(runId: string, status: RunStatus, resultOrError: string): TaskRun {
    const run = this.update(runId, {
      status,
      finishedAt: new Date().toISOString(),
      ...(status === "completed" ? { result: resultOrError } : { error: resultOrError }),
    });
    episodicStore.save({ ...run });
    this.active.delete(runId);
    this.cancelRequests.delete(runId);
    return run;
  }

  listActive(): TaskRun[] {
    return [...this.active.values()];
  }

  /** Request cooperative cancellation; honored at the next step boundary. */
  requestCancel(runId: string): boolean {
    if (!this.active.has(runId)) return false;
    this.cancelRequests.add(runId);
    return true;
  }

  isCancelRequested(runId: string): boolean {
    return this.cancelRequests.has(runId);
  }
}

export const stateManager = new StateManager();
