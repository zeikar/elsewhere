import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import {
  CAMERA_FOV_DEG,
  DT_CAP_SECONDS,
  ENCOUNTER_INTERVAL_SECONDS,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
} from '../src/config';
import { DEFAULT_AUTOPILOT_PARAMS, setCruiseSpeed, type AutopilotParams, type EncounterKind } from '../src/engine/Autopilot';
import { encounterTargetSpeed } from '../src/engine/encounter';
import { SOAK_HEAP_GROWTH_LIMIT_BYTES } from './limits';

const APP_PATH = '/elsewhere/';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;

// A full encounter is about 35–95 s of simulated travel, and SwiftShader renders well under 10 fps,
// where the dt cap makes simulated time run slower than real time. Each test sets its own, long
// timeout; this is the floor for the file.
test.describe.configure({ timeout: 300_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/**
 * Opens the app, with the e2e-only overrides when given: the encounter interval, and `kind` to make
 * every encounter that kind (the seeded mix otherwise).
 */
async function openApp(page: Page, interval?: number, kind?: EncounterKind): Promise<void> {
  const query = new URLSearchParams();
  if (interval !== undefined) query.set('encounterInterval', String(interval));
  if (kind !== undefined) query.set('encounterKind', kind);
  const search = query.toString();
  await page.goto(search === '' ? APP_PATH : `${APP_PATH}?${search}`);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

interface Resources {
  geometries: number;
  textures: number;
  programs: number;
}

/** What the in-page watcher records, sampling the hook once per animation frame. */
interface TravelLog {
  /** Each travel state as it is entered, starting with the state at install. */
  states: { state: string; index: number | null; time: number }[];
  /** Renderer resources at install, before any encounter. */
  baseline: Resources;
  /**
   * Renderer resources and planet count on each return to CRUISE, and on the first and third the
   * used JS heap after a forced GC (`null` on the others, or without gc() / performance.memory).
   */
  afterEncounters: (Resources & { planets: number; heap: number | null })[];
  /** Frames whose planet count does not match the state (1 during an encounter, 0 outside). */
  planetCountErrors: string[];
  /** Largest step between consecutive frames beyond what the ship's speed allows (≤ 0 is fine). */
  worstJump: number;
  /** Simulation time and wall time (ms since install) of the first frame with fade > 0. */
  firstFade: { time: number; wallMs: number } | null;
  /** Angular radius (degrees) and opacity of the planet in the first frame it is drawn. */
  firstPlanet: { angularRadiusDeg: number; opacity: number } | null;
  /** Wall time between consecutive engine frames, in ms, by situation. */
  frameMs: { cruise: number[]; closest: number[]; onScreen: number[] };
  /** Snapshot taken when the watcher paused the engine mid-APPROACH, or null. */
  pausedAt: E2EHookSnapshot | null;
}

declare global {
  interface Window {
    __travelLog?: TravelLog;
  }
}

/**
 * Installs the watcher. It runs in the page on every animation frame, so it sees every state the
 * engine renders. With `pauseOnScreen`, it pauses the engine at the first APPROACH frame where the
 * planet is at least half faded in and its centre is well inside the view.
 */
function watchTravel(page: Page, options: { pauseOnScreen?: boolean } = {}): Promise<void> {
  return page.evaluate(
    ({ pauseOnScreen, dtCap }) => {
      const hook = window.__elsewhere!;
      let prev = hook.snapshot();
      let prevAt = performance.now();
      const start = prevAt;
      // Set while the engine is paused, so the frame interval spanning the pause is not timed.
      let skipInterval = false;
      const resources = (s: typeof prev) => ({
        geometries: s.renderer.geometries,
        textures: s.renderer.textures,
        programs: s.renderer.programs,
      });
      /** Used JS heap after a full GC, or null without --js-flags=--expose-gc / performance.memory. */
      const heapAfterGc = (): number | null => {
        const w = window as unknown as { gc?: () => void };
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        if (typeof w.gc !== 'function' || !memory) return null;
        w.gc();
        w.gc();
        return memory.usedJSHeapSize;
      };
      const log: TravelLog = {
        states: [{ state: prev.autopilot.state, index: prev.autopilot.encounterIndex, time: prev.ship.time }],
        baseline: resources(prev),
        afterEncounters: [],
        planetCountErrors: [],
        worstJump: Number.NEGATIVE_INFINITY,
        firstFade: null,
        firstPlanet: null,
        frameMs: { cruise: [], closest: [], onScreen: [] },
        pausedAt: null,
      };
      window.__travelLog = log;

      const tick = () => {
        requestAnimationFrame(tick);
        const s = hook.snapshot();
        const now = performance.now();
        if (s.paused) skipInterval = true;
        if (s.frames === prev.frames) return;
        const a = s.autopilot;

        if (s.frames === prev.frames + 1) {
          const p = s.ship.position;
          const q = prev.ship.position;
          const moved = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
          log.worstJump = Math.max(log.worstJump, moved - Math.max(s.ship.speed, prev.ship.speed) * dtCap);
          if (!skipInterval) {
            const ms = now - prevAt;
            if (s.planet === null && a.state === 'CRUISE') log.frameMs.cruise.push(ms);
            else if (a.remaining !== null && Math.abs(a.remaining) < 60) log.frameMs.closest.push(ms);
            else if (s.planet?.visible && Math.abs(s.planet.ndc.x) < 1 && Math.abs(s.planet.ndc.y) < 1) {
              log.frameMs.onScreen.push(ms);
            }
          }
        }

        if (a.state !== log.states.at(-1)!.state) {
          log.states.push({ state: a.state, index: a.encounterIndex, time: s.ship.time });
          if (a.state === 'CRUISE') {
            const n = log.afterEncounters.length + 1;
            const heap = n === 1 || n === 3 ? heapAfterGc() : null;
            log.afterEncounters.push({ ...resources(s), planets: s.planets, heap });
          }
        }
        const expectedPlanets = a.encounterIndex === null ? 0 : 1;
        if (s.planets !== expectedPlanets) {
          log.planetCountErrors.push(`frame ${s.frames}: ${a.state} with ${s.planets} planets`);
        }
        if (log.firstFade === null && a.fade > 0) log.firstFade = { time: s.ship.time, wallMs: now - start };
        if (log.firstPlanet === null && s.planet?.visible) {
          log.firstPlanet = {
            angularRadiusDeg: (Math.asin(Math.min(1, s.planet.drawnRadius / s.planet.distance)) * 180) / Math.PI,
            opacity: s.planet.opacity,
          };
        }
        if (
          pauseOnScreen &&
          log.pausedAt === null &&
          a.state === 'APPROACH' &&
          s.planet !== null &&
          a.fade >= 0.5 &&
          Math.abs(s.planet.ndc.x) < 0.7 &&
          Math.abs(s.planet.ndc.y) < 0.7
        ) {
          hook.pause();
          log.pausedAt = hook.snapshot();
        }
        prev = s;
        prevAt = now;
        skipInterval = s.paused;
      };
      requestAnimationFrame(tick);
    },
    { pauseOnScreen: options.pauseOnScreen ?? false, dtCap: DT_CAP_SECONDS },
  );
}

function travelLog(page: Page): Promise<TravelLog> {
  return page.evaluate(() => window.__travelLog!);
}

/** Number of completed encounters (returns to CRUISE) the watcher has seen. */
async function encountersDone(page: Page): Promise<number> {
  return (await travelLog(page)).afterEncounters.length;
}

/** Mean and median of the values, rounded to 0.1, or null when there are none. */
function summary(values: readonly number[]): { mean: number; median: number; n: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    mean: round(values.reduce((sum, v) => sum + v, 0) / values.length),
    median: round(sorted[Math.floor(sorted.length / 2)]!),
    n: values.length,
  };
}

/** Fraction of lit pixels in the RGBA image within the annulus [inner, outer) around (cx, cy), in pixels. */
function litFraction(
  pixels: readonly number[],
  width: number,
  height: number,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
): { lit: number; total: number } {
  let lit = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(cy - outer)); y < Math.min(height, Math.ceil(cy + outer)); y++) {
    for (let x = Math.max(0, Math.floor(cx - outer)); x < Math.min(width, Math.ceil(cx + outer)); x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (r < inner || r >= outer) continue;
      const i = (y * width + x) * 4;
      total++;
      if (Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > LIT_THRESHOLD) lit++;
    }
  }
  return { lit, total };
}

