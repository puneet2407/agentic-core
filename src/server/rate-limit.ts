import { config } from "../config/index.js";

/**
 * Token-bucket rate limiter, per client key (IP) — Layer 8.
 * Capacity = RATE_LIMIT_RPM; refills continuously. 0 disables limiting.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(private readonly rpm: number = config.server.rateLimitRpm) {}

  /** Returns true when the request is allowed. */
  allow(key: string, now = Date.now()): boolean {
    if (this.rpm <= 0) return true;
    const bucket = this.buckets.get(key) ?? { tokens: this.rpm, last: now };
    // refill
    const elapsedMin = (now - bucket.last) / 60_000;
    bucket.tokens = Math.min(this.rpm, bucket.tokens + elapsedMin * this.rpm);
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    // opportunistic cleanup of idle buckets
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (now - b.last > 10 * 60_000) this.buckets.delete(k);
      }
    }
    return true;
  }
}

export const rateLimiter = new RateLimiter();
