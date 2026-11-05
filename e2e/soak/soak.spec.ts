/**
 * Long-run soak (docs/PLAN.md section 5, "Stable rendering across tab switches and long runs",
 * section 9 Phase 1/3 "Done when" and section 10): travel with a short encounter interval for
 * SOAK_MINUTES (default 30), through many planet and nebula encounters, and sample them.
 *
 * Each sample is taken at CRUISE with no encounter object, so every sample sees the same scene: the
 * used JS heap after a forced GC, the renderer's resource counts, and the frame-time statistics of
 * the window since the previous sample. A sample is due SOAK_SAMPLE_SECONDS (default 30) after the
 * previous one, but is taken at the first CRUISE from then on, so samples are spaced by the later
 * of SOAK_SAMPLE_SECONDS and the end of the encounter in progress: in practice about one per
 * encounter cycle (about 70–80 s under SwiftShader). The run fails on
 *
 * - heap growth: last sample minus first above SOAK_HEAP_GROWTH_LIMIT_BYTES;
 * - frame-time degradation: the p95 frame interval at CRUISE late in the run (every CRUISE frame of
 *   the last third of the samples) above the early value (the first third) × SOAK_FRAME_TIME_FACTOR
 *   (+ SOAK_FRAME_TIME_SLACK_MS); likewise the p95 frame work time. Software rendering (SwiftShader)
 *   makes absolute frame rates meaningless, so only late versus early counts, and CRUISE frames are
 *   compared because every CRUISE draws the same scene at the same speed. Each third must pool at
 *   least SOAK_MIN_COMPARED_FRAMES frames, so a comparison too thin to mean anything fails;
 * - resource-count drift: geometries, textures, programs or render calls at CRUISE differing
 *   between any two samples;
 * - a stall in the frame that creates an encounter object or first draws it (more main-thread work
 *   than SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS: a shader compile waited on);
 * - a frame that moves the ship further than its speed allows, or any console error.
 *
 * Run with `npm run soak` (SOAK_MINUTES=3 in CI; the full 30 minutes via the "Soak" workflow). The
 * report (every sample plus the summary) is printed, attached and written to soak-report.json in
 * the test's output directory.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  frameTimeStats,
  installFrameSampler,
  type EncounterMark,
  type FrameTimeStats,
  type FrameWindow,
} from '../frameSampler';
import {
  FAST_ENCOUNTERS_ARRIVAL_SPEED,
  SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
  SOAK_FRAME_TIME_FACTOR,
  SOAK_FRAME_TIME_SLACK_MS,
  SOAK_HEAP_GROWTH_LIMIT_BYTES,
} from '../limits';
import { appUrl } from '../app';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!(value > 0)) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

/** Total run time, in minutes. */
const SOAK_MINUTES = envNumber('SOAK_MINUTES', 30);
/** Time between samples, in seconds. */
const SOAK_SAMPLE_SECONDS = envNumber('SOAK_SAMPLE_SECONDS', 30);
/**
 * Mean encounter interval (seconds of cruise between encounters): short, so the run meets many, but
 * long enough that each cruise gives the frame-time comparison a few dozen frames.
 */
const SOAK_ENCOUNTER_INTERVAL_SECONDS = envNumber('SOAK_ENCOUNTER_INTERVAL', 5);
/**
 * Viewport. SwiftShader is fill-rate bound, so a small one lets the run meet more encounters; the
 * checks are relative and never look at pixels.
 */
const VIEWPORT = { width: 480, height: 270 };
/** Longest wait for the next CRUISE when a sample is due (an encounter in progress). */
const CRUISE_WAIT_MS = 240_000;
/**
 * Fewest CRUISE frames (interval and work, each) the early and the late third must each pool. A
 * 3-minute run's thirds are one window each, of about 50 frames under SwiftShader (one cruise of
 * 4–6 s), so this leaves room for a slower runner while still failing a comparison of a few frames.
 */
const SOAK_MIN_COMPARED_FRAMES = 30;

