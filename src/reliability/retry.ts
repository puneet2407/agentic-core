import { AgentError } from "./errors.js";
import { logger } from "../observability/logger.js";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

/** Exponential backoff with jitter (Layer 7 — Retry & Backoff). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 500, maxDelayMs = 10_000, label = "op" }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = !(err instanceof AgentError) || err.retryable;
      if (!retryable || attempt === attempts) throw err;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random());
      logger.warn(`${label} failed, retrying`, { attempt, delayMs: Math.round(delay), error: String(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
