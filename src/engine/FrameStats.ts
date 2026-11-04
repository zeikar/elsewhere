/**
 * Frame-time statistics (docs/PLAN.md section 6, Performance: trust real measurements over the
 * target). A fixed ring buffer holds the most recent samples (for example frame intervals in
 * milliseconds); `mean()` and `percentile()` summarise that rolling window.
 *
 * `record` allocates nothing and costs a few operations, so the engine can call it every frame.
 * `percentile` sorts a preallocated scratch copy of the window, so it too allocates nothing beyond
 * the two typed-array views it makes; it is meant to be read occasionally (the e2e hook, a sampler),
 * not every frame.
 *
 * Pure and DOM-free, so it can be tested without a browser.
 */
import { PERF_FRAME_WINDOW } from '../config';

export class FrameStats {
  /** Window size: how many of the most recent samples the statistics cover. */
  readonly capacity: number;
  private readonly samples: Float64Array;
  private readonly scratch: Float64Array;
  /** Index the next sample is written to. */
  private next = 0;
  /** Samples in the window, up to `capacity`. */
  private size = 0;
  /** Samples recorded since construction or the last `reset()`, including those that left the window. */
  private recorded = 0;
  private latest = Number.NaN;

  constructor(capacity: number = PERF_FRAME_WINDOW) {
    if (!(capacity >= 1) || !Number.isInteger(capacity)) throw new RangeError(`FrameStats: bad capacity ${capacity}`);
    this.capacity = capacity;
    this.samples = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  /** Adds a sample. A negative, NaN or infinite value is ignored (for example "no interval yet"). */
  record(value: number): void {
    if (!(value >= 0) || value === Number.POSITIVE_INFINITY) return;
    this.samples[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.recorded++;
    this.latest = value;
  }

  /** Forgets every sample. */
  reset(): void {
    this.next = 0;
    this.size = 0;
    this.recorded = 0;
    this.latest = Number.NaN;
  }

  /** Samples in the window (at most `capacity`). */
  get count(): number {
    return this.size;
  }

  /** Samples recorded in total since construction or the last `reset()`. */
  get total(): number {
    return this.recorded;
  }

  /** The most recent sample, or NaN when there is none. */
  get last(): number {
    return this.latest;
  }

  /** Mean of the window, or NaN when it is empty. */
  mean(): number {
    const n = this.size;
    if (n === 0) return Number.NaN;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.samples[i]!;
    return sum / n;
  }

  /** Largest sample in the window, or NaN when it is empty. */
  max(): number {
    const n = this.size;
    if (n === 0) return Number.NaN;
    let m = this.samples[0]!;
    for (let i = 1; i < n; i++) m = Math.max(m, this.samples[i]!);
    return m;
  }

  /**
   * The `p`-th percentile (p in [0, 100]) of the window by the nearest-rank method: the smallest
   * sample with at least p% of the window at or below it. NaN when the window is empty.
   */
  percentile(p: number): number {
    const n = this.size;
    if (n === 0) return Number.NaN;
    const sorted = this.scratch.subarray(0, n);
    sorted.set(this.samples.subarray(0, n));
    sorted.sort();
    const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * n);
    return sorted[Math.max(0, rank - 1)]!;
  }
}
