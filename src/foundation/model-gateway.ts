import type { LLMRequest, LLMResponse } from "../types/index.js";
import type { LLMProvider } from "./providers/anthropic.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { ClaudeCliProvider } from "./providers/claude-cli.js";
import { withRetry } from "../reliability/retry.js";
import { CircuitBreaker } from "../reliability/circuit-breaker.js";
import { BudgetExceededError } from "../reliability/errors.js";
import { events } from "../observability/events.js";
import { config } from "../config/index.js";

/**
 * Model Gateway (Layer 9 — routing, rate limits, cost management).
 * Single choke point for all LLM traffic:
 *  - provider abstraction (add OpenAI etc. by implementing LLMProvider)
 *  - retry with backoff + circuit breaker
 *  - per-run token budget enforcement
 *  - usage events for observability
 */
export class ModelGateway {
  private providers = new Map<string, LLMProvider>();
  private breakers = new Map<string, CircuitBreaker>();
  private defaultProvider: string;
  /** tokens consumed per runId */
  private runUsage = new Map<string, number>();

  constructor(provider: LLMProvider = createDefaultProvider()) {
    this.registerProvider(provider);
    this.defaultProvider = provider.name;
  }

  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    this.breakers.set(provider.name, new CircuitBreaker(`llm:${provider.name}`));
  }

  async complete(
    req: LLMRequest,
    opts: { runId?: string; provider?: string } = {},
  ): Promise<LLMResponse> {
    const name = opts.provider ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Unknown LLM provider: ${name}`);
    const breaker = this.breakers.get(name)!;

    if (opts.runId) {
      const used = this.runUsage.get(opts.runId) ?? 0;
      if (used > config.limits.maxTokensPerTask) {
        throw new BudgetExceededError(
          `Run ${opts.runId} exceeded token budget (${used}/${config.limits.maxTokensPerTask})`,
        );
      }
    }

    const res = await breaker.exec(() =>
      withRetry(() => provider.complete(req), { label: `llm:${name}` }),
    );

    if (opts.runId) {
      const used = this.runUsage.get(opts.runId) ?? 0;
      this.runUsage.set(opts.runId, used + res.usage.inputTokens + res.usage.outputTokens);
      events.emit({
        type: "llm.call",
        runId: opts.runId,
        model: res.model,
        latencyMs: res.latencyMs,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
      });
    }
    return res;
  }

  getRunUsage(runId: string): number {
    return this.runUsage.get(runId) ?? 0;
  }

  clearRun(runId: string): void {
    this.runUsage.delete(runId);
  }
}

/** Picks the provider from config: Claude Code CLI (Pro/Max login) or direct API. */
function createDefaultProvider(): LLMProvider {
  return config.llmProvider === "claude-cli" ? new ClaudeCliProvider() : new AnthropicProvider();
}

export const modelGateway = new ModelGateway();
