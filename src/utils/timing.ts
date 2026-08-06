// Lightweight per-request stage timing.
//
// Each request gets a StageTimer (stored on req.blurGateway.timer). Slow code
// paths wrap their expensive sub-steps with timer.time('stage-name', fn) — the
// duration is accumulated under that name. On request finish, the collected
// map is persisted as a JSON blob on request_log.stage_timings, and
// /v1/admin/stats aggregates per-stage percentiles so we can see which stage
// (db read, provider readLatest, message normalize, …) is actually slow.
//
// Zero external deps; monotonic clock; never throws (timing must not break a
// request). Same stage name called twice accumulates (e.g. two readLatest
// calls) and bumps a count so an average is meaningful.

export interface StageStat {
  ms: number;    // total milliseconds spent in this stage
  count: number; // how many times the stage ran
}

export class StageTimer {
  private stages = new Map<string, StageStat>();

  /** Record `deltaMs` under `name` (accumulates). */
  add(name: string, deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    const cur = this.stages.get(name);
    if (cur) { cur.ms += deltaMs; cur.count += 1; }
    else this.stages.set(name, { ms: deltaMs, count: 1 });
  }

  /** Time a synchronous fn under `name`, returning its result. */
  timeSync<T>(name: string, fn: () => T): T {
    const t = now();
    try { return fn(); }
    finally { this.add(name, now() - t); }
  }

  /** Time an async fn under `name`, returning its awaited result. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t = now();
    try { return await fn(); }
    finally { this.add(name, now() - t); }
  }

  /** Plain {stage: ms} object for logging (rounded). */
  toObject(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.stages) out[k] = Math.round(v.ms);
    return out;
  }

  /** Full {stage: {ms,count}} snapshot. */
  toDetailed(): Record<string, StageStat> {
    const out: Record<string, StageStat> = {};
    for (const [k, v] of this.stages) out[k] = { ms: Math.round(v.ms), count: v.count };
    return out;
  }

  get size(): number { return this.stages.size; }
}

/** Monotonic milliseconds. */
export function now(): number {
  // performance.now() is monotonic and unaffected by wall-clock changes.
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Pull the timer off a request context, if present. */
export function timerFrom(req: unknown): StageTimer | null {
  const ctx = (req as any)?.blurGateway as Record<string, unknown> | undefined;
  const t = ctx?.timer;
  return t instanceof StageTimer ? t : null;
}
