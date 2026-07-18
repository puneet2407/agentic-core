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