interface Sample {
  /** Minutes since the soak started. */
  atMin: number;
  /** Encounters completed. */
  encounters: number;
  frames: number;
  /** Used JS heap after a forced GC, in bytes (null without gc() / performance.memory). */
  heap: number | null;
  resources: { geometries: number; textures: number; programs: number; calls: number };
  /** Frame-time statistics of the window since the previous sample, in ms. */
  cruise: { interval: FrameTimeStats | null; work: FrameTimeStats | null };
  encounter: { interval: FrameTimeStats | null; work: FrameTimeStats | null };
  /** The window's encounter marks, with the encounter frames' median times for comparison. */
  marks: (EncounterMark & { workP50: number | null; intervalP50: number | null })[];
  /** The window's raw frame times (dropped from the written report). */
  window: FrameWindow;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Waits until the engine is at CRUISE with no encounter object in the scene. */
async function waitForCruise(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = window.__elsewhere!.probe();
      return p.state === 'CRUISE' && p.encounterIndex < 0;
    },
    undefined,
    { timeout, polling: 100 },
  );
}

/** What one in-page reading returns (see `readSample`). */
interface PageReading {
  window: FrameWindow;
  heap: number | null;
  encounters: number;
  frames: number;
  resources: Sample['resources'];
}

/**
 * One reading, in a single synchronous evaluate so no engine frame runs between its parts: the
 * state check, the frame window, a forced GC and the heap after it, and the renderer's counts.
 * `null` (and nothing taken) when the engine is not at CRUISE with no encounter object, e.g. the
 * next encounter started between the wait and this call.
 */
function readSample(page: Page): Promise<PageReading | null> {
  return page.evaluate(() => {
    const hook = window.__elsewhere!;
    const p = hook.probe();
    if (p.state !== 'CRUISE' || p.encounterIndex >= 0) return null;
    // The window first, so the GC below falls outside it (and the sampler skips its interval).
    const frameWindow = window.__frameSampler!.take();
    const w = window as unknown as { gc?: () => void };
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    let heap: number | null = null;
    if (typeof w.gc === 'function' && memory) {
      w.gc();
      w.gc();
      window.__frameSampler!.skip(2);
      heap = memory.usedJSHeapSize;
    }
    const s = hook.snapshot();
    return {
      window: frameWindow,
      heap,
      encounters: s.autopilot.encounterCount,
      frames: s.frames,
      resources: {
        geometries: s.renderer.geometries,
        textures: s.renderer.textures,
        programs: s.renderer.programs,
        calls: s.renderer.calls,
      },
    };
  });
}

/** Waits for the next CRUISE with no encounter object and samples it (retrying if an encounter wins the race). */
async function takeSample(page: Page, startedAt: number): Promise<Sample> {
  const deadline = Date.now() + CRUISE_WAIT_MS;
  let reading: PageReading | null = null;
  while (reading === null) {
    await waitForCruise(page, Math.max(1, deadline - Date.now()));
    reading = await readSample(page);
  }
  const { window, heap } = reading;
  const encounter = { interval: frameTimeStats(window.encounter.interval), work: frameTimeStats(window.encounter.work) };
  return {
    atMin: (Date.now() - startedAt) / 60_000,
    encounters: reading.encounters,
    frames: reading.frames,
    heap,
    resources: reading.resources,
    cruise: { interval: frameTimeStats(window.cruise.interval), work: frameTimeStats(window.cruise.work) },
    encounter,
    marks: window.marks.map((mark) => ({
      ...mark,
      workP50: encounter.work?.p50 ?? null,
      intervalP50: encounter.interval?.p50 ?? null,
    })),
    window,
  };
}

const round = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? null : Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * Early and late frame times: every frame of the given bucket pooled over the first and the last
 * third of the compared samples (at least one sample each), so the p95 rests on many frames and
 * one noisy window cannot decide the outcome.
 */
function earlyLate(samples: readonly Sample[], pick: (w: FrameWindow) => readonly number[]) {
  const k = Math.max(1, Math.floor(samples.length / 3));
  const pooled = (part: readonly Sample[]) => frameTimeStats(part.flatMap((s) => pick(s.window)));
  return { early: pooled(samples.slice(0, k)), late: pooled(samples.slice(-k)) };
}

/** How the first visible frame of each encounter compares with the encounter frames around it. */
function spikeReport(samples: readonly Sample[]) {
  const rows = samples.flatMap((s) => s.marks);
  const ratio = (value: number | null, base: number | null) => (value === null || base === null || base <= 0 ? null : value / base);
  const worst = (pick: (r: (typeof rows)[number]) => number | null) =>
    rows.reduce<number | null>((m, r) => {
      const v = pick(r);
      return v === null ? m : m === null ? v : Math.max(m, v);
    }, null);
  return {
    encounters: rows.length,
    worstCreateWorkMs: round(worst((r) => r.createWork)),
    worstVisibleWorkMs: round(worst((r) => r.visibleWork)),
    worstVisibleNextIntervalRatio: round(worst((r) => ratio(r.visibleNextInterval, r.intervalP50)), 2),
    worstCreateNextIntervalRatio: round(worst((r) => ratio(r.createNextInterval, r.intervalP50)), 2),
  };
}

