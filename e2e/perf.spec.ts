/**
 * Performance instrumentation and long-run stability checks that fit in the regular e2e run
 * (docs/PLAN.md sections 5, 6 Performance and 10). The long soak is e2e/soak/soak.spec.ts
 * (`npm run soak`).
 */
import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { installFrameSampler, takeFrameWindow } from './frameSampler';
import { appUrl } from './app';


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
