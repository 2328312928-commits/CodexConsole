export type LimitResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * In-memory sliding-window limiter. Each key keeps (time, weight) entries, so the
 * same class handles request counts (weight 1) and byte budgets (weight = bytes).
 */
export class RateLimiter {
  private readonly entries = new Map<string, Array<[number, number]>>();
  private lastPrune = 0;

  private window(key: string, windowMs: number, now: number): Array<[number, number]> {
    let list = this.entries.get(key);
    if (!list) {
      list = [];
      this.entries.set(key, list);
    }
    while (list.length > 0 && list[0]![0] <= now - windowMs) list.shift();
    return list;
  }

  /** Current total weight inside the window. */
  usage(key: string, windowMs: number, now = Date.now()): number {
    return this.window(key, windowMs, now).reduce((sum, [, w]) => sum + w, 0);
  }

  /** How long until `weight` more would fit under `limit` (0 if it fits now). */
  retryAfter(key: string, limit: number, windowMs: number, weight = 1, now = Date.now()): number {
    const list = this.window(key, windowMs, now);
    let total = list.reduce((sum, [, w]) => sum + w, 0);
    if (total + weight <= limit) return 0;
    for (const [t, w] of list) {
      total -= w;
      if (total + weight <= limit) return Math.max(1, t + windowMs - now);
    }
    return windowMs;
  }

  /** Check and record in one step. Nothing is recorded when the limit is exceeded. */
  consume(key: string, limit: number, windowMs: number, weight = 1, now = Date.now()): LimitResult {
    this.maybePrune(now);
    const wait = this.retryAfter(key, limit, windowMs, weight, now);
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    this.window(key, windowMs, now).push([now, weight]);
    return { ok: true };
  }

  /** Record without checking (e.g. a failed login attempt). */
  record(key: string, windowMs: number, weight = 1, now = Date.now()): void {
    this.maybePrune(now);
    this.window(key, windowMs, now).push([now, weight]);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const horizon = now - 24 * 3_600_000;
    for (const [key, list] of this.entries) {
      if (list.length === 0 || list[list.length - 1]![0] < horizon) this.entries.delete(key);
    }
  }
}
