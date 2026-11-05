/**
 * Frame-rate cap (docs/PLAN.md section 6, Performance): decides, from each `requestAnimationFrame`
 * timestamp, whether that display frame is drawn, so the engine renders at most about FRAME_RATE_CAP
 * frames per second whatever the display's refresh rate. The simulation is untouched: a drawn frame
 * steps it by the real time since the previous drawn frame (FrameClock), so it stays real time.
 *
 * Frames are due one cap interval (`1000 / cap` ms) apart, on a running schedule, so a display
 * faster than the cap drops just enough frames: every other one at 120 Hz, one in three at 90 Hz,
 * about three in five at 144 Hz (on average about 60 drawn per second each time; up to about 62 at
 * 144 Hz, where frames drawn within the tolerance of their due time pull the schedule a little). A frame up to
 * `toleranceMs` early still counts as due, and the next due time is never more than one interval
 * after a drawn frame, so a 60 Hz display (or one a little slower or faster, with timestamp jitter
 * up to the tolerance) never drops a frame: it is never halved to 30. A frame a whole interval late
 * (after a stall) restarts the schedule from itself, rather than drawing every display frame until
 * the schedule has caught up.
 *
 * Pure and DOM-free: timestamps are passed in, so it can be tested without a browser.
 */

export class FrameCap {
  /** The cap in frames per second; 0 for no cap. */
  readonly fps: number;
  /** Cap interval in milliseconds; 0 for no cap. */
  readonly intervalMs: number;
  readonly toleranceMs: number;
  /** When the next frame is due, in the timestamps' milliseconds (−∞: the next one is). */
  private next = Number.NEGATIVE_INFINITY;

  /**
   * `fps`: the cap in frames per second (0, a negative or a non-finite value: no cap). `toleranceMs`:
   * how early a frame may come and still be drawn.
   */
  constructor(fps: number, toleranceMs: number) {
    this.fps = Number.isFinite(fps) && fps > 0 ? fps : 0;
    this.intervalMs = this.fps > 0 ? 1000 / this.fps : 0;
    this.toleranceMs = Math.max(0, toleranceMs);
  }

  /** Whether the display frame at `nowMs` is drawn. Call once per display frame, in order. */
  due(nowMs: number): boolean {
    const interval = this.intervalMs;
    if (interval === 0) return true;
    if (nowMs < this.next - this.toleranceMs) return false;
    // One interval after this frame was due, but no later than one interval from now; a whole
    // interval late (a stall, or the first frame), one interval from now.
    const late = nowMs - this.next;
    this.next = late >= interval ? nowMs + interval : Math.min(this.next + interval, nowMs + interval);
    return true;
  }

  /** Forgets the schedule (e.g. on resume), so the next display frame is drawn. */
  reset(): void {
    this.next = Number.NEGATIVE_INFINITY;
  }
}
