import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMRequest } from "../src/types/index.js";

/**
 * Tool-budget exhaustion behavior: partial work must never be discarded.
 */
const mockState = vi.hoisted(() => ({
  /** Replies the fake model returns, in order. */
  replies: [] as string[],
  /** Captured system+messages of the LAST call (to assert the closing prompt). */
  lastCall: null as LLMRequest | null,
  calls: 0,
  failOnFinal: false,
}));

vi.mock("../src/foundation/model-gateway.js", () => ({
  modelGateway: {
    complete: vi.fn(async (req: LLMRequest) => {
      mockState.calls++;
      mockState.lastCall = req;
      const last = req.messages[req.messages.length - 1]?.content ?? "";
      const isClosing = last.includes("EXHAUSTED");
      if (isClosing && mockState.failOnFinal) throw new Error("final call failed");
      const text = isClosing
        ? "FINAL: partial findings from gathered evidence"
        : (mockState.replies.shift() ?? 'TOOL_CALL {"tool":"probe","input":{}}');
      return {
        text,
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
        latencyMs: 1,
      };
    }),
    clearRun: vi.fn(),
    getRunUsage: () => 0,
    registerProvider: vi.fn(),
  },
}));

import { BaseAgent } from "../src/agents/base-agent.js";
import { toolRegistry } from "../src/tools/registry.js";
import type { AgentContext, AgentKind } from "../src/types/index.js";

toolRegistry.register({
  name: "probe",
  description: "test probe",
  inputSchema: z.object({}),
  execute: async () => "PROBE_EVIDENCE",
});

class BudgetAgent extends BaseAgent {
  kind: AgentKind = "action"; // action policy allows all tools
  description = "test agent";
  protected systemPrompt(): string {
    return "You are a test agent.";
  }
  setBudget(n: number): this {
    this.maxToolIterations = n;
    return this;
  }
}

function ctx(): AgentContext {
  return {
    runId: "run1",
    traceId: "t1",
    goal: "test goal",
    step: { id: "s1", description: "do the thing", agent: "action", dependsOn: [], status: "running", attempts: 1 },
    priorOutputs: {},
  };
}

beforeEach(() => {
  mockState.replies = [];
  mockState.calls = 0;
  mockState.failOnFinal = false;
  mockState.lastCall = null;
});

describe("tool budget exhaustion", () => {
  it("forces a final answer instead of returning a stub", async () => {
    const agent = new BudgetAgent().setBudget(3); // model always calls tools
    const result = await agent.execute(ctx());

    expect(result.output).toContain("FINAL: partial findings");
    expect(result.output).not.toContain("Reached tool-iteration limit");
    expect(result.toolCalls).toHaveLength(3); // budget respected
    // 3 tool iterations + 1 forced closing call
    expect(mockState.calls).toBe(4);
    expect(mockState.lastCall?.messages.at(-1)?.content).toContain("EXHAUSTED");
  });

  it("falls back to raw evidence if the closing call fails", async () => {
    mockState.failOnFinal = true;
    const agent = new BudgetAgent().setBudget(2);
    const result = await agent.execute(ctx());

    expect(result.output).toContain("PROBE_EVIDENCE"); // work preserved
    expect(result.output).toContain("Tool budget exhausted");
    expect(result.toolCalls).toHaveLength(2);
  });

  it("warns the model as the budget runs low", async () => {
    const agent = new BudgetAgent().setBudget(4);
    await agent.execute(ctx());
    // Warning appears in tool-result messages once 75% of budget is spent.
    const warned = (mockState.lastCall?.messages ?? []).some((m) =>
      m.content.includes("left in your budget"),
    );
    expect(warned).toBe(true);
  });

  it("returns normally when the model answers before the budget runs out", async () => {
    mockState.replies = ['TOOL_CALL {"tool":"probe","input":{}}', "done, here is the answer"];
    const agent = new BudgetAgent().setBudget(10);
    const result = await agent.execute(ctx());

    expect(result.output).toBe("done, here is the answer");
    expect(result.toolCalls).toHaveLength(1);
    expect(mockState.calls).toBe(2); // no forced closing call needed
  });
});