/** Screenshots the engine canvas; returns the PNG and its RGBA pixels (decoded in the page). */
async function engineShot(page: Page): Promise<{ png: Buffer; pixels: number[]; width: number; height: number }> {
  const png = await page.locator('#scene').screenshot();
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { pixels: Array.from(data), width: bitmap.width, height: bitmap.height };
  }, png.toString('base64'));
  return { png, ...decoded };
}

test('three encounters run CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE and free their GPU resources', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  // No pixels are checked here, and SwiftShader is fill-rate bound (the dt cap slows simulated time
  // at low frame rates), so a small viewport makes the three encounters pass much sooner.
  await page.setViewportSize({ width: 480, height: 270 });
  await openApp(page, 1);
  // Top speed (setSpeed clamps), so the encounters pass as quickly as the profile allows.
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  await watchTravel(page);

  const start = await travelLog(page);
  expect(start.states).toEqual([{ state: 'CRUISE', index: null, time: expect.any(Number) }]);
  expect((await snapshot(page)).autopilot.interval).toBe(1);

  await expect.poll(() => encountersDone(page), { timeout: 540_000, intervals: [2_000] }).toBeGreaterThanOrEqual(3);
  const log = await travelLog(page);
  test.info().annotations.push({ type: 'travel log', description: JSON.stringify({ ...log, frameMs: undefined }) });

  // The default seeded mix of kinds (a planet, a nebula, then a planet with the default base seed;
  // the nebula and variety specs check nebulae). The full cycle, three times, each with its own index.
  expect(log.states.slice(0, 13).map((s) => [s.state, s.index])).toEqual([
    ['CRUISE', null],
    ...[0, 1, 2].flatMap((i) => [
      ['APPROACH', i],
      ['FLYBY', i],
      ['DEPARTURE', i],
      ['CRUISE', null],
    ]),
  ]);
  // One planet in the scene during each encounter and none between them.
  expect(log.planetCountErrors).toEqual([]);
  // The planet starts as a faint, distant dot (no pop-in).
  expect(log.firstPlanet).not.toBeNull();
  expect(log.firstPlanet!.angularRadiusDeg).toBeLessThan(1.5);
  expect(log.firstPlanet!.opacity).toBeLessThan(0.1);
  // No frame moves the ship further than its speed allows.
  expect(log.worstJump).toBeLessThanOrEqual(1e-6);

  // After one encounter, geometries and textures are back at the pre-encounter baseline, and the
  // compiled programs do not grow over three.
  const [first, second, third] = log.afterEncounters;
  expect(log.baseline.geometries).toBeGreaterThan(0);
  expect(first!.planets).toBe(0);
  expect(first!.geometries).toBe(log.baseline.geometries);
  expect(first!.textures).toBe(log.baseline.textures);
  for (const after of [second!, third!]) {
    expect(after.geometries).toBe(log.baseline.geometries);
    expect(after.textures).toBe(log.baseline.textures);
    expect(after.planets).toBe(0);
  }
  expect(third!.programs).toBeLessThanOrEqual(first!.programs);
  expect(second!.programs).toBeLessThanOrEqual(first!.programs);
  // Nor does the JS heap grow from the first return to CRUISE to the third.
  if (first!.heap !== null && third!.heap !== null) {
    const growth = third!.heap - first!.heap;
    test.info().annotations.push({ type: 'heap growth over two encounters (bytes)', description: String(growth) });
    expect(growth).toBeLessThan(SOAK_HEAP_GROWTH_LIMIT_BYTES);
  } else {
    test.info().annotations.push({ type: 'heap growth', description: 'skipped: gc() or performance.memory unavailable' });
  }
  expect(errors).toEqual([]);
});

