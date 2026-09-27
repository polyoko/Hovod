const API = (import.meta.env.VITE_API_BASE_URL as string) || '';
const HEARTBEAT_INTERVAL = 10_000;
const BATCH_FLUSH_INTERVAL = 30_000;
const BATCH_MAX_SIZE = 20;
/** A reload within this window resumes the same view instead of counting a new one. */
const VIEW_SESSION_IDLE_MS = 30 * 60_000;

interface AnalyticsConfig {
  assetId: string;
  playbackId: string;
  playerType: 'embed' | 'dashboard';
}

interface EventPayload {
  sessionId: string;
  assetId: string;
  playbackId: string;
  eventType: string;
  currentTime?: number;
  duration?: number;
  qualityHeight?: number;
  bufferDurationMs?: number;
  errorMessage?: string;
  playerType?: string;
  referrer?: string;
  timestamp?: number;
  playedMs?: number;
}

function generateSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

function viewSessionKey(playbackId: string): string {
  return `hovod_vs_${playbackId}`;
}

/**
 * Reuses the viewer's session for this video unless it has been idle too long,
 * along with its playing clock so a reload keeps counting from where it was.
 */
function resumeOrCreateSession(playbackId: string): { id: string; playedMs: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(viewSessionKey(playbackId)) ?? 'null');
    if (typeof saved?.id === 'string' && typeof saved.lastSeen === 'number'
      && Date.now() - saved.lastSeen < VIEW_SESSION_IDLE_MS) {
      const playedMs = Number.isInteger(saved.playedMs) && saved.playedMs >= 0 ? saved.playedMs : 0;
      return { id: saved.id, playedMs };
    }
  } catch {
    // Storage unavailable or corrupt: fall through to a fresh session
  }
  return { id: generateSessionId(), playedMs: 0 };
}

export class PlayerAnalytics {
  private sessionId: string;
  /** Wall-clock time spent actually playing in this session (seeks and pauses excluded). */
  private playedMs: number;
  private config: AnalyticsConfig;
  private eventQueue: EventPayload[] = [];
  private heartbeatTimer: number | null = null;
  private flushTimer: number | null = null;

  constructor(config: AnalyticsConfig) {
    const session = resumeOrCreateSession(config.playbackId);
    this.sessionId = session.id;
    this.playedMs = session.playedMs;
    this.config = config;
    this.touchSession();
    this.flushTimer = window.setInterval(() => this.flush(), BATCH_FLUSH_INTERVAL);
  }

