import "dotenv/config";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : fallback;
}

const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";

export const config = {
  anthropicApiKey,
  /**
   * "anthropic"  — direct API (needs ANTHROPIC_API_KEY)
   * "claude-cli" — Claude Code CLI in headless mode (works with Pro/Max login, no key)
   * Default: claude-cli when no API key is set.
   */
  llmProvider: (process.env.LLM_PROVIDER ?? (anthropicApiKey ? "anthropic" : "claude-cli")) as
    | "anthropic"
    | "claude-cli",
  models: {
    default: process.env.DEFAULT_MODEL ?? "claude-sonnet-4-5",
    planner: process.env.PLANNER_MODEL ?? "claude-sonnet-4-5",
    fast: process.env.FAST_MODEL ?? "claude-haiku-4-5-20251001",
  },
  server: { port: int("PORT", 3100) },
  /** Folder containing all your microservice repos (enables workspace tools). */
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "",
  limits: {
    maxStepsPerTask: int("MAX_STEPS_PER_TASK", 12),
    maxTokensPerTask: int("MAX_TOKENS_PER_TASK", 200_000),
    requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 120_000),
    maxStepAttempts: 3,
  },
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
} as const;
