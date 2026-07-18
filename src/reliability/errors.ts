export class AgentError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = true,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class GuardrailError extends Error {
  constructor(public readonly reason: string) {
    super(`Blocked by guardrail: ${reason}`);
    this.name = "GuardrailError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Run was cancelled by the user (Layer 7 — Human-in-the-loop). */
export class CancelledError extends Error {
  constructor(message = "Run cancelled by user") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Run exceeded its wall-clock budget (config.limits.maxRunMs). */
export class RunTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTimeoutError";
  }
}
