/**
 * Dropping out of warp at the top speed level (docs/PLAN.md section 1), on the real path: no
 * `?arrivalSpeed=` override, so the engine flies the encounter from ENCOUNTER_ARRIVAL_SPEED. A fake
 * clock steps the real engine one capped frame at a time, so simulated time runs as fast as
 * SwiftShader can draw the frames. The drop out of warp, which for a planet with a far stretch
 * (config.ts, ENCOUNTER_FAR_SPEED) happens during the far stretch rather than in the cruise before
 * it, and the return to warp at the start of the next cruise are both checked here; their shape and bounds at every
 * level are checked in src/engine/Autopilot.test.ts. So is the quick return to warp once a planet
 * has left the screen, at the default level (docs/PLAN.md section 9, Phase 4).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_WARP_ENTRY_SECONDS,
  ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  ENCOUNTER_WARP_EXIT_SECONDS,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
} from '../src/config';
import { appUrl } from './app';

const TOP_SPEED = SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!;
/**
 * Mean cruise length. It must leave room for the return to warp, the drop out of it and its lead
 * (21 s in all) in the shortest jittered cruise (80% of the mean), or the ship never gets back to warp
 * between encounters: at 20 s it peaks at about 132 units per second, at 30 s at about 150.
 */
const INTERVAL_SECONDS = 30;

// Each clock step is one action; a trace of them all would take long to write (see
// acceleratedEncounters.spec.ts).
test.use({ trace: 'off' });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

interface WarpLog {
  /** Highest ship speed in the first cruise, before the first encounter starts. */
  firstCruiseMax: number;
  /** Ship speed on the first frame of the first encounter (its spawn), or `null` until then. */
  speedAtSpawn: number | null;
  /** Ship speed on the first frame past the end of the planet's far stretch, or `null` until then. */
  speedAtFarEnd: number | null;
  /** Ship time at which the first encounter ended (back to CRUISE), or `null` until then. */
  endedAt: number | null;
  /** Ship time at which the ship was back in warp (95% of the top speed) after it, or `null`. */
  backInWarpAt: number | null;
  /** Highest ship speed in the cruise after the first encounter. */
  afterMax: number;
  kinds: string[];
}

declare global {
  interface Window {
    __warpLog?: WarpLog;
  }
}

