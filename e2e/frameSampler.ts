/**
 * In-page frame sampler for the performance specs (e2e/perf.spec.ts, e2e/soak/soak.spec.ts).
 *
 * `installFrameSampler` starts a watcher that runs on every animation frame, right after the
 * engine's own frame, and reads the e2e hook's `probe()` into one reused object. It allocates
 * nothing per frame: every frame's interval and work time go into preallocated typed arrays,
 * bucketed by situation (CRUISE with no encounter object, or an encounter in progress), so a heap
 * measured while it runs sees only the app (the arrays are copied out only by `takeFrameWindow`). It also checks every frame for a position jump, and
 * marks, per encounter, the frame that created the encounter object and the first frame that drew
 * it (with the interval to the frame after each), so shader-compile stalls show up.
 *
 * `takeFrameWindow` returns the frame times since the previous call and starts a new window;
 * `frameTimeStats` summarises them.
 */
import type { Page } from '@playwright/test';
import { DT_CAP_SECONDS } from '../src/config';

/** Summary of a set of frame times, in milliseconds. */
export interface FrameTimeStats {
  n: number;
  mean: number;
  p50: number;
  /** 75th percentile (nearest rank). */
  p75: number;
  /** 95th percentile (nearest rank). */
  p95: number;
  max: number;
}

/** Frame times of one situation (CRUISE, or an encounter in progress), in milliseconds. */
export interface FrameBucket {
  /** Frame intervals (time between consecutive frames). */
  interval: number[];
  /** Main-thread work per frame (simulation, encounter sync, render call). */
  work: number[];
}

/** Mean, median, 75th and 95th percentiles and maximum of `values` (nearest rank), or `null` when empty. */
export function frameTimeStats(values: readonly number[]): FrameTimeStats | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * n) - 1)]!;
  return { n, mean: values.reduce((sum, v) => sum + v, 0) / n, p50: rank(0.5), p75: rank(0.75), p95: rank(0.95), max: sorted[n - 1]! };
}

/** Frame timings around one encounter's object, in milliseconds (`null` when not seen cleanly). */
export interface EncounterMark {
  index: number;
  /** Work time of the frame that created the object (and started its shader compile). */
  createWork: number | null;
  /** Interval from that frame to the next. */
  createNextInterval: number | null;
  /** Work time of the first frame that drew the object. */
  visibleWork: number | null;
  /** Interval from that frame to the next. */
  visibleNextInterval: number | null;
}

export interface FrameWindow {
  /** Wall time the window covers, in ms. */
  wallMs: number;
  /** Engine frames in the window. */
  frames: number;
  cruise: FrameBucket;
  encounter: FrameBucket;
  /** Samples that did not fit in the buffers (the window ran too long). */
  dropped: number;
  /** Encounters whose marks completed during the window. */
  marks: EncounterMark[];
  /** Since install: the largest step between consecutive frames beyond what the ship's speed allows (≤ 0 is fine). */
  worstJump: number;
  /** Since install: frames the watcher missed (the engine ran more than one frame between two of its frames). */
  missedFrames: number;
}

interface SamplerApi {
  take(): FrameWindow;
  /** Leaves the next `n` frame intervals out of the statistics (e.g. the one spanning a forced GC). */
  skip(n: number): void;
}

declare global {
  interface Window {
    __frameSampler?: SamplerApi;
  }
}

