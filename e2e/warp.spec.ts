/**
 * Dropping out of warp at the top speed level (docs/PLAN.md section 1), on the real path: no
 * `?arrivalSpeed=` override, so the engine flies the encounter from ENCOUNTER_ARRIVAL_SPEED. A fake
 * clock steps the real engine one capped frame at a time, so simulated time runs as fast as
 * SwiftShader can draw the frames. The drop out of warp at the end of the first cruise and the
 * return to warp at the start of the next are both checked here; their shape and bounds at every
 * level are checked in src/engine/Autopilot.test.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_WARP_ENTRY_SECONDS,
  ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  ENCOUNTER_WARP_EXIT_SECONDS,
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
  /** Ship speed on the first frame the encounter object's opacity reaches 0.1, or `null` until then. */
  speedAtVisible: number | null;
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

test('at the top speed the ship drops out of warp before a planet encounter and returns to warp after it', async ({ page }) => {
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
    const log: WarpLog = { firstCruiseMax: 0, speedAtVisible: null, endedAt: null, backInWarpAt: null, afterMax: 0, kinds: [] };
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
      if (log.speedAtVisible === null && a.encounterCount === 1 && a.fade >= 0.1) log.speedAtVisible = speed;
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
  // In warp during the first cruise, out of it by the time the planet is noticeably visible (the ship
  // lags its target by under 0.5 units per second there), and back in warp after the encounter.
  expect(log.firstCruiseMax).toBeGreaterThan(0.95 * TOP_SPEED);
  expect(log.speedAtVisible).not.toBeNull();
  expect(log.speedAtVisible!).toBeLessThanOrEqual(ENCOUNTER_ARRIVAL_SPEED + 0.5);
  expect(log.endedAt).not.toBeNull();
  expect(log.afterMax).toBeGreaterThan(0.95 * TOP_SPEED);
  expect(log.afterMax).toBeLessThanOrEqual(TOP_SPEED + 1e-6);
  expect(errors).toEqual([]);
});