test('at the top speed the ship stays in warp into a planet encounter, is out of it by the end of the far stretch, and returns to warp after it', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  // Each 100 ms clock step runs exactly one engine frame of the capped dt; a tiny viewport keeps the
  // frames cheap. No pixels are checked.
  expect(INTERVAL_SECONDS * 0.8).toBeGreaterThan(
    ENCOUNTER_WARP_ENTRY_SECONDS + ENCOUNTER_WARP_EXIT_SECONDS + ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  );
  await page.setViewportSize({ width: 96, height: 54 });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(appUrl(`encounterInterval=${INTERVAL_SECONDS}&encounterKind=planet`));
  await page.waitForFunction(() => window.__elsewhere !== undefined);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  const start = await page.evaluate(() => window.__elsewhere!.snapshot());
  expect(SHIP_SPEED_LEVELS[start.speed]).toBe(TOP_SPEED);
  // The real arrival speed, not the e2e override.
  expect(start.autopilot.arrivalSpeed).toBe(ENCOUNTER_ARRIVAL_SPEED);
  expect(start.autopilot.state).toBe('CRUISE');

  await page.evaluate((warp) => {
    const hook = window.__elsewhere!;
    const log: WarpLog = { firstCruiseMax: 0, speedAtSpawn: null, speedAtFarEnd: null, endedAt: null, backInWarpAt: null, afterMax: 0, kinds: [] };
    window.__warpLog = log;
    let state = hook.snapshot().autopilot.state;
    let frames = hook.snapshot().frames;
    const tick = () => {
      requestAnimationFrame(tick);
      const now = hook.snapshot();
      if (now.frames === frames) return;
      frames = now.frames;
      const a = now.autopilot;
      const speed = now.ship.speed;
      if (a.state !== state) {
        if (a.state === 'APPROACH') log.kinds.push(a.kind ?? '?');
        if (a.state === 'CRUISE' && log.endedAt === null) log.endedAt = now.ship.time;
        state = a.state;
      }
      if (a.encounterCount === 0) log.firstCruiseMax = Math.max(log.firstCruiseMax, speed);
      if (log.speedAtSpawn === null && a.encounterCount === 1) log.speedAtSpawn = speed;
      if (log.speedAtFarEnd === null && a.encounterCount === 1 && a.farEnd !== null && a.remaining !== null && a.remaining <= a.farEnd) {
        log.speedAtFarEnd = speed;
      }
      if (log.endedAt !== null && a.state === 'CRUISE' && a.encounterCount === 1) {
        log.afterMax = Math.max(log.afterMax, speed);
        if (log.backInWarpAt === null && speed > warp) log.backInWarpAt = now.ship.time;
      }
    };
    requestAnimationFrame(tick);
  }, 0.95 * TOP_SPEED);

  const backInWarp = () => page.evaluate(() => window.__warpLog!.backInWarpAt !== null);
  const startedAt = Date.now();
  while (!(await backInWarp())) {
    for (let i = 0; i < 50; i++) await page.clock.fastForward(100);
    expect(Date.now() - startedAt, 'back in warp in time').toBeLessThan(240_000);
  }
  const log = await page.evaluate(() => window.__warpLog!);
  test.info().annotations.push({
    type: 'warp',
    description: JSON.stringify({ wallSeconds: (Date.now() - startedAt) / 1000, ...log }),
  });

  expect(log.kinds).toEqual(['planet']);
  // In warp during the first cruise and still at the spawn (the test default trip's first planet,
  // small enough to have a far stretch, which the ship flies on from the top speed), out of it by the
  // end of the far stretch (the planet 3° across), and back in warp after the encounter.
  expect(log.firstCruiseMax).toBeGreaterThan(0.95 * TOP_SPEED);
  expect(log.speedAtSpawn).not.toBeNull();
  expect(log.speedAtSpawn!).toBeGreaterThan(0.95 * TOP_SPEED);
  expect(log.speedAtFarEnd).not.toBeNull();
  expect(log.speedAtFarEnd!).toBeLessThanOrEqual(ENCOUNTER_ARRIVAL_SPEED + 0.5);
  expect(log.endedAt).not.toBeNull();
  expect(log.afterMax).toBeGreaterThan(0.95 * TOP_SPEED);
  // The quick return to warp after a planet that left the screen leads the ship's lag; one target per
  // capped frame can leave the ship a few hundredths of a unit per second over for a moment.
  expect(log.afterMax).toBeLessThanOrEqual(TOP_SPEED + 0.05);
  expect(errors).toEqual([]);
});

interface OffScreenLog {
  /** Cruise speed at the default level. */
  cruise: number;
  /** Ship time of the first frame the autopilot saw the planet off screen, or `null` until then. */
  offAt: number | null;
  /** The planet's centre in normalised device coordinates on that frame. */
  ndcAtOff: { x: number; y: number; z: number } | null;
  /** Whether the planet was drawn on that frame (it is removed within three frames). */
  drawnAtOff: boolean | null;
  /** Remaining distance to the closest approach on that frame. */
  remainingAtOff: number | null;
  /** Ship time at which the encounter ended (back to CRUISE), or `null` until then. */
  endedAt: number | null;
  /** Ship times at which the ship was first at 50% and 90% of the cruise speed after that, or `null`. */
  halfAt: number | null;
  mostAt: number | null;
  /** The autopilot's view and the camera's on the first frame. */
  view: { aspect: number; halfFovY: number } | null;
  camera: { aspect: number; fov: number };
  /** Whether the cruise after the encounter used the quick entry. */
  entryQuick: boolean | null;
}