/** Installs the sampler in the page (once; the app must be running). */
export async function installFrameSampler(page: Page, capacity = 16_384): Promise<void> {
  await page.evaluate(
    ({ capacity, dtCap }) => {
      const hook = window.__elsewhere!;
      const p = hook.probe();
      const MAX_MARKS = 4096;
      // Per bucket: [cruise interval, cruise work, encounter interval, encounter work].
      const buffers = [0, 1, 2, 3].map(() => new Float64Array(capacity));
      const counts = new Int32Array(4);
      // Per encounter: createWork, createNextInterval, visibleWork, visibleNextInterval (NaN if unseen).
      const marks = new Float64Array(MAX_MARKS * 4).fill(Number.NaN);
      const seenVisible = new Uint8Array(MAX_MARKS);
      let marksTaken = 0;
      let highestIndex = -1;
      let frames = 0;
      let dropped = 0;
      let skip = 0;
      let worstJump = Number.NEGATIVE_INFINITY;
      let missedFrames = 0;
      let windowStart = performance.now();

      hook.probe(p);
      let prevFrames = p.frames;
      let prevIndex = p.encounterIndex;
      let prevVisible = p.visible;
      let prevX = p.x;
      let prevY = p.y;
      let prevZ = p.z;
      let prevSpeed = p.speed;
      let pendingCreate = -1;
      let pendingVisible = -1;

      const push = (bucket: number, value: number) => {
        if (!(value >= 0)) return;
        const n = counts[bucket]!;
        if (n >= capacity) {
          dropped++;
          return;
        }
        buffers[bucket]![n] = value;
        counts[bucket] = n + 1;
      };

      const tick = () => {
        requestAnimationFrame(tick);
        hook.probe(p);
        if (p.frames === prevFrames) return;
        const consecutive = p.frames === prevFrames + 1;
        if (!consecutive) missedFrames += p.frames - prevFrames - 1;
        frames += p.frames - prevFrames;

        if (consecutive) {
          const moved = Math.hypot(p.x - prevX, p.y - prevY, p.z - prevZ);
          worstJump = Math.max(worstJump, moved - Math.max(p.speed, prevSpeed) * dtCap);
          if (skip > 0) {
            skip--;
          } else if (!p.paused) {
            const bucket = p.state === 'CRUISE' && p.encounterIndex < 0 ? 0 : 2;
            push(bucket, p.frameMs);
            push(bucket + 1, p.workMs);
          }
          if (pendingCreate >= 0) marks[pendingCreate * 4 + 1] = p.frameMs;
          if (pendingVisible >= 0) marks[pendingVisible * 4 + 3] = p.frameMs;
        }
        pendingCreate = -1;
        pendingVisible = -1;

        const index = p.encounterIndex;
        if (index >= 0 && index < MAX_MARKS) {
          if (index !== prevIndex) {
            highestIndex = Math.max(highestIndex, index);
            if (consecutive) {
              marks[index * 4] = p.workMs;
              pendingCreate = index;
            }
          }
          if (p.visible && seenVisible[index] === 0) {
            seenVisible[index] = 1;
            if (consecutive && !prevVisible) {
              marks[index * 4 + 2] = p.workMs;
              pendingVisible = index;
            }
          }
        }

        prevFrames = p.frames;
        prevIndex = index;
        prevVisible = p.visible;
        prevX = p.x;
        prevY = p.y;
        prevZ = p.z;
        prevSpeed = p.speed;
      };
      requestAnimationFrame(tick);

      const values = (bucket: number) => Array.from(buffers[bucket]!.subarray(0, counts[bucket]!));
      const orNull = (x: number) => (Number.isFinite(x) ? x : null);

      window.__frameSampler = {
        take() {
          const now = performance.now();
          // Marks of the encounters that are over (all of them at CRUISE), so theirs are complete.
          const done: FrameWindow['marks'] = [];
          const over = p.encounterIndex < 0 ? highestIndex + 1 : highestIndex;
          for (; marksTaken < Math.min(over, MAX_MARKS); marksTaken++) {
            const i = marksTaken * 4;
            done.push({
              index: marksTaken,
              createWork: orNull(marks[i]!),
              createNextInterval: orNull(marks[i + 1]!),
              visibleWork: orNull(marks[i + 2]!),
              visibleNextInterval: orNull(marks[i + 3]!),
            });
          }
          const result: FrameWindow = {
            wallMs: now - windowStart,
            frames,
            cruise: { interval: values(0), work: values(1) },
            encounter: { interval: values(2), work: values(3) },
            dropped,
            marks: done,
            worstJump,
            missedFrames,
          };
          counts.fill(0);
          frames = 0;
          dropped = 0;
          windowStart = now;
          return result;
        },
        skip(n: number) {
          skip = Math.max(skip, n);
        },
      };
    },
    { capacity, dtCap: DT_CAP_SECONDS },
  );
}

/** Frame times since the previous call (or the install), starting a new window. */
export function takeFrameWindow(page: Page): Promise<FrameWindow> {
  return page.evaluate(() => window.__frameSampler!.take());
}
