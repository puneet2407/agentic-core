import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../src/types/index.js";

/**
 * Orchestrator integration tests with a mocked model gateway.
 * The mock routes on the system prompt: planner prompts get plans from a
 * queue; agent prompts either fail (if listed in failAgents) or answer.
 */
const mockState = vi.hoisted(() => ({
  planQueue: [] as string[],
  failAgents: [] as string[],
  finalAnswer: "the final answer",
  plannerCalls: 0,
}));

const DEFAULT_PLAN = JSON.stringify({
  steps: [{ id: "s1", description: "answer the user", agent: "communication", dependsOn: [] }],
});

vi.mock("../src/foundation/model-gateway.js", () => ({
  modelGateway: {
    complete: vi.fn(async (req: LLMRequest) => {
      const system = req.system ?? "";
      let text: string;
      if (system.includes("You are the Planner")) {
        mockState.plannerCalls++;
        text = mockState.planQueue.shift() ?? DEFAULT_PLAN;
      } else {
        const failing = mockState.failAgents.find((name) => system.includes(name));
        if (failing) throw new Error(`${failing} exploded`);
        text = mockState.finalAnswer;
      }
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

import { orchestrator } from "../src/orchestration/orchestrator.js";
import { stateManager } from "../src/orchestration/state-manager.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  mockState.planQueue = [];
  mockState.failAgents = [];
  mockState.finalAnswer = "the final answer";
  mockState.plannerCalls = 0;
});

describe("Orchestrator", () => {
  it("completes a simple run end to end", async () => {
    const run = await orchestrator.run("say hello");
    expect(run.status).toBe("completed");
    expect(run.result).toBe("the final answer");
    expect(run.plan?.steps[0]!.status).toBe("completed");
  });

  it("rejects guardrail-blocked input", async () => {
    const run = await orchestrator.run("  ");
    expect(run.status).toBe("rejected");
  });

  it("redacts PII in the final result instead of blocking", async () => {
    mockState.finalAnswer = "Your card 4111 1111 1111 1111 is on file.";
    const run = await orchestrator.run("what card is on file?");
    expect(run.status).toBe("completed");
    expect(run.result).toContain("[REDACTED CREDIT CARD]");
    expect(run.result).not.toContain("4111");
  });

  it("replans when a step fails after retries and fallback", async () => {
    // Plan 1 needs research; both research AND its reasoning fallback fail.
    mockState.planQueue = [
      JSON.stringify({
        steps: [{ id: "s1", description: "look it up", agent: "research", dependsOn: [] }],
      }),
      // Revised plan avoids the failing agents.
      DEFAULT_PLAN,
    ];
    mockState.failAgents = ["Research Agent", "Reasoning Agent"];

    const run = await orchestrator.run("find the thing");
    expect(run.status).toBe("completed");
    expect(run.result).toBe("the final answer");
    expect(mockState.plannerCalls).toBe(2); // original + revision
  });

  it("fails the run when replans are exhausted", async () => {
    const failingPlan = JSON.stringify({
      steps: [{ id: "s1", description: "look it up", agent: "research", dependsOn: [] }],
    });
    mockState.planQueue = [failingPlan, failingPlan, failingPlan];
    mockState.failAgents = ["Research Agent", "Reasoning Agent"];

    const run = await orchestrator.run("find the thing");
    expect(run.status).toBe("failed");
  });

  it("pauses for plan approval and resumes on approve", async () => {
    const promise = orchestrator.run("needs sign-off", { approvePlan: true });
    await waitFor(() =>
      stateManager.listActive().some((r) => r.status === "awaiting_approval"),
    );
    const paused = stateManager.listActive().find((r) => r.status === "awaiting_approval")!;

    expect(orchestrator.approve(paused.id)).toBe(true);
    const run = await promise;
    expect(run.status).toBe("completed");
  });

  it("cancels a run awaiting approval", async () => {
    const promise = orchestrator.run("needs sign-off", { approvePlan: true });
    await waitFor(() =>
      stateManager.listActive().some((r) => r.status === "awaiting_approval"),
    );
    const paused = stateManager.listActive().find((r) => r.status === "awaiting_approval")!;

    expect(orchestrator.cancel(paused.id)).toBe(true);
    const run = await promise;
    expect(run.status).toBe("cancelled");
  });

  it("approve() on an unknown run returns false", () => {
    expect(orchestrator.approve("nope")).toBe(false);
  });
});
