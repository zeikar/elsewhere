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

/**
 * The post-load renderer stall (issue #61): under headless SwiftShader the page's renderer stops
 * for seconds once, about a second after each navigation, while Chromium tears down the previous
 * document's compositor and waits for the GPU process to finish what it had queued (see
 * e2e/engine.spec.ts, RESIZE_POLL). No frame runs meanwhile, and the frames right after it are slow
 * while the GPU process catches up: the frame that creates an encounter object took 61–67 ms there
 * against 8–26 ms otherwise, and once 148.7 ms against the 100 ms limit
 * (SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS, issue #74). With `?encounterInterval=1` that object is
 * created about one simulated second after the start, right after the stall.
 */
export interface LoadStall {
  /** When the first animation frame ran, in ms since the navigation. */
  firstFrameAt: number;
  /** The first gaps between animation frames over LOAD_STALL_SMOOTH_MS: [start, length], in ms (start since the navigation). */
  gaps: [number, number][];
  /** When the wait ended, in ms since the navigation. */
  resumedAt: number;
}

/**
 * How long after the navigation to keep the engine paused, at least. With it paused from the first
 * frames, the stall measured 1.0–1.9 s from about 1.0 s after the navigation on a new page. After
 * another document, the first frame ran only 3.9–4.4 s after the navigation (the stall fell in the
 * page load), and a gap of up to 1.4 s followed at about 5 s, over by 6.6 s. With the engine running
 * the stall had taken 3.5–6 s. A wait that ended on a gap long enough to be the stall would miss the
 * one in the page load, hence a fixed time. It costs a few seconds a load: the encounter perf tests
 * took 2–16 s longer in a full run, and the full run as long as before (20.7 min).
 */
const LOAD_STALL_WAIT_MS = 8_000;
/** Then animation frames must have run this long with no gap over LOAD_STALL_SMOOTH_MS. */
const LOAD_STALL_SETTLE_MS = 1_000;
const LOAD_STALL_SMOOTH_MS = 100;

declare global {
  interface Window {
    __loadStall?: { first: number; last: number; smoothSince: number; gaps: [number, number][] };
  }
}

const watchedPages = new WeakSet<Page>();

/**
 * Records the gaps between animation frames in every document `page` loads from now on (call before
 * `page.goto`; once per page is enough), for `waitOutLoadStall`.
 */
export async function watchLoadStall(page: Page): Promise<void> {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  await page.addInitScript((smoothMs) => {
    const w = { first: -1, last: -1, smoothSince: -1, gaps: [] as [number, number][] };
    window.__loadStall = w;
    const tick = () => {
      requestAnimationFrame(tick);
      const t = performance.now();
      if (w.first < 0) {
        w.first = w.last = w.smoothSince = t;
        return;
      }
      const gap = t - w.last;
      w.last = t;
      if (gap > smoothMs) {
        w.smoothSince = t;
        if (w.gaps.length < 32) w.gaps.push([Math.round(t - gap), Math.round(gap)]);
      }
    };
    requestAnimationFrame(tick);
  }, LOAD_STALL_SMOOTH_MS);
}

/**
 * Waits for the engine's first frames (more than 5) and pauses it in the same check, so that no frame
 * runs between the two: with `encounterInterval=1`, one that met the post-load stall would step the
 * simulation by a capped frame. Call before `waitOutLoadStall`.
 */
export async function pauseAfterFirstFrames(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const hook = window.__elsewhere;
    if ((hook?.snapshot().frames ?? 0) <= 5) return false;
    hook!.pause();
    return true;
  });
}

/**
 * Pauses the engine (if `pauseAfterFirstFrames` has not) and keeps it paused through the post-load
 * stall: until LOAD_STALL_WAIT_MS after the navigation, and then until animation frames have run
 * smoothly for LOAD_STALL_SETTLE_MS. No simulated time passes meanwhile. The caller then resumes the
 * engine (`window.__elsewhere.resume()`) and installs its sampler, in that order, so that in each
 * animation frame the engine's frame runs before the sampler's (which reads the frame the engine has
 * just run); the specs assert that the frames that created and first drew the object were sampled,
 * so the other order fails. The frames it samples, the one that creates the first encounter's object in particular, then
 * meet neither the stall nor the GPU process catching up after it. The page must have been loaded
 * after `watchLoadStall`. A frame that stalls on its own (a shader compile, say) still fails the stall
 * checks: this keeps out only the stall the page load causes.
 */
export async function waitOutLoadStall(page: Page): Promise<LoadStall> {
  const encounterIndex = await page.evaluate(() => {
    window.__elsewhere!.pause();
    return window.__elsewhere!.probe().encounterIndex;
  });
  if (encounterIndex !== -1) throw new Error(`waitOutLoadStall: an encounter (${encounterIndex}) began before the pause`);
  let handle;
  try {
    handle = await page.waitForFunction(
      ({ wait, settle, smooth }) => {
        const w = window.__loadStall;
        if (w === undefined) throw new Error('waitOutLoadStall: the page was loaded before watchLoadStall');
        const now = performance.now();
        // A frame must have run just now: this check can run right after a stall, before the frame
        // that ends it.
        if (w.first < 0 || now < wait || now - w.last > smooth || now - w.smoothSince < settle) return false;
        return { firstFrameAt: Math.round(w.first), gaps: w.gaps, resumedAt: Math.round(now) };
      },
      { wait: LOAD_STALL_WAIT_MS, settle: LOAD_STALL_SETTLE_MS, smooth: LOAD_STALL_SMOOTH_MS },
      { timeout: 60_000, polling: 100 },
    );
  } catch (error) {
    // The gaps recorded say why frames never ran smoothly for long enough.
    const recorded = await page
      .evaluate(() => JSON.stringify({ now: Math.round(performance.now()), ...window.__loadStall }))
      .catch((e: unknown) => `unavailable (${e instanceof Error ? e.message : String(e)})`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nwaitOutLoadStall: window.__loadStall = ${recorded}`);
  }
  return (await handle.jsonValue()) as LoadStall;
}
