import Anthropic from "@anthropic-ai/sdk";
import type { LLMRequest, LLMResponse } from "../../types/index.js";
import { config } from "../../config/index.js";
import { AgentError } from "../../reliability/errors.js";

export interface LLMProvider {
  name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey = config.anthropicApiKey) {
    if (!apiKey) throw new AgentError("ANTHROPIC_API_KEY is not set", false);
    this.client = new Anthropic({ apiKey, timeout: config.limits.requestTimeoutMs });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    try {
      const res = await this.client.messages.create({
        model: req.model ?? config.models.default,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
        system: req.system,
        messages: req.messages.filter((m) => m.role !== "system") as {
          role: "user" | "assistant";
          content: string;
        }[],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        text,
        model: res.model,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        stopReason: res.stop_reason,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      // 4xx (except 429) are not retryable; 429/5xx/network are.
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new AgentError(`Anthropic API error: ${String(err)}`, retryable, err);
    }
  }
}