test('mid-APPROACH the planet is lit on the engine canvas, and pause → resume → ArrowUp keeps the encounter consistent', async ({
  page,
}) => {
  test.setTimeout(480_000);
  const errors = collectErrors(page);
  // Planets only: this checks the planet's pixels, whatever kind the seeded schedule picks first.
  await openApp(page, 2, 'planet');
  await watchTravel(page, { pauseOnScreen: true });

  // The watcher pauses the engine once the planet is half faded in and well inside the view.
  await expect
    .poll(async () => (await travelLog(page)).pausedAt !== null, { timeout: 300_000, intervals: [1_000] })
    .toBe(true);
  const paused = (await travelLog(page)).pausedAt!;
  expect(paused.paused).toBe(true);
  expect(paused.autopilot.state).toBe('APPROACH');
  expect(paused.planets).toBe(1);
  const planet = paused.planet!;

  // Paused: the encounter is frozen.
  await page.waitForTimeout(1_000);
  const still = await snapshot(page);
  expect(still.frames).toBe(paused.frames);
  expect(still.ship.position).toEqual(paused.ship.position);
  expect(still.autopilot).toEqual(paused.autopilot);
  expect(still.planet).toEqual(paused.planet);

  // The engine canvas still shows the last frame. The planet's centre region is lit, and the sky
  // just outside its disc is mostly dark (stars only).
  const shot = await engineShot(page);
  writeFileSync(test.info().outputPath('approach.png'), shot.png);
  await test.info().attach('engine canvas mid-APPROACH', { body: shot.png, contentType: 'image/png' });
  const cx = ((planet.ndc.x + 1) / 2) * shot.width;
  const cy = ((1 - planet.ndc.y) / 2) * shot.height;
  const angular = Math.asin(Math.min(1, planet.drawnRadius / planet.distance));
  const radiusPx = (Math.tan(angular) / Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180)) * (shot.height / 2);
  expect(radiusPx).toBeGreaterThan(8);
  const centre = litFraction(shot.pixels, shot.width, shot.height, cx, cy, 0, radiusPx * 0.5);
  const sky = litFraction(shot.pixels, shot.width, shot.height, cx, cy, radiusPx * 1.6, radiusPx * 2.4);
  test.info().annotations.push({
    type: 'planet on screen',
    description: JSON.stringify({ cx, cy, radiusPx, centre, sky, fade: paused.autopilot.fade }),
  });
  expect(centre.total).toBeGreaterThan(0);
  expect(centre.lit / centre.total).toBeGreaterThan(0.6);
  expect(sky.lit / Math.max(1, sky.total)).toBeLessThan(0.3);

  // Resume, then ArrowUp: one speed level up in the middle of the encounter.
  await page.evaluate(() => window.__elsewhere!.resume());
  await expect.poll(async () => (await snapshot(page)).frames, { timeout: 30_000 }).toBeGreaterThan(paused.frames + 1);
  await page.keyboard.press('ArrowUp');
  const pressed = await snapshot(page);
  expect(pressed.speed).toBe(SHIP_DEFAULT_SPEED_LEVEL + 1);
  await expect.poll(async () => (await snapshot(page)).frames, { timeout: 30_000 }).toBeGreaterThan(pressed.frames);
  const faster = await snapshot(page);
  expect(faster.autopilot.encounterIndex).toBe(paused.autopilot.encounterIndex);
  expect(['APPROACH', 'FLYBY', 'DEPARTURE']).toContain(faster.autopilot.state);
  // The new level scales the speed profile; it does not replace the encounter's slowdown.
  const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL + 1]!);
  expect(faster.autopilot.targetSpeed).toBeCloseTo(
    encounterTargetSpeed(faster.autopilot.remaining!, params.cruiseSpeed, params.profile),
    6,
  );

  // The encounter carries on through every state to CRUISE, with no jump at any frame.
  await expect.poll(() => encountersDone(page), { timeout: 300_000, intervals: [2_000] }).toBeGreaterThanOrEqual(1);
  const log = await travelLog(page);
  expect(log.states.slice(0, 5).map((s) => s.state)).toEqual(['CRUISE', 'APPROACH', 'FLYBY', 'DEPARTURE', 'CRUISE']);
  expect(log.states.slice(1, 4).map((s) => s.index)).toEqual([0, 0, 0]);
  expect(log.worstJump).toBeLessThanOrEqual(1e-6);
  expect(log.planetCountErrors).toEqual([]);

  // Frame time under SwiftShader: a relative sanity number only (software rendering), reported.
  const frameMs = {
    cruise: summary(log.frameMs.cruise),
    planetOnScreen: summary(log.frameMs.onScreen),
    closestApproach: summary(log.frameMs.closest),
  };
  test.info().annotations.push({ type: 'frame ms (SwiftShader)', description: JSON.stringify(frameMs) });
  console.log(`frame ms (SwiftShader): ${JSON.stringify(frameMs)}`);
  expect(log.frameMs.closest.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('with the default config, a planet becomes visible within 60 s of load', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = collectErrors(page);
  // The default interval (with its seeded jitter), with every encounter a planet.
  await openApp(page, undefined, 'planet');
  await watchTravel(page);
  const start = await snapshot(page);
  expect(start.autopilot.interval).toBe(ENCOUNTER_INTERVAL_SECONDS);
  expect(start.autopilot.encounterCount).toBe(0);

  await expect
    .poll(async () => (await travelLog(page)).firstFade !== null, { timeout: 360_000, intervals: [1_000] })
    .toBe(true);
  const { firstFade } = await travelLog(page);
  const snap = await snapshot(page);
  test.info().annotations.push({ type: 'first fade > 0', description: JSON.stringify(firstFade) });
  // Measured on the simulation clock, which is real time at 10 fps and above. SwiftShader renders
  // below that, where the dt cap slows simulated time down, so wall time here runs longer.
  expect(firstFade!.time).toBeLessThanOrEqual(60);
  expect(snap.autopilot.encounterIndex).toBe(0);
  expect(snap.planets).toBe(1);
  expect(errors).toEqual([]);
});
