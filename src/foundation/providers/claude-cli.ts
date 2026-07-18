import { spawn } from "node:child_process";
import type { LLMRequest, LLMResponse } from "../../types/index.js";
import type { LLMProvider } from "./anthropic.js";
import { config } from "../../config/index.js";
import { AgentError } from "../../reliability/errors.js";

/**
 * ClaudeCliProvider — uses the Claude Code CLI (`claude -p`) instead of the API.
 * Works with a Claude Pro/Max subscription: the CLI authenticates via your
 * `claude` login (run `claude` once interactively to sign in), no API key needed.
 *
 * Trade-offs vs the API:
 *  - Higher latency per call (CLI process spawn + agent runtime)
 *  - Subject to your plan's usage limits
 *  - Multi-turn conversations are flattened into a single transcript prompt
 */
export class ClaudeCliProvider implements LLMProvider {
  readonly name = "claude-cli";

  constructor(private readonly cliPath = process.env.CLAUDE_CLI_PATH ?? "claude") {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const prompt = flattenMessages(req);

    const args = [
      "-p", // print mode (non-interactive)
      "--output-format", "json",
      "--model", req.model ?? config.models.default,
    ];
    if (req.system) args.push("--append-system-prompt", req.system);

    const raw = await this.spawnCli(args, prompt);
    const parsed = parseCliJson(raw);

    return {
      text: parsed.result,
      model: req.model ?? config.models.default,
      usage: parsed.usage,
      stopReason: parsed.subtype === "success" ? "end_turn" : parsed.subtype,
      latencyMs: Date.now() - start,
    };
  }

  private spawnCli(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cliPath, args, {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new AgentError(`claude CLI timed out after ${config.limits.requestTimeoutMs}ms`, true));
      }, config.limits.requestTimeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      child.on("error", (err) => {
        clearTimeout(timer);
        const hint =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? ` — is the Claude Code CLI installed and on PATH? (npm install -g @anthropic-ai/claude-code, then run \`claude\` once to sign in). You can also set CLAUDE_CLI_PATH.`
            : "";
        reject(new AgentError(`Failed to spawn claude CLI: ${err.message}${hint}`, false, err));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // Rate-limit / transient errors are retryable; auth errors are not.
          const retryable = !/login|auth|unauthorized/i.test(stderr);
          reject(new AgentError(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`, retryable));
        } else {
          resolve(stdout);
        }
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

/** The CLI takes one prompt, so multi-turn history is rendered as a transcript. */
function flattenMessages(req: LLMRequest): string {
  const nonSystem = req.messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 1) return nonSystem[0]!.content;
  return (
    nonSystem
      .map((m) => (m.role === "user" ? `[User]\n${m.content}` : `[Assistant]\n${m.content}`))
      .join("\n\n") + "\n\n[User]\nContinue from the conversation above. Respond as the assistant."
  );
}

interface CliResult {
  result: string;
  subtype: string;
  usage: { inputTokens: number; outputTokens: number };
}

function parseCliJson(raw: string): CliResult {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AgentError(`claude CLI returned non-JSON output: ${raw.slice(0, 300)}`, true);
  }
  if (json.is_error === true || typeof json.result !== "string") {
    throw new AgentError(`claude CLI error result: ${JSON.stringify(json).slice(0, 500)}`, true);
  }
  const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    result: json.result,
    subtype: typeof json.subtype === "string" ? json.subtype : "success",
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    },
  };
}
