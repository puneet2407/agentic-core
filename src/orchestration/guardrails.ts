import type { Guardrail, GuardrailVerdict } from "../types/index.js";

/**
 * Guardrails & Policy (Layer 2 / Layer 8).
 * Input guardrails run before planning; output guardrails run on the final result.
 *
 * Design:
 *  - PII is REDACTED, not hard-blocked: the user still gets their answer,
 *    minus the sensitive spans. Hard blocks remain for input abuse.
 *  - Credit-card detection is Luhn-verified to avoid false positives on
 *    timestamps, order ids, and other long digit runs.
 * Add org-specific policies (topic restrictions, approval workflows) here.
 */

/** Luhn checksum — true for valid card numbers. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface PiiPattern {
  name: string;
  re: RegExp;
  /** Extra verification on the raw match; return false to ignore (false positive). */
  verify?: (match: string) => boolean;
}

const PII_PATTERNS: PiiPattern[] = [
  { name: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "SIN", re: /\b\d{3}[- ]\d{3}[- ]\d{3}\b/g },
  {
    name: "credit card",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    verify: (m) => luhnValid(m.replace(/[ -]/g, "")),
  },
];

/** Redact PII spans in text; returns null when nothing was found. */
export function redactPii(text: string): { redacted: string; found: string[] } | null {
  const found: string[] = [];
  let out = text;
  for (const { name, re, verify } of PII_PATTERNS) {
    out = out.replace(re, (m) => {
      if (verify && !verify(m)) return m;
      found.push(name);
      return `[REDACTED ${name.toUpperCase()}]`;
    });
  }
  return found.length > 0 ? { redacted: out, found } : null;
}

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
    const result = redactPii(output);
    if (!result) return { allowed: true };
    return {
      allowed: true,
      output: result.redacted,
      reason: `Redacted PII-like data: ${[...new Set(result.found)].join(", ")}`,
    };
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

  /**
   * Runs output guardrails in order. Guardrails may transform (redact) the
   * text; each subsequent guardrail sees the transformed version. The final
   * verdict carries the (possibly transformed) output.
   */
  async checkOutput(output: string): Promise<GuardrailVerdict> {
    let current = output;
    const notes: string[] = [];
    for (const g of this.guardrails) {
      if (!g.checkOutput) continue;
      const verdict = await g.checkOutput(current);
      if (!verdict.allowed) return { allowed: false, reason: `[${g.name}] ${verdict.reason}` };
      if (verdict.output !== undefined) {
        current = verdict.output;
        if (verdict.reason) notes.push(`[${g.name}] ${verdict.reason}`);
      }
    }
    return {
      allowed: true,
      ...(current !== output ? { output: current, reason: notes.join("; ") } : {}),
    };
  }
}

export const defaultGuardrails = new GuardrailPipeline([
  inputLengthGuardrail,
  piiOutputGuardrail,
]);
