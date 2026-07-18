import { describe, expect, it } from "vitest";
import {
  GuardrailPipeline,
  inputLengthGuardrail,
  luhnValid,
  piiOutputGuardrail,
  redactPii,
} from "../src/orchestration/guardrails.js";

describe("luhnValid", () => {
  it("accepts valid card numbers", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("5500005555555559")).toBe(true);
  });

  it("rejects invalid checksums and wrong lengths", () => {
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("1234567890123456")).toBe(false);
    expect(luhnValid("411")).toBe(false);
  });
});

describe("redactPii", () => {
  it("redacts Luhn-valid card numbers", () => {
    const r = redactPii("Pay with 4111 1111 1111 1111 today");
    expect(r).not.toBeNull();
    expect(r!.redacted).toContain("[REDACTED CREDIT CARD]");
    expect(r!.redacted).not.toContain("4111");
  });

  it("does NOT flag non-Luhn long digit runs (timestamps, ids)", () => {
    // 16 digits, invalid checksum — the old regex-only guardrail blocked this.
    expect(redactPii("order id 1234567890123456")).toBeNull();
    expect(redactPii("epoch 1752854400000")).toBeNull();
  });

  it("redacts SSN-like values", () => {
    const r = redactPii("SSN: 123-45-6789");
    expect(r!.redacted).toContain("[REDACTED SSN]");
  });

  it("returns null for clean text", () => {
    expect(redactPii("totally clean text with numbers 42 and 2026")).toBeNull();
  });
});

describe("GuardrailPipeline", () => {
  const pipeline = new GuardrailPipeline([inputLengthGuardrail, piiOutputGuardrail]);

  it("blocks empty input", async () => {
    const v = await pipeline.checkInput("  ");
    expect(v.allowed).toBe(false);
  });

  it("redacts (not blocks) PII in output", async () => {
    const v = await pipeline.checkOutput("Card 4111 1111 1111 1111 found");
    expect(v.allowed).toBe(true);
    expect(v.output).toContain("[REDACTED CREDIT CARD]");
  });

  it("passes clean output through unchanged", async () => {
    const v = await pipeline.checkOutput("all good");
    expect(v.allowed).toBe(true);
    expect(v.output).toBeUndefined();
  });
});
