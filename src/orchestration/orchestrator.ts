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
import { CancelledError, RunTimeoutError } from "../reliability/errors.js";

export interface RunOptions {
  /**
   * Human-in-the-loop (Layer 7): when true, the run pauses after planning
   * (status "awaiting_approval") until approve(runId) or cancellation.
   */
  approvePlan?: boolean;
}

/**
 * Orchestrator / Workflow Engine (Layer 2).
 *
 * Flow (matches the reference architecture's numbered legend):
 *  1. Request enters → guardrails check input
 *  2. Planner decomposes the goal into a step DAG; agents are selected per step
 *     (optionally paused for human plan approval)
 *  3. Steps execute (parallel where the DAG allows), agents use tools & memory
 *  4. Failures are retried, routed to fallback agents, and — if the plan still
 *     fails — the planner produces a revised plan (adaptive replanning)
 *  5. Every stage emits observability events
 *
 * Run controls: wall-clock timeout (config.limits.maxRunMs) and cooperative
 * cancellation, both checked at step boundaries.
 */
export class Orchestrator {
  /** Runs paused for human approval: runId → resume/abort handles. */
  private pendingApprovals = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();

  async run(goal: string, opts: RunOptions = {}): Promise<TaskRun> {
    const run = stateManager.createRun(goal);
    const deadline = Date.now() + config.limits.maxRunMs;
    events.emit({ type: "run.started", runId: run.id, goal });

    try {
      // 1 — input guardrails
      const inputVerdict = await defaultGuardrails.checkInput(goal);
      if (!inputVerdict.allowed) {
        events.emit({ type: "guardrail.blocked", runId: run.id, reason: inputVerdict.reason! });
        return stateManager.finish(run.id, "rejected", inputVerdict.reason!);
      }

      // 2 — plan (with adaptive replanning on failure)
      let plan = await createPlan(goal, run.id);
      stateManager.update(run.id, { plan, status: "running" });
      events.emit({ type: "plan.created", runId: run.id, plan });

      // 2b — optional human-in-the-loop plan approval
      if (opts.approvePlan) {
        await this.awaitApproval(run.id, deadline);
        stateManager.update(run.id, { status: "running" });
        events.emit({ type: "run.approved", runId: run.id });
      }

      // 3/4 — execute; on plan failure, ask the planner for a revised plan
      let outputs: Record<string, string> = {};
      for (let replan = 0; ; replan++) {
        try {
          outputs = await this.executePlan(run.id, plan, deadline);
          break;
        } catch (err) {
          if (
            err instanceof CancelledError ||
            err instanceof RunTimeoutError ||
            replan >= config.limits.maxReplans
          ) {
            throw err;
          }
          const failed = plan.steps.find((s) => s.status === "failed");
          const failure = failed
            ? `Step "${failed.id}" (${failed.agent}: ${failed.description}) failed after retries and fallback: ${failed.error}`
            : String(err);
          const completedWork = plan.steps
            .filter((s) => s.status === "completed" && s.output)
            .map((s) => `- ${s.description}: ${s.output!.slice(0, 300)}`)
            .join("\n");

          logger.warn("plan failed — replanning", { runId: run.id, replan: replan + 1, failure });
          events.emit({ type: "plan.revised", runId: run.id, replan: replan + 1, reason: failure });

          plan = await createPlan(goal, run.id, { failure, completedWork });
          stateManager.update(run.id, { plan });
          events.emit({ type: "plan.created", runId: run.id, plan });
        }
      }

      // Final result = output of the last completed step (usually communication)
      const lastStep = [...plan.steps].reverse().find((s) => s.status === "completed");
      let result = lastStep?.output ?? Object.values(outputs).pop() ?? "No output produced.";

      // output guardrails (may redact rather than block)
      const outputVerdict = await defaultGuardrails.checkOutput(result);
      if (!outputVerdict.allowed) {
        events.emit({ type: "guardrail.blocked", runId: run.id, reason: outputVerdict.reason! });
        return stateManager.finish(run.id, "rejected", outputVerdict.reason!);
      }
      if (outputVerdict.output !== undefined) {
        events.emit({
          type: "guardrail.redacted",
          runId: run.id,
          guardrail: "output-pipeline",
          reason: outputVerdict.reason ?? "content transformed",
        });
        result = outputVerdict.output;
      }

      // persist a summary to long-term memory for future recall.
      // provenance "derived": recall sites must treat this as untrusted data.
      await longTermMemory.remember(
        `Goal: ${goal}\nResult: ${result.slice(0, 1000)}`,
        { runId: run.id, kind: "run-summary" },
        { provenance: "derived" },
      );

      events.emit({ type: "run.completed", runId: run.id, result });
      return stateManager.finish(run.id, "completed", result);
    } catch (err) {
      if (err instanceof CancelledError) {
        events.emit({ type: "run.cancelled", runId: run.id, reason: err.message });
        return stateManager.finish(run.id, "cancelled", err.message);
      }
      const message = String(err);
      logger.error("run failed", { runId: run.id, error: message });
      events.emit({ type: "run.failed", runId: run.id, error: message });
      return stateManager.finish(run.id, "failed", message);
    } finally {
      this.pendingApprovals.delete(run.id);
      shortTermMemory.clear(run.id);
      modelGateway.clearRun(run.id);
    }
  }

  /** Approve a run paused in "awaiting_approval". Returns false if none pending. */
  approve(runId: string): boolean {
    const pending = this.pendingApprovals.get(runId);
    if (!pending) return false;
    this.pendingApprovals.delete(runId);
    pending.resolve();
    return true;
  }

  /** Cancel a run: honored immediately if awaiting approval, else at the next step boundary. */
  cancel(runId: string): boolean {
    const requested = stateManager.requestCancel(runId);
    const pending = this.pendingApprovals.get(runId);
    if (pending) {
      this.pendingApprovals.delete(runId);
      pending.reject(new CancelledError("Cancelled while awaiting plan approval"));
    }
    return requested || !!pending;
  }

  private awaitApproval(runId: string, deadline: number): Promise<void> {
    stateManager.update(runId, { status: "awaiting_approval" });
    events.emit({ type: "run.awaiting_approval", runId });
    return new Promise<void>((resolve, reject) => {
      this.pendingApprovals.set(runId, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(runId);
        reject(new RunTimeoutError("Plan approval not received before run deadline"));
      }, Math.max(0, deadline - Date.now()));
      timer.unref?.();
    });
  }

  private checkRunHealth(runId: string, deadline: number): void {
    if (stateManager.isCancelRequested(runId)) throw new CancelledError();
    if (Date.now() > deadline) {
      throw new RunTimeoutError(
        `Run exceeded wall-clock budget of ${config.limits.maxRunMs}ms`,
      );
    }
  }

  /** Execute steps respecting dependencies; independent steps run in parallel. */
  private async executePlan(
    runId: string,
    plan: Plan,
    deadline: number,
  ): Promise<Record<string, string>> {
    const outputs: Record<string, string> = {};
    const done = new Set<string>();

    while (done.size < plan.steps.length) {
      this.checkRunHealth(runId, deadline);

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