test(`soak: ${SOAK_MINUTES} min, heap, frame time and GPU resources stay stable`, async ({ page }) => {
  const durationMs = SOAK_MINUTES * 60_000;
  test.setTimeout(durationMs + 3 * CRUISE_WAIT_MS + 120_000);
  const errors = collectErrors(page);
  await page.setViewportSize(VIEWPORT);
  // The seeded default mix of planets and nebulae, at a short interval, flown from the top speed
  // (FAST_ENCOUNTERS_ARRIVAL_SPEED in e2e/limits.ts): without that override the encounters are
  // flown from the default speed after dropping out of warp, and a 3-minute run meets only 2 of them
  // and takes 2 samples (measured), too few for its checks. Heap, frame time and resources do not
  // depend on the speed profile.
  await page.goto(appUrl(`encounterInterval=${SOAK_ENCOUNTER_INTERVAL_SECONDS}&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  expect((await page.evaluate(() => window.__elsewhere!.snapshot())).autopilot.arrivalSpeed).toBe(FAST_ENCOUNTERS_ARRIVAL_SPEED);
  // Top speed (setSpeed clamps), so the encounters pass as quickly as the profile allows.
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  await installFrameSampler(page);

  // Warm-up: one full encounter first, at full speed, so every lazily created resource exists and
  // the cruise frames compared below all draw the same scene at the same speed.
  await page.waitForFunction(
    () => window.__elsewhere!.snapshot().autopilot.encounterCount >= 1,
    undefined,
    { timeout: CRUISE_WAIT_MS, polling: 250 },
  );
  // The first sample (at the CRUISE after the warm-up encounter) starts the clock. Its window covers
  // the warm-up, so only its heap and resources are used.
  let startedAt = Date.now();
  const samples: Sample[] = [await takeSample(page, startedAt)];
  startedAt = Date.now();
  samples[0]!.atMin = 0;

  // Then a sample due every SOAK_SAMPLE_SECONDS, each taken at the first CRUISE after it is due (so
  // the spacing is the later of the two: about one encounter cycle), until the run is over.
  let lastAt = startedAt;
  while (Date.now() - startedAt < durationMs) {
    const due = Math.min(lastAt + SOAK_SAMPLE_SECONDS * 1000, startedAt + durationMs);
    await page.waitForTimeout(Math.max(0, due - Date.now()));
    const sample = await takeSample(page, startedAt);
    lastAt = Date.now();
    samples.push(sample);
    console.log(
      `soak ${sample.atMin.toFixed(1)} min: ${sample.encounters} encounters, ` +
        `heap ${round((sample.heap ?? Number.NaN) / 1048576, 2)} MiB, ` +
        `cruise p95 ${round(sample.cruise.interval?.p95)} ms (work ${round(sample.cruise.work?.p95, 2)} ms, ` +
        `n ${sample.cruise.interval?.n ?? 0}), encounter p95 ${round(sample.encounter.interval?.p95)} ms, ` +
        `resources ${JSON.stringify(sample.resources)}`,
    );
  }

  const first = samples[0]!;
  const last = samples.at(-1)!;
  const compared = samples.slice(1);
  const interval = earlyLate(compared, (w) => w.cruise.interval);
  const work = earlyLate(compared, (w) => w.cruise.work);
  const encounterInterval = earlyLate(compared, (w) => w.encounter.interval);
  const heapGrowth = first.heap !== null && last.heap !== null ? last.heap - first.heap : null;
  const heaps = samples.map((s) => s.heap).filter((h): h is number => h !== null);
  const p95 = (pair: { early: FrameTimeStats | null; late: FrameTimeStats | null }, digits = 1) => ({
    early: round(pair.early?.p95, digits),
    late: round(pair.late?.p95, digits),
    earlyMean: round(pair.early?.mean, digits),
    lateMean: round(pair.late?.mean, digits),
    frames: [pair.early?.n ?? 0, pair.late?.n ?? 0],
  });
  const summary = {
    minutes: round(last.atMin, 2),
    samples: samples.length,
    encounters: last.encounters - first.encounters,
    frames: last.frames - first.frames,
    viewport: VIEWPORT,
    encounterInterval: SOAK_ENCOUNTER_INTERVAL_SECONDS,
    heap: {
      startBytes: first.heap,
      endBytes: last.heap,
      growthBytes: heapGrowth,
      minBytes: heaps.length > 0 ? Math.min(...heaps) : null,
      maxBytes: heaps.length > 0 ? Math.max(...heaps) : null,
      limitBytes: SOAK_HEAP_GROWTH_LIMIT_BYTES,
    },
    factor: SOAK_FRAME_TIME_FACTOR,
    cruiseFrameIntervalMs: p95(interval),
    cruiseFrameWorkMs: p95(work, 2),
    encounterFrameIntervalMs: p95(encounterInterval),
    resources: { start: first.resources, end: last.resources },
    firstVisibleFrame: spikeReport(compared),
    worstJump: last.window.worstJump,
    missedFrames: last.window.missedFrames,
  };
  // The report keeps each sample's statistics, not its raw frame times.
  const report = { summary, samples: samples.map(({ window: _raw, ...rest }) => rest) };
  console.log(`soak summary: ${JSON.stringify(summary, null, 2)}`);
  writeFileSync(test.info().outputPath('soak-report.json'), JSON.stringify(report, null, 2));
  await test.info().attach('soak report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  test.info().annotations.push({ type: 'soak summary', description: JSON.stringify(summary) });

  // Enough of a run to compare: several samples, and encounters between them.
  expect(samples.length, 'samples').toBeGreaterThanOrEqual(3);
  expect(summary.encounters, 'encounters during the soak').toBeGreaterThanOrEqual(2);
  // Resource counts at CRUISE never drift.
  for (const s of samples) expect(s.resources, `resources at ${s.atMin.toFixed(1)} min`).toEqual(first.resources);
  // Heap after GC does not grow beyond the limit.
  if (heapGrowth !== null) {
    expect(heapGrowth, 'heap growth (bytes)').toBeLessThanOrEqual(SOAK_HEAP_GROWTH_LIMIT_BYTES);
  } else {
    test.info().annotations.push({ type: 'heap growth', description: 'skipped: gc() or performance.memory unavailable' });
  }
  // Frame time late in the run is not worse than early on, beyond the factor.
  // Each side pools enough frames for its p95 to mean something.
  for (const [name, pair] of [['interval', interval], ['work', work]] as const) {
    expect(pair.early?.n ?? 0, `cruise frame ${name}s early in the run`).toBeGreaterThanOrEqual(SOAK_MIN_COMPARED_FRAMES);
    expect(pair.late?.n ?? 0, `cruise frame ${name}s late in the run`).toBeGreaterThanOrEqual(SOAK_MIN_COMPARED_FRAMES);
  }
  expect(interval.late!.p95, 'cruise p95 frame interval, late vs early (ms)').toBeLessThanOrEqual(
    interval.early!.p95 * SOAK_FRAME_TIME_FACTOR + SOAK_FRAME_TIME_SLACK_MS,
  );
  expect(work.late!.p95, 'cruise p95 frame work, late vs early (ms)').toBeLessThanOrEqual(
    work.early!.p95 * SOAK_FRAME_TIME_FACTOR + SOAK_FRAME_TIME_SLACK_MS,
  );
  // No encounter stalls the frame that creates its object or first draws it (a shader compile).
  expect(summary.firstVisibleFrame.encounters, 'encounters with frame marks').toBeGreaterThan(0);
  expect(summary.firstVisibleFrame.worstCreateWorkMs, 'object-creating frame work (ms)').not.toBeNull();
  expect(summary.firstVisibleFrame.worstVisibleWorkMs, 'first visible frame work (ms)').not.toBeNull();
  expect(summary.firstVisibleFrame.worstCreateWorkMs!, 'object-creating frame work (ms)').toBeLessThan(
    SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
  );
  expect(summary.firstVisibleFrame.worstVisibleWorkMs!, 'first visible frame work (ms)').toBeLessThan(
    SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
  );
  // No frame moves the ship further than its speed allows.
  expect(summary.worstJump).toBeLessThanOrEqual(1e-6);
  expect(errors).toEqual([]);
});
