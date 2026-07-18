import type { Agent, AgentKind } from "../types/index.js";
import {
  ActionAgent,
  CommunicationAgent,
  DataAgent,
  ReasoningAgent,
  ResearchAgent,
} from "./specialists.js";

/**
 * Agent Registry (Layer 3 + Layer 2 Agent Selection).
 * The orchestrator selects agents by kind; register custom agents here.
 * Fallback chains (Layer 7): if an agent kind fails repeatedly, the
 * orchestrator can consult `fallbackFor` to try an alternate.
 */
export class AgentRegistry {
  private agents = new Map<AgentKind, Agent>();
  private fallbacks = new Map<AgentKind, AgentKind>([
    // A failed action can often be salvaged by reasoning about alternatives.
    ["action", "reasoning"],
    ["research", "reasoning"],
    ["data", "reasoning"],
  ]);

  register(agent: Agent): void {
    this.agents.set(agent.kind, agent);
  }

  get(kind: AgentKind): Agent {
    const agent = this.agents.get(kind);
    if (!agent) throw new Error(`No agent registered for kind: ${kind}`);
    return agent;
  }

  fallbackFor(kind: AgentKind): Agent | undefined {
    const fb = this.fallbacks.get(kind);
    return fb ? this.agents.get(fb) : undefined;
  }

  catalogText(): string {
    return [...this.agents.values()]
      .map((a) => `- ${a.kind}: ${a.description}`)
      .join("\n");
  }
}

export const agentRegistry = new AgentRegistry();
agentRegistry.register(new ResearchAgent());
agentRegistry.register(new ReasoningAgent());
agentRegistry.register(new ActionAgent());
agentRegistry.register(new DataAgent());
agentRegistry.register(new CommunicationAgent());
