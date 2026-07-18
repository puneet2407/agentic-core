import { logger } from "../observability/logger.js";

type State = "closed" | "open" | "half-open";

/**
 * Circuit breaker (Layer 7). Wraps a dependency (LLM provider, external API).
 * After `failureThreshold` consecutive failures the circuit opens and calls
 * fail fast for `resetTimeoutMs`, then one probe call is allowed (half-open).
 */
export class CircuitBreaker {
  private state: State = "closed";
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly failureThreshold = 5,
    private readonly resetTimeoutMs = 30_000,
  ) {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = "half-open";
        logger.info("circuit half-open", { name: this.name });
      } else {
        throw new Error(`Circuit "${this.name}" is open — failing fast`);
      }
    }
    try {
      const result = await fn();
      if (this.state !== "closed") logger.info("circuit closed", { name: this.name });
      this.state = "closed";
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this.state === "half-open" || this.failures >= this.failureThreshold) {
        this.state = "open";
        this.openedAt = Date.now();
        logger.warn("circuit opened", { name: this.name, failures: this.failures });
      }
      throw err;
    }
  }
}
