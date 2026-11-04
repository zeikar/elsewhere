/**
 * Screen Wake Lock (docs/PLAN.md section 7): keeps the screen on while travelling with the tab
 * visible. The lock is requested when travel is active and the tab is visible, requested again when
 * the tab becomes visible (the browser releases it whenever the tab is hidden), and released on pause.
 *
 * Where the Wake Lock API is unsupported this does nothing, quietly. Failed requests are logged with
 * console.warn and never throw.
 *
 * `navigator` and `document` are injectable for tests.
 */

/** The parts of WakeLockSentinel used here. */
export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

/** The part of Navigator used here; `wakeLock` is absent where the API is unsupported. */
export interface WakeLockNavigator {
  readonly wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } | undefined;
}

/** The part of Document used here. */
export interface WakeLockDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface WakeLockOptions {
  /** Default: the global `navigator`. */
  navigator?: WakeLockNavigator;
  /** Default: the global `document`. */
  document?: WakeLockDocument;
}

export interface WakeLockController {
  /** Whether travel is active (not paused). The lock is held only while active and visible. */
  setActive(active: boolean): void;
  /** Whether a wake lock is currently held. */
  isHeld(): boolean;
  /** Releases any held lock and stops listening for visibility changes. */
  dispose(): void;
}

function warn(action: string, err: unknown): void {
  console.warn(`Screen Wake Lock ${action} failed:`, err);
}

export function createWakeLock(options: WakeLockOptions = {}): WakeLockController {
  const nav = options.navigator ?? globalThis.navigator;
  const doc = options.document ?? globalThis.document;
  const api = nav?.wakeLock;

  let active = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | null = null;
  /** Set while a request is in flight, so overlapping triggers never request twice. */
  let pending = false;
  /**
   * Set when a trigger was skipped because a request was in flight. If that request then settles
   * without a usable lock, it is retried once; a permanent denial therefore cannot loop.
   */
  let retryAfterSettle = false;

  const wanted = (): boolean => active && !disposed && doc.visibilityState === 'visible';

  /** The browser released the lock (e.g. the tab was hidden); forget it so it can be requested again. */
  const onRelease = (): void => {
    if (sentinel === null) return;
    sentinel.removeEventListener('release', onRelease);
    sentinel = null;
  };

  function release(): void {
    const held = sentinel;
    if (held === null) return;
    held.removeEventListener('release', onRelease);
    sentinel = null;
    if (held.released === true) return;
    try {
      held.release().catch((err: unknown) => warn('release', err));
    } catch (err) {
      warn('release', err);
    }
  }

  /** Called when a request settles without leaving a usable lock: retries once if a trigger was skipped. */
  function retryIfSkipped(): void {
    const retry = retryAfterSettle;
    retryAfterSettle = false;
    if (retry && wanted()) request();
  }

  function request(): void {
    if (!api || !wanted()) return;
    if (pending) {
      retryAfterSettle = true;
      return;
    }
    if (sentinel !== null && sentinel.released !== true) return;
    sentinel = null;
    pending = true;
    let promise: Promise<WakeLockSentinelLike>;
    try {
      promise = api.request('screen');
    } catch (err) {
      pending = false;
      warn('request', err);
      return;
    }
    promise.then(
      (lock) => {
        pending = false;
        if (lock.released === true) {
          retryIfSkipped();
          return;
        }
        retryAfterSettle = false;
        sentinel = lock;
        lock.addEventListener('release', onRelease);
        // Paused, hidden or disposed while the request was in flight.
        if (!wanted()) release();
      },
      (err: unknown) => {
        pending = false;
        warn('request', err);
        retryIfSkipped();
      },
    );
  }

  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'visible') request();
  };

  if (api) doc.addEventListener('visibilitychange', onVisibilityChange);

  return {
    setActive(next) {
      if (disposed) return;
      active = next;
      if (active) request();
      else release();
    },
    isHeld: () => sentinel !== null && sentinel.released !== true,
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      if (api) doc.removeEventListener('visibilitychange', onVisibilityChange);
      release();
    },
  };
}
