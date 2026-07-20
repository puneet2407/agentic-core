import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { events } from "../src/observability/events.js";
import "../src/observability/audit.js"; // audit listener must be registered
import { getRunUsage, usageTracker } from "../src/observability/usage.js";

describe("per-run token usage", () => {
  it("aggregates totals, per-step and per-model from the audit trail", () => {
    const runId = randomUUID();
    events.emit({ type: "run.started", runId, goal: "test" });
    events.emit({ type: "llm.call", runId, model: "sonnet", latencyMs: 100, inputTokens: 1000, outputTokens: 200, stepId: "planner" });
    events.emit({ type: "llm.call", runId, model: "sonnet", latencyMs: 200, inputTokens: 3000, outputTokens: 500, stepId: "s1", agent: "code" });
    events.emit({ type: "llm.call", runId, model: "sonnet", latencyMs: 150, inputTokens: 2000, outputTokens: 300, stepId: "s1", agent: "code" });
    events.emit({ type: "llm.call", runId, model: "haiku", latencyMs: 50, inputTokens: 500, outputTokens: 100, stepId: "s2", agent: "communication" });

    const u = getRunUsage(runId);
    expect(u.inputTokens).toBe(6500);
    expect(u.outputTokens).toBe(1100);
    expect(u.totalTokens).toBe(7600);
    expect(u.llmCalls).toBe(4);
    expect(u.latencyMsTotal).toBe(500);

    // Steps sorted by cost — s1 is the expensive one.
    expect(u.byStep[0]!.stepId).toBe("s1");
    expect(u.byStep[0]!.totalTokens).toBe(5800);
    expect(u.byStep[0]!.agent).toBe("code");
    expect(u.byStep[0]!.llmCalls).toBe(2);

    expect(u.byModel[0]!.model).toBe("sonnet");
    expect(u.byModel[0]!.totalTokens).toBe(7000);
    expect(u.byModel.find((m) => m.model === "haiku")?.totalTokens).toBe(600);
  });

  it("isolates usage per run", () => {
    const a = randomUUID();
    const b = randomUUID();
    events.emit({ type: "llm.call", runId: a, model: "m", latencyMs: 1, inputTokens: 10, outputTokens: 5, stepId: "s1" });
    events.emit({ type: "llm.call", runId: b, model: "m", latencyMs: 1, inputTokens: 70, outputTokens: 30, stepId: "s1" });

    expect(getRunUsage(a).totalTokens).toBe(15);
    expect(getRunUsage(b).totalTokens).toBe(100);
  });

  it("tracks live totals and clears them when a run finishes", () => {
    const runId = randomUUID();
    events.emit({ type: "llm.call", runId, model: "m", latencyMs: 1, inputTokens: 40, outputTokens: 10 });
    expect(usageTracker.get(runId).totalTokens).toBe(50);
    expect(usageTracker.get(runId).llmCalls).toBe(1);

    usageTracker.clear(runId);
    expect(usageTracker.get(runId).totalTokens).toBe(0);
  });

  it("returns zeros for an unknown run", () => {
    const u = getRunUsage(randomUUID());
    expect(u.totalTokens).toBe(0);
    expect(u.byStep).toEqual([]);
  });
});