declare global {
  interface Window {
    __offScreenLog?: OffScreenLog;
  }
}

test('at the default speed the ship is at 50% and 90% of the cruise speed within 2.5 s and 5 s of the planet leaving the screen', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  // As above: one capped engine frame per 100 ms clock step, on a tiny 16:9 viewport.
  await page.setViewportSize({ width: 96, height: 54 });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(appUrl('encounterInterval=5&encounterKind=planet'));
  await page.waitForFunction(() => window.__elsewhere !== undefined);
  const start = await page.evaluate(() => window.__elsewhere!.snapshot());
  expect(SHIP_SPEED_LEVELS[start.speed]).toBe(SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL]);

  await page.evaluate((cruise) => {
    const hook = window.__elsewhere!;
    const first = hook.snapshot();
    const log: OffScreenLog = {
      cruise,
      offAt: null,
      ndcAtOff: null,
      drawnAtOff: null,
      remainingAtOff: null,
      endedAt: null,
      halfAt: null,
      mostAt: null,
      view: first.autopilot.view,
      camera: { aspect: first.cameraAspect, fov: first.cameraFov },
      entryQuick: null,
    };
    window.__offScreenLog = log;
    let frames = first.frames;
    const tick = () => {
      requestAnimationFrame(tick);
      const now = hook.snapshot();
      if (now.frames === frames) return;
      frames = now.frames;
      const a = now.autopilot;
      if (log.offAt === null && a.encounterIndex === 0 && a.viewMargin !== null && a.viewMargin > 0) {
        log.offAt = now.ship.time;
        log.ndcAtOff = now.planet?.ndc ?? null;
        log.drawnAtOff = now.planet?.visible ?? null;
        log.remainingAtOff = a.remaining;
      }
      if (log.offAt === null) return;
      if (log.endedAt === null && a.state === 'CRUISE') {
        log.endedAt = now.ship.time;
        log.entryQuick = a.entryQuick;
      }
      if (log.halfAt === null && now.ship.speed >= 0.5 * cruise) log.halfAt = now.ship.time;
      if (log.mostAt === null && now.ship.speed >= 0.9 * cruise) log.mostAt = now.ship.time;
    };
    requestAnimationFrame(tick);
  }, SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL]!);

  const done = () => page.evaluate(() => window.__offScreenLog!.mostAt !== null);
  const startedAt = Date.now();
  while (!(await done())) {
    for (let i = 0; i < 50; i++) await page.clock.fastForward(100);
    expect(Date.now() - startedAt, 'back at speed in time').toBeLessThan(240_000);
  }
  const log = await page.evaluate(() => window.__offScreenLog!);
  test.info().annotations.push({ type: 'off screen', description: JSON.stringify({ wallSeconds: (Date.now() - startedAt) / 1000, ...log }) });

  // The autopilot tests the live camera view: this screen's aspect and vertical field of view.
  expect(log.view).not.toBeNull();
  expect(log.view!.aspect).toBeCloseTo(log.camera.aspect, 9);
  expect(log.view!.halfFovY).toBeCloseTo((log.camera.fov * Math.PI) / 360, 9);
  expect(log.camera.aspect).toBeCloseTo(16 / 9, 6);
  // Off screen when it said so: the planet's centre is outside the view (or behind the camera).
  expect(log.offAt).not.toBeNull();
  const ndc = log.ndcAtOff!;
  expect(Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1).toBe(true);
  // The encounter ended within three capped frames, with the quick return to warp.
  expect(log.endedAt! - log.offAt!).toBeLessThanOrEqual(0.3 + 1e-6);
  expect(log.entryQuick).toBe(true);
  // Back at speed within the limits (docs/PLAN.md section 9, Phase 4), in simulated seconds.
  expect(log.halfAt! - log.offAt!).toBeLessThanOrEqual(2.5);
  expect(log.mostAt! - log.offAt!).toBeLessThanOrEqual(5);
  expect(errors).toEqual([]);
});
