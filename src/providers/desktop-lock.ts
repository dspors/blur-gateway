/**
 * Global desktop mutex. The desktop is a single HID-driven resource: only one
 * automation may touch it at a time, end-to-end. The bridge shield's per-call
 * file lock serializes individual keystroke bursts, but multi-step provider
 * sequences (createPreparedSession = create + rename + retries) release the lock
 * between steps and would otherwise interleave — concurrent requests steal focus
 * and cross-contaminate sessions. This serializes whole HID operations across
 * ALL providers (codex + claude share one physical desktop).
 */
let tail: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on both fulfilment and rejection so one failed op never strands the
  // queue; swallow the tail's result/error so the next op always proceeds.
  const result = tail.then(fn, fn);
  tail = result.then(() => undefined, () => undefined);
  return result as Promise<T>;
}
