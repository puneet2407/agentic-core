import type { ToolDefinition } from "../types/index.js";
import { events } from "../observability/events.js";
import { AgentError } from "../reliability/errors.js";

/**
 * Tool Registry (Layer 4 — Tools & Integrations).
 * Central catalog of everything agents can call.
 * Inputs are zod-validated before execution; every call emits an event.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never>>();

  register<I>(tool: ToolDefinition<I>): void {
    this.tools.set(tool.name, tool as ToolDefinition<never>);
  }

  get(name: string): ToolDefinition<never> | undefined {
    return this.tools.get(name);
  }

  list(): { name: string; description: string }[] {
    return [...this.tools.values()].map(({ name, description }) => ({ name, description }));
  }

  /** Prompt-friendly catalog for agent system prompts. */
  catalogText(): string {
    return this.list()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");
  }

  async execute(name: string, input: unknown, runId = "unknown"): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new AgentError(`Unknown tool: ${name}`, false);

    const parsed = (tool.inputSchema as { safeParse(i: unknown): { success: boolean; data?: unknown; error?: unknown } }).safeParse(input);
    if (!parsed.success) {
      throw new AgentError(`Invalid input for tool ${name}: ${String(parsed.error)}`, false);
    }

    const start = Date.now();
    try {
      const output = await (tool as ToolDefinition<unknown>).execute(parsed.data);
      events.emit({ type: "tool.call", runId, tool: name, ok: true, latencyMs: Date.now() - start });
      return output;
    } catch (err) {
      events.emit({ type: "tool.call", runId, tool: name, ok: false, latencyMs: Date.now() - start });
      throw err;
    }
  }
}

export const toolRegistry = new ToolRegistry();
