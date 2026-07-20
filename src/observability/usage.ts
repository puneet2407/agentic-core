import type { SystemEvent } from "../types/index.js";
import { events } from "./events.js";
import { readRunEvents } from "./audit.js";

/**
 * Per-run token accounting (Layer 6).
 * Live totals come from the event bus; historical breakdowns are reconstructed
 * from the durable audit log, so usage for ANY past run stays queryable after
 * a restart. Exposed at GET /tasks/:id/usage.
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  llmCalls: number;
}

export interface UsageBreakdown extends UsageTotals {
  runId: string;
  latencyMsTotal: number;
  byStep: (UsageTotals & { stepId: string; agent?: string })[];
  byModel: (UsageTotals & { model: string })[];
}

const empty = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  llmCalls: 0,
});

function add(t: UsageTotals, inTok: number, outTok: number): void {
  t.inputTokens += inTok;
  t.outputTokens += outTok;
  t.totalTokens += inTok + outTok;
  t.llmCalls += 1;
}

/** Live totals for in-flight runs (cleared when a run finishes). */
class UsageTracker {
  private live = new Map<string, UsageTotals>();

  record(e: Extract<SystemEvent, { type: "llm.call" }>): void {
    const t = this.live.get(e.runId) ?? empty();
    add(t, e.inputTokens, e.outputTokens);
    this.live.set(e.runId, t);
  }

  get(runId: string): UsageTotals {
    return { ...(this.live.get(runId) ?? empty()) };
  }

  clear(runId: string): void {
    this.live.delete(runId);
  }
}

export const usageTracker = new UsageTracker();

events.on((e) => {
  if (e.type === "llm.call") usageTracker.record(e);
});

/** Full breakdown for any run (live or historical), rebuilt from the audit log. */
export function getRunUsage(runId: string): UsageBreakdown {
  const total = empty();
  const steps = new Map<string, UsageTotals & { stepId: string; agent?: string }>();
  const models = new Map<string, UsageTotals & { model: string }>();
  let latencyMsTotal = 0;

  for (const entry of readRunEvents(runId, 10_000)) {
    const e = entry.event;
    if (e.type !== "llm.call") continue;
    add(total, e.inputTokens, e.outputTokens);
    latencyMsTotal += e.latencyMs;

    const stepId = e.stepId ?? "(unattributed)";
    const step = steps.get(stepId) ?? { ...empty(), stepId, ...(e.agent ? { agent: e.agent } : {}) };
    add(step, e.inputTokens, e.outputTokens);
    steps.set(stepId, step);

    const model = models.get(e.model) ?? { ...empty(), model: e.model };
    add(model, e.inputTokens, e.outputTokens);
    models.set(e.model, model);
  }

  return {
    runId,
    ...total,
    latencyMsTotal,
    byStep: [...steps.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}
