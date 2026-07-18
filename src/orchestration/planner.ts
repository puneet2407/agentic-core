import { z } from "zod";
import type { Plan } from "../types/index.js";
import { modelGateway } from "../foundation/model-gateway.js";
import { agentRegistry } from "../agents/registry.js";
import { config } from "../config/index.js";
import { AgentError } from "../reliability/errors.js";
import { withRetry } from "../reliability/retry.js";

/**
 * Task Decomposition (Layer 2).
 * The planner LLM breaks a goal into a DAG of steps, each assigned to a
 * specialized agent. Output is zod-validated; malformed plans are retried.
 */

const planSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        agent: z.enum(["research", "reasoning", "action", "data", "communication"]),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

const SYSTEM = `You are the Planner of a multi-agent AI system. Decompose the user's goal into the smallest set of steps that accomplishes it.

Available agent types:
{AGENTS}

Rules:
- Use as FEW steps as possible (1 step is fine for simple goals). Max {MAX} steps.
- Each step gets a short unique id (s1, s2, ...), a clear description, an agent type, and dependsOn (ids of prerequisite steps).
- Steps with no dependency ordering conflicts may run in parallel.
- The FINAL step should usually be a "communication" step that synthesizes results for the user, unless the goal is trivially simple.
- Respond with ONLY a JSON object: {"steps":[{"id":"s1","description":"...","agent":"research","dependsOn":[]}]}`;

export interface PlanRevision {
  /** What went wrong in the previous plan (failed step + error). */
  failure: string;
  /** Outputs of steps that already completed — the new plan should not redo them. */
  completedWork: string;
}

export async function createPlan(
  goal: string,
  runId: string,
  revision?: PlanRevision,
): Promise<Plan> {
  const system = SYSTEM.replace("{AGENTS}", agentRegistry.catalogText()).replace(
    "{MAX}",
    String(config.limits.maxStepsPerTask),
  );

  const userMessage = revision
    ? [
        `Goal: ${goal}`,
        `\nA previous plan FAILED. Produce a REVISED plan that reaches the goal a different way.`,
        `# What failed\n${revision.failure}`,
        revision.completedWork
          ? `# Work already completed (do NOT redo; a step may reference it as given context)\n${revision.completedWork}`
          : "",
        `Avoid the approach that failed — choose different steps, agents, or tools.`,
      ]
        .filter(Boolean)
        .join("\n\n")
    : `Goal: ${goal}`;

  const plan = await withRetry(
    async () => {
      const res = await modelGateway.complete(
        {
          model: config.models.planner,
          system,
          messages: [{ role: "user", content: userMessage }],
          maxTokens: 2048,
        },
        { runId },
      );
      const json = extractJson(res.text);
      const parsed = planSchema.safeParse(json);
      if (!parsed.success) {
        throw new AgentError(`Planner returned invalid plan: ${parsed.error.message}`, true);
      }
      validateDag(parsed.data.steps);
      return parsed.data;
    },
    { attempts: 3, label: "planner" },
  );

  return {
    goal,
    createdAt: new Date().toISOString(),
    steps: plan.steps.slice(0, config.limits.maxStepsPerTask).map((s) => ({
      ...s,
      status: "pending" as const,
      attempts: 0,
    })),
  };
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new AgentError("Planner response contained no JSON", true);
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new AgentError("Planner response contained malformed JSON", true);
  }
}

/** Exported for tests. Throws on duplicate ids, unknown deps, or cycles. */
export function validateDag(steps: { id: string; dependsOn: string[] }[]): void {
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) throw new AgentError("Plan has duplicate step ids", true);
  for (const s of steps) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) throw new AgentError(`Step ${s.id} depends on unknown step ${dep}`, true);
    }
  }
  // Cycle check via repeated pruning of resolvable steps.
  const resolved = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const s of steps) {
      if (!resolved.has(s.id) && s.dependsOn.every((d) => resolved.has(d))) {
        resolved.add(s.id);
        progress = true;
      }
    }
  }
  if (resolved.size !== steps.length) throw new AgentError("Plan contains a dependency cycle", true);
}
