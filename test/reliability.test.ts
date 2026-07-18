import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/reliability/retry.js";
import { CircuitBreaker } from "../src/reliability/circuit-breaker.js";
import { AgentError } from "../src/reliability/errors.js";

describe("withRetry", () => {
  it("retries transient failures then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("t1"))
      .mockRejectedValueOnce(new Error("t2"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable AgentErrors", async () => {
    const fn = vi.fn().mockRejectedValue(new AgentError("fatal", false));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the failure threshold and fails fast", async () => {
    const breaker = new CircuitBreaker("test", 3, 10_000);
    const boom = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.exec(boom)).rejects.toThrow("down");
    }
    // Now open — underlying fn must NOT be called.
    const spy = vi.fn().mockResolvedValue("ok");
    await expect(breaker.exec(spy)).rejects.toThrow(/open/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("half-opens after the reset timeout and closes on success", async () => {
    const breaker = new CircuitBreaker("test2", 2, 20);
    const boom = () => Promise.reject(new Error("down"));
    await expect(breaker.exec(boom)).rejects.toThrow();
    await expect(breaker.exec(boom)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    // Probe call allowed and succeeds → circuit closes.
    await expect(breaker.exec(() => Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(breaker.exec(() => Promise.resolve("ok2"))).resolves.toBe("ok2");
  });
});