  attachToVideo(
    videoEl: HTMLVideoElement,
    getQualityHeight: () => number | undefined,
  ): () => void {
    let hasStarted = false;
    let lastMediaTime = videoEl.currentTime;

    // Media-time deltas divided by the rate give wall-clock playing time. A
    // seek only moves the baseline, so jumps never count.
    const onTimeUpdate = () => {
      const now = videoEl.currentTime;
      const delta = now - lastMediaTime;
      lastMediaTime = now;
      if (videoEl.paused || videoEl.seeking || delta <= 0 || videoEl.playbackRate <= 0) return;
      this.playedMs += Math.round((delta / videoEl.playbackRate) * 1000);
    };
    const onSeeking = () => {
      lastMediaTime = videoEl.currentTime;
    };

    const onPlay = () => {
      this.startHeartbeat(videoEl, getQualityHeight);
    };

    // `playing` fires once frames actually render; `play` also fires when
    // autoplay is blocked or the stream never loads, so it is not a view.
    const onPlaying = () => {
      if (!hasStarted) {
        hasStarted = true;
        this.enqueue('view_start', {
          currentTime: Math.floor(videoEl.currentTime),
          duration: Math.floor(videoEl.duration || 0),
          qualityHeight: getQualityHeight(),
        });
      }
    };

    const onPause = () => {
      this.stopHeartbeat();
      this.enqueue('pause', {
        currentTime: Math.floor(videoEl.currentTime),
        duration: Math.floor(videoEl.duration || 0),
      });
    };

    const onSeeked = () => {
      lastMediaTime = videoEl.currentTime;
      this.enqueue('seek', {
        currentTime: Math.floor(videoEl.currentTime),
        duration: Math.floor(videoEl.duration || 0),
      });
    };

    const onEnded = () => {
      this.stopHeartbeat();
      this.enqueue('view_end', {
        currentTime: Math.floor(videoEl.duration || 0),
        duration: Math.floor(videoEl.duration || 0),
      });
    };

    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('seeking', onSeeking);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('playing', onPlaying);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.addEventListener('ended', onEnded);

    const onVisibility = () => {
      if (document.hidden) {
        this.stopHeartbeat();
      } else if (!videoEl.paused) {
        this.startHeartbeat(videoEl, getQualityHeight);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onBeforeUnload = () => {
      this.enqueue('view_end', {
        currentTime: Math.floor(videoEl.currentTime),
        duration: Math.floor(videoEl.duration || 0),
      });
      this.flushSync();
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      videoEl.removeEventListener('seeking', onSeeking);
      videoEl.removeEventListener('play', onPlay);
      videoEl.removeEventListener('playing', onPlaying);
      videoEl.removeEventListener('pause', onPause);
      videoEl.removeEventListener('seeked', onSeeked);
      videoEl.removeEventListener('ended', onEnded);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      this.destroy();
    };
  }

  trackQualityChange(qualityHeight: number, currentTime: number, duration: number) {
    this.enqueue('quality_change', { qualityHeight, currentTime, duration });
  }

  trackBufferStart(currentTime: number, duration: number) {
    this.enqueue('buffer_start', { currentTime, duration });
  }

  trackBufferEnd(bufferDurationMs: number, currentTime: number, duration: number) {
    this.enqueue('buffer_end', { bufferDurationMs, currentTime, duration });
  }

  trackError(errorMessage: string, currentTime?: number, duration?: number) {
    this.enqueue('error', { errorMessage, currentTime, duration });
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private touchSession() {
    try {
      localStorage.setItem(
        viewSessionKey(this.config.playbackId),
        JSON.stringify({ id: this.sessionId, lastSeen: Date.now(), playedMs: this.playedMs }),
      );
    } catch {
      // Storage unavailable: the session simply won't survive a reload
    }
  }

  private enqueue(eventType: string, data: Partial<EventPayload>) {
    // Persist exactly what is sent, so a reload resumes from the reported clock.
    this.touchSession();
    this.eventQueue.push({
      sessionId: this.sessionId,
      assetId: this.config.assetId,
      playbackId: this.config.playbackId,
      eventType,
      playerType: this.config.playerType,
      referrer: document.referrer || undefined,
      timestamp: Date.now(),
      playedMs: this.playedMs,
      ...data,
    });

    if (this.eventQueue.length >= BATCH_MAX_SIZE) {
      this.flush();
    }
  }

  private startHeartbeat(
    videoEl: HTMLVideoElement,
    getQualityHeight: () => number | undefined,
  ) {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!videoEl.paused && !videoEl.ended) {
        this.enqueue('heartbeat', {
          currentTime: Math.floor(videoEl.currentTime),
          duration: Math.floor(videoEl.duration || 0),
          qualityHeight: getQualityHeight(),
        });
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async flush() {
    if (this.eventQueue.length === 0) return;
    const batch = this.eventQueue.splice(0);
    try {
      await fetch(`${API}/v1/analytics/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      });
    } catch {
      // Silent — analytics must never break playback
    }
  }

  private flushSync() {
    if (this.eventQueue.length === 0) return;
    const batch = this.eventQueue.splice(0);
    const blob = new Blob([JSON.stringify({ events: batch })], {
      type: 'application/json',
    });
    navigator.sendBeacon(`${API}/v1/analytics/events`, blob);
  }

  private destroy() {
    this.stopHeartbeat();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
