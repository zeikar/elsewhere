/**
 * Performance instrumentation and long-run stability checks that fit in the regular e2e run
 * (docs/PLAN.md sections 5, 6 Performance and 10). The long soak is e2e/soak/soak.spec.ts
 * (`npm run soak`).
 */
import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { installFrameSampler, takeFrameWindow } from './frameSampler';
import { appUrl } from './app';
import { CRUISE_PROGRAMS } from './limits';
import { DT_CAP_SECONDS, ENCOUNTER_BASE_SEED } from '../src/config';
import { generateGalaxies } from '../src/engine/Galaxies';
import { formatTripSeed } from '../src/tripSeed';

// SwiftShader renders at only a few fps; each test sets its own, longer timeout where it needs one.
test.describe.configure({ timeout: 300_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

/**
 * Fakes the page's visibility (the tab hidden or shown), fires `visibilitychange`, and returns a
 * snapshot taken right after, before any further frame.
 */
function setVisibility(page: Page, hidden: boolean): Promise<E2EHookSnapshot> {
  return page.evaluate((hidden) => {
    if (hidden) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    } else {
      // Back to the real (visible) getters on Document.prototype.
      delete (document as { visibilityState?: unknown }).visibilityState;
      delete (document as { hidden?: unknown }).hidden;
    }
    document.dispatchEvent(new Event('visibilitychange'));
    return window.__elsewhere!.snapshot();
  }, hidden);
}

test('the hook reports frame-time statistics, the heap and renderer.info, and a pause is never counted as a frame', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(appUrl(`encounterInterval=1e9`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().perf.frameMs.count ?? 0) >= 5);
  const s = await snapshot(page);
  const { frameMs, workMs, heapUsed } = s.perf;
  for (const stats of [frameMs, workMs]) {
    expect(stats.count).toBeGreaterThanOrEqual(5);
    expect(stats.total).toBeGreaterThanOrEqual(stats.count);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.mean! * 0.5);
    expect(stats.max).toBeGreaterThanOrEqual(stats.p95!);
    expect(stats.last).not.toBeNull();
  }
  // Chromium: performance.memory.
  expect(heapUsed).toBeGreaterThan(0);
  expect(s.renderer.calls).toBeGreaterThan(0);
  expect(s.renderer.geometries).toBeGreaterThan(0);
  expect(s.renderer.programs).toBeGreaterThan(0);

  // The probe agrees with the snapshot and fills the object it is given.
  const probe = await page.evaluate(() => {
    const hook = window.__elsewhere!;
    const out = hook.probe();
    const again = hook.probe(out);
    return { same: again === out, out };
  });
  expect(probe.same).toBe(true);
  expect(probe.out.state).toBe('CRUISE');
  expect(probe.out.encounterIndex).toBe(-1);
  expect(probe.out.visible).toBe(false);
  expect(probe.out.frames).toBeGreaterThanOrEqual(s.frames);

  // A 3 s pause is never counted as a frame: the first frame after resume has no interval, so
  // every frame after it adds one interval and that first one adds none.
  await page.evaluate(() => window.__elsewhere!.pause());
  const paused = await snapshot(page);
  await page.waitForTimeout(3_000);
  await page.evaluate(() => window.__elsewhere!.resume());
  await page.waitForFunction((frames) => window.__elsewhere!.snapshot().frames >= frames + 4, paused.frames);
  const after = await snapshot(page);
  expect(after.perf.frameMs.total - paused.perf.frameMs.total).toBe(after.frames - paused.frames - 1);
  expect(after.perf.frameMs.last).toBeLessThan(3_000);
  expect(errors).toEqual([]);
});

