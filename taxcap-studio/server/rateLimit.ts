export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const buckets = new Map<string, RateLimitEntry>();

  function check(key: string, now = Date.now()): RateLimitResult {
    const existing = buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      const resetAt = now + options.windowMs;
      buckets.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: Math.max(0, options.maxRequests - 1),
        resetInMs: options.windowMs,
      };
    }

    if (existing.count >= options.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetInMs: Math.max(0, existing.resetAt - now),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, options.maxRequests - existing.count),
      resetInMs: Math.max(0, existing.resetAt - now),
    };
  }

  function prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of buckets.entries()) {
      if (now >= entry.resetAt) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return { check, prune };
}
