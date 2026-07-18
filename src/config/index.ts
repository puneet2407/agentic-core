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
  server: {
    port: int("PORT", 3100),
    /** Allowed CORS origin. Default "*" for local dev — set your app's origin in prod. */
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    /** Requests per minute per client IP (token bucket). 0 disables limiting. */
    rateLimitRpm: int("RATE_LIMIT_RPM", 120),
  },
  /** Directory for durable state (runs, memory, audit log). */
  dataDir: process.env.DATA_DIR ?? "./data",
  /**
   * Long-term memory retrieval: "local" tries real embeddings via the
   * optional @huggingface/transformers package (falls back to keyword
   * overlap if unavailable); "keyword" skips embeddings entirely.
   */
  embeddings: (process.env.EMBEDDINGS ?? "local") as "local" | "keyword",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
  /** Folder containing all your microservice repos (enables workspace tools). */
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "",
  limits: {
    maxStepsPerTask: int("MAX_STEPS_PER_TASK", 12),
    maxTokensPerTask: int("MAX_TOKENS_PER_TASK", 200_000),
    requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 120_000),
    maxStepAttempts: 3,
    /** Wall-clock budget for a whole run; exceeded → run fails cleanly. */
    maxRunMs: int("MAX_RUN_MS", 10 * 60_000),
    /** How many times the orchestrator may ask the planner for a revised plan. */
    maxReplans: int("MAX_REPLANS", 1),
  },
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
} as const;
