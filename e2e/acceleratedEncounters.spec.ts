/**
 * Many encounters, accelerated (docs/PLAN.md sections 5 and 6 Performance): the real engine and
 * renderer, stepped by a fake clock so simulated time runs as fast as SwiftShader can draw the
 * frames, must leave the GPU resources at their baseline after every encounter.
 */
import { expect, test, type Page } from '@playwright/test';

const APP_PATH = '/elsewhere/';

// Thousands of clock steps would make a trace of thousands of actions, which takes minutes to write
// when the test ends (even when it passes, with 'retain-on-failure'), so this file records none.
test.use({ trace: 'off' });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Renderer resources and scene state the watcher records on each return to CRUISE. */
interface CruiseRecord {
  index: number;
  geometries: number;
  textures: number;
  programs: number;
  planets: number;
}

interface ResourceLog {
  baseline: { geometries: number; textures: number; programs: number };
  cruises: CruiseRecord[];
  /** Frames on which the compiled program count differed from the baseline. */
  programChanges: string[];
  kinds: string[];
}

declare global {
  interface Window {
    __resourceLog?: ResourceLog;
  }
}

test('ten encounters, accelerated with a fake clock, leave the GPU resources at their baseline every time', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  // A fake clock, stepped by hand: each 100 ms step runs exactly one engine frame of the capped
  // dt, however long SwiftShader takes to draw it, so simulated time runs as fast as the frames
  // can be drawn. A tiny viewport keeps those frames cheap; no pixels are checked.
  await page.setViewportSize({ width: 96, height: 54 });
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(`${APP_PATH}?encounterInterval=1`);
  await page.waitForFunction(() => window.__elsewhere !== undefined);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  // A few frames, so the starfield (and the warmed-up encounter programs) are in place.
  for (let i = 0; i < 5; i++) await page.clock.fastForward(100);

  await page.evaluate(() => {
    const hook = window.__elsewhere!;
    const s = hook.snapshot();
    const baseline = { geometries: s.renderer.geometries, textures: s.renderer.textures, programs: s.renderer.programs };
    const log: ResourceLog = { baseline, cruises: [], programChanges: [], kinds: [] };
    window.__resourceLog = log;
    let state = s.autopilot.state;
    let frames = s.frames;
    const tick = () => {
      requestAnimationFrame(tick);
      const now = hook.snapshot();
      if (now.frames === frames) return;
      frames = now.frames;
      const a = now.autopilot;
      if (now.renderer.programs !== baseline.programs) {
        log.programChanges.push(`frame ${now.frames} (${a.state}): ${now.renderer.programs} programs`);
      }
      if (a.state !== state) {
        if (a.state === 'APPROACH') log.kinds.push(a.kind ?? '?');
        if (a.state === 'CRUISE') {
          log.cruises.push({
            index: a.encounterCount - 1,
            geometries: now.renderer.geometries,
            textures: now.renderer.textures,
            programs: now.renderer.programs,
            planets: now.planets,
          });
        }
        state = a.state;
      }
    };
    requestAnimationFrame(tick);
  });

  const cruises = () => page.evaluate(() => window.__resourceLog!.cruises.length);
  const startedAt = Date.now();
  while ((await cruises()) < 10) {
    for (let i = 0; i < 50; i++) await page.clock.fastForward(100);
    expect(Date.now() - startedAt, 'ten encounters in time').toBeLessThan(540_000);
  }
  const log = await page.evaluate(() => window.__resourceLog!);
  test.info().annotations.push({
    type: 'accelerated encounters',
    description: JSON.stringify({ wallSeconds: (Date.now() - startedAt) / 1000, kinds: log.kinds, baseline: log.baseline }),
  });

  // Both kinds, the default seeded mix.
  expect(new Set(log.kinds)).toEqual(new Set(['planet', 'nebula']));
  // After every encounter the geometries, textures and programs are back at the pre-encounter
  // baseline, with no encounter object left in the scene.
  expect(log.baseline.geometries).toBeGreaterThan(0);
  for (const cruise of log.cruises) {
    expect(cruise, `after encounter ${cruise.index}`).toEqual({ index: cruise.index, ...log.baseline, planets: 0 });
  }
  // The encounter programs are compiled once at start-up and reused: no encounter compiles any.
  expect(log.programChanges).toEqual([]);
  expect(errors).toEqual([]);
});
