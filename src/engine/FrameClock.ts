/**
 * Frame clock: turns frame timestamps into simulation deltas (docs/PLAN.md section 6, Time and speed).
 *
 * - Each delta is clamped to [0, DT_CAP_SECONDS] with `clampDt`.
 * - While hidden the clock is stopped: `tick` returns 0 and keeps no reference time.
 * - After `show()` or `reset()` the next tick only sets a new reference time and returns 0, so a
 *   long hidden or paused period never turns into one big step (no teleporting stars).
 *
 * Pure and DOM-free: timestamps are passed in (milliseconds, e.g. a `requestAnimationFrame`
 * timestamp), so it can be tested without a browser.
 */
import { clampDt } from './Ship';

export class FrameClock {
  private last: number | null = null;
  private hidden = false;
  private interval = Number.NaN;

  /** Returns the clamped delta in seconds since the previous tick, or 0 when there is none. */
  tick(nowMs: number): number {
    this.interval = Number.NaN;
    if (this.hidden) return 0;
    const last = this.last;
    this.last = nowMs;
    if (last === null) return 0;
    this.interval = nowMs - last;
    return clampDt(this.interval / 1000);
  }

  /**
   * The raw (unclamped) time between the latest tick and the one before it, in milliseconds: the
   * frame interval, for instrumentation. NaN when that tick had no reference time (the first tick,
   * the first after `show()` or `reset()`, or any while hidden), so a pause or a hidden period is
   * never reported as a frame.
   */
  get lastIntervalMs(): number {
    return this.interval;
  }

  /** Stops the clock (tab hidden). */
  hide(): void {
    this.hidden = true;
    this.last = null;
  }

  /** Restarts the clock (tab visible again); the next tick returns 0. */
  show(): void {
    this.hidden = false;
    this.last = null;
  }

  /** Forgets the reference time (e.g. on resume); the next tick returns 0. */
  reset(): void {
    this.last = null;
  }

  isHidden(): boolean {
    return this.hidden;
  }
}
