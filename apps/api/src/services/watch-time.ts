/**
 * Headroom on top of real elapsed time: covers a dashboard batch (flushed every
 * 30s) arriving as a session's first request, plus clock jitter.
 */
const WATCH_SLACK_MS = 60_000;

export interface PriorWatch {
  maxPlayedMs: number;
  idleMs: number;
}

/**
 * Turns each event's cumulative `playedMs` into the increment over the
 * session's previous max. Lost batches are recovered by the next value and
 * duplicates add 0. Ingest is unauthenticated, so a session can never gain
 * more than the wall-clock time since its last stored event (plus slack).
 */
export function computeWatchIncrements(
  events: { sessionId: string; assetId: string; playedMs?: number }[],
  prior: Map<string, PriorWatch>,
): (number | null)[] {
  const state = new Map<string, { max: number; budget: number }>();
  return events.map((e) => {
    if (e.playedMs === undefined) return null;
    const key = watchKey(e.sessionId, e.assetId);
    let s = state.get(key);
    if (!s) {
      const p = prior.get(key);
      s = { max: p?.maxPlayedMs ?? 0, budget: (p?.idleMs ?? 0) + WATCH_SLACK_MS };
      state.set(key, s);
    }
    const increment = Math.min(Math.max(0, e.playedMs - s.max), s.budget);
    s.budget -= increment;
    s.max = Math.max(s.max, e.playedMs);
    return increment;
  });
}

export function watchKey(sessionId: string, assetId: string): string {
  return `${sessionId}\u0000${assetId}`;
}