test('the frame-rate cap: the engine draws at most the cap a second, and the simulation stays real time', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 160, height: 90 });
  // The default cap, then a cap of 15 fps (an e2e-only override), well under headless Chromium's 60 Hz.
  await page.goto(appUrl('encounterInterval=1e9'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) >= 5);
  expect((await snapshot(page)).frameRateCap).toBe(60);
  // Only the far stars: under SwiftShader the near starfield's quads alone take 100–270 ms a frame
  // even at 160×90, over the dt cap, which would rightly hold the simulation back.
  await page.goto(appUrl('encounterInterval=1e9&frameRateCap=15&starLayers=far'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) >= 5);
  expect((await snapshot(page)).frameRateCap).toBe(15);
  // Over 4 s, read at drawn frames only (in the page, so both ends are frame boundaries): frames
  // drawn, and the simulated time against the wall-clock time between the first and last of them.
  // The window starts after a second of steady frames: under SwiftShader a frame or two soon after
  // start-up stall (on main too), and the dt cap rightly drops most of such a stall from the
  // simulation.
  const run = await page.evaluate(
    (dtCapMs) =>
      new Promise<{ drawn: number; wall: number; simulated: number; distance: number }>((resolve) => {
        const hook = window.__elsewhere!;
        let first: { frames: number; at: number; time: number; distance: number } | null = null;
        let last = hook.snapshot().frames;
        let lastAt = Number.NaN;
        let steady = 0;
        const tick = (at: number) => {
          const s = hook.snapshot();
          if (s.frames !== last) {
            last = s.frames;
            steady = at - lastAt < dtCapMs ? steady + 1 : 0;
            lastAt = at;
            if (first === null) {
              if (steady >= 15) first = { frames: s.frames, at, time: s.ship.time, distance: s.ship.distance };
            } else if (at - first.at >= 4_000) {
              resolve({ drawn: s.frames - first.frames, wall: at - first.at, simulated: s.ship.time - first.time, distance: s.ship.distance - first.distance });
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    DT_CAP_SECONDS * 1000,
  );
  test.info().annotations.push({ type: 'capped at 15 fps', description: JSON.stringify({ ...run, ratio: run.simulated / (run.wall / 1000) }) });
  expect(run.drawn).toBeGreaterThan(0);
  // At most 15 a second (one more for the window's ends).
  expect(run.drawn).toBeLessThanOrEqual(Math.ceil((run.wall / 1000) * 15) + 1);
  // Each drawn frame steps the simulation by the real time since the last (a 15 fps frame, 67 ms,
  // is under the 100 ms dt cap, DT_CAP_SECONDS), so the simulation keeps real time, not 1/60 s a
  // drawn frame (which would be a quarter of it). The margin below allows for a few frames over the
  // dt cap on a loaded CI machine.
  expect(run.simulated).toBeGreaterThan(0.8 * (run.wall / 1000));
  expect(run.simulated).toBeLessThan(1.1 * (run.wall / 1000));
  expect(run.distance).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

/**
 * The GPU resource budget at cruise (no encounter object): what the sky costs.
 *
 * - The far stars, the near dust and, in a trip with any distant galaxy, the galaxy layer: one
 *   geometry and one draw call each.
 * - Programs: one per sky layer drawn, plus the eight encounter programs ProgramWarmup keeps from
 *   start-up (the procedural and baked rocky and gas planet surfaces, the two surface bakes, the
 *   halo (atmosphere, rings, comet glow) and the nebula layers; CRUISE_PROGRAMS in e2e/limits.ts).
 *   Before issue #65 there were four (7 and 6 in all).
 * - Textures: none. A planet's bake cube maps exist only while it does.
 *
 * So the galaxies add at most one geometry, one program and one draw call: 3, 11 and 3 in a trip
 * with galaxies (the test default trip has two), and 2, 10 and 2 in a trip without, where the
 * galaxy layer is hidden and never compiled.
 */
test('the resource budget at cruise: the distant galaxies add one geometry, one program and one draw call', async ({ page }) => {
  const errors = collectErrors(page);
  const budget = async (seed: number, programs: number) => {
    await page.goto(appUrl(`encounterInterval=1e9&seed=${formatTripSeed(seed)}`));
    await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) >= 5);
    // The encounter programs are compiled asynchronously at start-up: wait until they all are.
    await expect.poll(async () => (await snapshot(page)).renderer.programs, { timeout: 60_000 }).toBe(programs);
    const s = await snapshot(page);
    expect(s.autopilot.state).toBe('CRUISE');
    expect(s.planets).toBe(0);
    return { galaxies: s.galaxies.items.length, visible: s.galaxies.visible, ...s.renderer };
  };
  const withGalaxies = await budget(ENCOUNTER_BASE_SEED, CRUISE_PROGRAMS.withGalaxies);
  // A trip without galaxies (0–3 per trip, from the trip seed).
  let emptySeed = 1;
  while (generateGalaxies(emptySeed).length > 0) emptySeed++;
  const without = await budget(emptySeed, CRUISE_PROGRAMS.withoutGalaxies);
  test.info().annotations.push({ type: 'cruise budget', description: JSON.stringify({ withGalaxies, without, emptySeed }) });
  expect(withGalaxies).toMatchObject({ galaxies: 2, visible: true, geometries: 3, programs: CRUISE_PROGRAMS.withGalaxies, calls: 3, textures: 0 });
  expect(without).toMatchObject({ galaxies: 0, visible: false, geometries: 2, programs: CRUISE_PROGRAMS.withoutGalaxies, calls: 2, textures: 0 });
  expect(errors).toEqual([]);
});

test('hidden → 5 s → visible mid-encounter moves the ship by no more than one capped frame', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = collectErrors(page);
  // Small viewport: SwiftShader is fill-rate bound and no pixels are checked here.
  await page.setViewportSize({ width: 480, height: 270 });
  await page.goto(appUrl(`encounterInterval=1&encounterKind=planet`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  await installFrameSampler(page);

  // Mid-encounter: APPROACH with the planet drawn.
  await page.waitForFunction(
    () => {
      const p = window.__elsewhere!.probe();
      return p.state === 'APPROACH' && p.visible;
    },
    undefined,
    { timeout: 300_000, polling: 100 },
  );
  const before = await snapshot(page);

  const hiddenAt = await setVisibility(page, true);
  await page.waitForTimeout(5_000);
  const stillHidden = await snapshot(page);
  // Hidden: the clock is stopped, so nothing moves (the page itself keeps running its frames here),
  // and none of those frames counts in the frame-time statistics.
  expect(stillHidden.frames).toBeGreaterThan(hiddenAt.frames);
  expect(stillHidden.ship.position).toEqual(hiddenAt.ship.position);
  expect(stillHidden.ship.time).toBe(hiddenAt.ship.time);
  expect(stillHidden.perf.frameMs.total).toBe(hiddenAt.perf.frameMs.total);

  const shown = await setVisibility(page, false);
  await page.waitForFunction((frames) => window.__elsewhere!.snapshot().frames >= frames + 10, shown.frames);
  const after = await snapshot(page);
  // Travel carries on with the same encounter, from where it stopped.
  expect(after.ship.distance).toBeGreaterThan(stillHidden.ship.distance);
  expect(after.autopilot.encounterIndex).toBe(before.autopilot.encounterIndex);
  // No frame, the one after the return included, moved further than speed × the dt cap.
  const frames = await takeFrameWindow(page);
  expect(frames.missedFrames).toBe(0);
  expect(frames.worstJump).toBeLessThanOrEqual(1e-6);
  // The first frame after the return has no interval: the hidden period is not a frame either.
  expect(after.perf.frameMs.total - shown.perf.frameMs.total).toBe(after.frames - shown.frames - 1);
  expect(errors).toEqual([]);
});
