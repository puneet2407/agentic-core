import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LLMRequest, LLMResponse } from "../../types/index.js";
import type { LLMProvider } from "./anthropic.js";
import { config } from "../../config/index.js";
import { AgentError } from "../../reliability/errors.js";
import { logger } from "../../observability/logger.js";

/**
 * The CLI must behave as a PURE text-completion endpoint. Without this, the
 * `claude` subprocess is a full agent: its own tools, the user's plugins and
 * MCP connectors, and a Claude Code identity that makes it dismiss our
 * TOOL_CALL protocol as fake (symptom: "those tools don't exist here").
 *
 * Per the CLI reference, the complete lockdown is:
 *   --tools ""             disable ALL built-in tools (incl. future ones)
 *   --disallowedTools "*"  belt-and-suspenders: remove every tool from context
 *   --strict-mcp-config    (without --mcp-config) load ZERO MCP servers
 *   --bare                 skip plugins, skills, hooks, CLAUDE.md, auto-memory
 *   --no-session-persistence  don't pollute the user's session history
 *   --system-prompt        REPLACE the Claude Code identity with ours
 * Plus: run in an empty scratch cwd so there is nothing to discover anyway.
 *
 * COMPATIBILITY LADDER: not every installed CLI version supports every flag,
 * and a rejected flag exits non-zero before any completion happens. The
 * provider starts at the strictest level and automatically steps down to the
 * strongest set the installed CLI accepts (sticky once found, logged once).
 * Run `claude update` to get back to level 0.
 */
interface LockdownLevel {
  flags: string[];
  systemFlag: "--system-prompt" | "--append-system-prompt";
}

const LOCKDOWN_LADDER: LockdownLevel[] = [
  {
    // Default: no tools, no MCP servers, no session files, replaced identity.
    //
    // NOTE: --bare is deliberately NOT used. It looks ideal (skips plugins,
    // skills, CLAUDE.md) but on Claude Code 2.1.214 it also skips credential
    // discovery, so every call fails with "Not logged in" — verified by
    // `npm run doctor`, which bisects each flag. The flags below achieve the
    // isolation that matters (zero tools, zero MCP) and are confirmed working;
    // the empty scratch cwd keeps project-level CLAUDE.md out of context.
    flags: ["--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--no-session-persistence"],
    systemFlag: "--system-prompt",
  },
  {
    // Older CLIs: drop --tools and --no-session-persistence.
    flags: ["--disallowedTools", "*", "--strict-mcp-config", "--no-session-persistence"],
    systemFlag: "--system-prompt",
  },
  {
    // No --tools; wildcard disallow still removes every tool from context.
    flags: ["--disallowedTools", "*", "--strict-mcp-config"],
    systemFlag: "--system-prompt",
  },
  {
    // Known-good baseline on older CLIs (proven working earlier): explicit
    // empty MCP config + appended (not replaced) system prompt.
    flags: ["--disallowedTools", "*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
    systemFlag: "--append-system-prompt",
  },
];

/**
 * Heuristic: distinguishes "CLI rejected our flags" from transient/API failures.
 * Includes "Not logged in": some isolation flags (notably --bare, which skips
 * config auto-discovery) prevent the CLI from loading stored credentials, so an
 * auth error at one ladder level can be resolved by a weaker level. If auth is
 * genuinely broken, every level fails and the last error surfaces to the user.
 */
function isLikelyFlagIncompatibility(err: unknown): boolean {
  if (!(err instanceof AgentError)) return false;
  return /unknown option|unrecognized option|invalid (option|argument)|not logged in|please run \/login|exited \d+:\s*$/i.test(
    err.message,
  );
}

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
/**
 * Concurrency gate. The orchestrator runs independent plan steps in parallel,
 * and each LLM call here spawns a full `claude` process. Unbounded, that means
 * N heavyweight processes at once, which trips subscription rate limits, opens
 * the circuit breaker, and cascades into "Circuit is open — failing fast" on
 * every remaining step. Queue instead: slower, but it finishes.
 */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name = "claude-cli";
  /** Sticky index into LOCKDOWN_LADDER — strongest level this CLI accepts. */
  private ladderLevel = 0;
  private readonly gate = new Semaphore(config.limits.maxConcurrentCliCalls);

  constructor(private readonly cliPath = process.env.CLAUDE_CLI_PATH ?? "claude") {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const release = await this.gate.acquire();
    try {
      return await this.completeInner(req);
    } finally {
      release();
    }
  }

  private async completeInner(req: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const prompt = flattenMessages(req);
    let lastErr: unknown;

    for (let lvl = this.ladderLevel; lvl < LOCKDOWN_LADDER.length; lvl++) {
      const lock = LOCKDOWN_LADDER[lvl]!;
      const args = [
        "-p", // print mode (non-interactive)
        "--output-format", "json",
        "--model", req.model ?? config.models.default,
        ...lock.flags,
        lock.systemFlag, req.system ?? "You are a helpful assistant.",
      ];
      try {
        const raw = await this.spawnCli(args, prompt);
        const parsed = parseCliJson(raw);
        if (lvl !== this.ladderLevel) {
          logger.warn("claude CLI: settled on reduced lockdown level (run `claude update` for full isolation)", { level: lvl });
        }
        this.ladderLevel = lvl;
        return {
          text: parsed.result,
          model: req.model ?? config.models.default,
          usage: parsed.usage,
          stopReason: parsed.subtype === "success" ? "end_turn" : parsed.subtype,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        lastErr = err;
        if (!isLikelyFlagIncompatibility(err) || lvl === LOCKDOWN_LADDER.length - 1) throw err;
        logger.warn("claude CLI rejected lockdown flags — trying reduced set", {
          fromLevel: lvl,
          error: String(err).slice(0, 300),
        });
      }
    }
    throw lastErr;
  }

  private spawnCli(args: string[], stdin: string): Promise<string> {
    // Empty scratch cwd: even if a tool slipped through, there is nothing to read.
    const scratch = resolve(join(config.dataDir, "cli-scratch"));
    mkdirSync(scratch, { recursive: true });
    // Normalize the OAuth token: .env pastes often carry quotes/whitespace,
    // which the CLI reads literally and rejects as "Not logged in".
    const env: NodeJS.ProcessEnv = { ...process.env };
    const rawToken = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (rawToken !== undefined) {
      const cleaned = rawToken.trim().replace(/^["']|["']$/g, "");
      if (cleaned) env.CLAUDE_CODE_OAUTH_TOKEN = cleaned;
      else delete env.CLAUDE_CODE_OAUTH_TOKEN; // empty var can mask a valid login
    }

    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.cliPath, args, {
        cwd: scratch,
        env,
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
          // Error text can land on either stream (flag errors often use stdout).
          const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
          // Rate-limit / transient errors are retryable; auth errors are not.
          const retryable = !/login|auth|unauthorized/i.test(detail);
          const hint = /not logged in|please run \/login|please run `?claude\b/i.test(detail)
            ? ` — the claude CLI subprocess is NOT authenticated. In a terminal run: claude  (sign in interactively once), then verify with: claude -p "say hi". Your login may have expired since the last successful run. For an unattended server, generate a token with \`claude setup-token\` and export it as CLAUDE_CODE_OAUTH_TOKEN, or switch to LLM_PROVIDER=anthropic with an ANTHROPIC_API_KEY.`
            : "";
          reject(new AgentError(`claude CLI exited ${code}: ${detail}${hint}`, retryable));
        } else {
          resolvePromise(stdout);
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
