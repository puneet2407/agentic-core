import type { AgentContext, Plan, TaskRun, TaskStep } from "../types/index.js";
import { createPlan } from "./planner.js";
import { stateManager } from "./state-manager.js";
import { defaultGuardrails } from "./guardrails.js";
import { agentRegistry } from "../agents/registry.js";
import { events } from "../observability/events.js";
import { config } from "../config/index.js";
import { modelGateway } from "../foundation/model-gateway.js";
import { longTermMemory } from "../memory/long-term.js";
import { shortTermMemory } from "../memory/short-term.js";
import { logger } from "../observability/logger.js";

/**
 * Orchestrator / Workflow Engine (Layer 2).
 *
 * Flow (matches the reference architecture's numbered legend):
 *  1. Request enters → guardrails check input
 *  2. Planner decomposes the goal into a step DAG; agents are selected per step
 *  3. Steps execute (parallel where the DAG allows), agents use tools & memory
 *  4. Failures are retried, then routed to fallback agents; state is updated throughout
 *  5. Every stage emits observability events
 */
export class Orchestrator {
  async run(goal: string): Promise<TaskRun> {
    const run = stateManager.createRun(goal);
    events.emit({ type: "run.started", runId: run.id, goal });

    try {
      // 1 — input guardrails
      const inputVerdict = await defaultGuardrails.checkInput(goal);
      if (!inputVerdict.allowed) {
        events.emit({ type: "guardrail.blocked", runId: run.id, reason: inputVerdict.reason! });
        return stateManager.finish(run.id, "rejected", inputVerdict.reason!);
      }

      // 2 — plan
      const plan = await createPlan(goal, run.id);
      stateManager.update(run.id, { plan, status: "running" });
      events.emit({ type: "plan.created", runId: run.id, plan });

      // 3/4 — execute the DAG
      const outputs = await this.executePlan(run.id, plan);

      // Final result = output of the last completed step (usually communication)
      const lastStep = [...plan.steps].reverse().find((s) => s.status === "completed");
      const result = lastStep?.output ?? Object.values(outputs).pop() ?? "No output produced.";

      // output guardrails
      const outputVerdict = await defaultGuardrails.checkOutput(result);
      if (!outputVerdict.allowed) {
        events.emit({ type: "guardrail.blocked", runId: run.id, reason: outputVerdict.reason! });
        return stateManager.finish(run.id, "rejected", outputVerdict.reason!);
      }

      // persist a summary to long-term memory for future recall
      await longTermMemory.remember(`Goal: ${goal}\nResult: ${result.slice(0, 1000)}`, {
        runId: run.id,
        kind: "run-summary",
      });

      events.emit({ type: "run.completed", runId: run.id, result });
      return stateManager.finish(run.id, "completed", result);
    } catch (err) {
      const message = String(err);
      logger.error("run failed", { runId: run.id, error: message });
      events.emit({ type: "run.failed", runId: run.id, error: message });
      return stateManager.finish(run.id, "failed", message);
    } finally {
      shortTermMemory.clear(run.id);
      modelGateway.clearRun(run.id);
    }
  }

  /** Execute steps respecting dependencies; independent steps run in parallel. */
  private async executePlan(runId: string, plan: Plan): Promise<Record<string, string>> {
    const outputs: Record<string, string> = {};
    const done = new Set<string>();

    while (done.size < plan.steps.length) {
      const ready = plan.steps.filter(
        (s) => s.status === "pending" && s.dependsOn.every((d) => done.has(d)),
      );
      if (ready.length === 0) {
        const stuck = plan.steps.filter((s) => s.status === "pending").map((s) => s.id);
        throw new Error(`Deadlocked plan — unrunnable steps: ${stuck.join(", ")}`);
      }

      await Promise.all(
        ready.map(async (step) => {
          await this.executeStep(runId, plan.goal, step, outputs);
          done.add(step.id);
        }),
      );
    }
    return outputs;
  }

  /** Execute one step with retries, then fallback agent (Layer 7). */
  private async executeStep(
    runId: string,
    goal: string,
    step: TaskStep,
    outputs: Record<string, string>,
  ): Promise<void> {
    step.status = "running";
    events.emit({ type: "step.started", runId, stepId: step.id, agent: step.agent });

    const ctx: AgentContext = {
      runId,
      traceId: runId,
      goal,
      step,
      priorOutputs: Object.fromEntries(step.dependsOn.map((d) => [d, outputs[d] ?? ""])),
    };

    const primary = agentRegistry.get(step.agent);
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.limits.maxStepAttempts; attempt++) {
      step.attempts = attempt;
      try {
        const result = await primary.execute(ctx);
        step.status = "completed";
        step.output = result.output;
        outputs[step.id] = result.output;
        events.emit({ type: "step.completed", runId, stepId: step.id });
        return;
      } catch (err) {
        lastError = err;
        logger.warn("step attempt failed", { runId, stepId: step.id, attempt, error: String(err) });
      }
    }

    // Fallback agent (Layer 7 — Fallback / Alternate Agents)
    const fallback = agentRegistry.fallbackFor(step.agent);
    if (fallback) {
      logger.info("using fallback agent", { runId, stepId: step.id, fallback: fallback.kind });
      try {
        const result = await fallback.execute(ctx);
        step.status = "completed";
        step.output = `[via fallback:${fallback.kind}] ${result.output}`;
        outputs[step.id] = step.output;
        events.emit({ type: "step.completed", runId, stepId: step.id });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    step.status = "failed";
    step.error = String(lastError);
    events.emit({ type: "step.failed", runId, stepId: step.id, error: step.error });
    throw new Error(`Step ${step.id} (${step.agent}) failed: ${step.error}`);
  }
}

export const orchestrator = new Orchestrator();
