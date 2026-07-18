import type { Guardrail, GuardrailVerdict } from "../types/index.js";

/**
 * Guardrails & Policy (Layer 2 / Layer 8).
 * Input guardrails run before planning; output guardrails run on the final result.
 * Add org-specific policies (topic restrictions, approval workflows) here.
 */

const PII_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "SIN", re: /\b\d{3}[- ]\d{3}[- ]\d{3}\b/ },
  { name: "credit card", re: /\b(?:\d[ -]*?){13,16}\b/ },
];

export const inputLengthGuardrail: Guardrail = {
  name: "input-length",
  async checkInput(goal): Promise<GuardrailVerdict> {
    if (goal.trim().length < 3) return { allowed: false, reason: "Goal is empty or too short" };
    if (goal.length > 10_000) return { allowed: false, reason: "Goal exceeds 10,000 characters" };
    return { allowed: true };
  },
};

export const piiOutputGuardrail: Guardrail = {
  name: "pii-output",
  async checkOutput(output): Promise<GuardrailVerdict> {
    for (const { name, re } of PII_PATTERNS) {
      if (re.test(output)) {
        return { allowed: false, reason: `Output appears to contain ${name}-like data` };
      }
    }
    return { allowed: true };
  },
};

export class GuardrailPipeline {
  constructor(private readonly guardrails: Guardrail[]) {}

  async checkInput(goal: string): Promise<GuardrailVerdict> {
    for (const g of this.guardrails) {
      if (!g.checkInput) continue;
      const verdict = await g.checkInput(goal);
      if (!verdict.allowed) return { allowed: false, reason: `[${g.name}] ${verdict.reason}` };
    }
    return { allowed: true };
  }

  async checkOutput(output: string): Promise<GuardrailVerdict> {
    for (const g of this.guardrails) {
      if (!g.checkOutput) continue;
      const verdict = await g.checkOutput(output);
      if (!verdict.allowed) return { allowed: false, reason: `[${g.name}] ${verdict.reason}` };
    }
    return { allowed: true };
  }
}

export const defaultGuardrails = new GuardrailPipeline([
  inputLengthGuardrail,
  piiOutputGuardrail,
]);
