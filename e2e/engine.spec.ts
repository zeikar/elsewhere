import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { DT_CAP_SECONDS, SHIP_SPEED_LEVELS } from '../src/config';

const APP_PATH = '/elsewhere/';

/** Collects console errors and uncaught page errors from the moment it is called. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(APP_PATH);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

function canvasSize(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      left: rect.left,
      top: rect.top,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
}

test('loads at /elsewhere/ without errors, fills the viewport and travels on its own', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  const size = await canvasSize(page);
  expect(size.left).toBe(0);
  expect(size.top).toBe(0);
  expect(size.cssWidth).toBe(size.innerWidth);
  expect(size.cssHeight).toBe(size.innerHeight);

  const before = await snapshot(page);
  await page.waitForTimeout(1000);
  const after = await snapshot(page);

  expect(before.paused).toBe(false);
  expect(after.frames).toBeGreaterThan(before.frames);
  expect(after.renderer.frame).toBeGreaterThan(before.renderer.frame);
  expect(after.ship.time).toBeGreaterThan(before.ship.time);
  expect(after.ship.distance).toBeGreaterThan(before.ship.distance);
  expect(errors).toEqual([]);
});

test.describe('at deviceScaleFactor 2', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

  test('backs the canvas at 2× and follows viewport resizes', async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);

    const initial = await canvasSize(page);
    expect(initial.width).toBe(initial.innerWidth * 2);
    expect(initial.height).toBe(initial.innerHeight * 2);
    const snap = await snapshot(page);
    expect(snap.dpr).toBe(2);
    expect(snap.cameraAspect).toBeCloseTo(initial.innerWidth / initial.innerHeight, 6);

    await page.setViewportSize({ width: 800, height: 600 });
    await expect
      .poll(async () => {
        const s = await canvasSize(page);
        return [s.innerWidth, s.innerHeight, s.width, s.height];
      })
      .toEqual([800, 600, 1600, 1200]);
    await expect.poll(async () => (await snapshot(page)).cameraAspect).toBeCloseTo(800 / 600, 6);

    const resized = await canvasSize(page);
    expect(resized.cssWidth).toBe(800);
    expect(resized.cssHeight).toBe(600);
    expect(errors).toEqual([]);
  });
});

test('pause() stops the simulation and resume() restarts it without a jump', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);

  // Let the ship get under way.
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__elsewhere!.pause());
  const paused = await snapshot(page);
  expect(paused.paused).toBe(true);

  await page.waitForTimeout(1000);
  const stillPaused = await snapshot(page);
  expect(stillPaused.frames).toBe(paused.frames);
  expect(stillPaused.ship.time).toBe(paused.ship.time);
  expect(stillPaused.ship.distance).toBe(paused.ship.distance);
  expect(stillPaused.ship.position).toEqual(paused.ship.position);

  // Resume, then sample after the first two engine frames.
  const resumed = await page.evaluate(async () => {
    const hook = window.__elsewhere!;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    hook.resume();
    await nextFrame();
    await nextFrame();
    return hook.snapshot();
  });
  expect(resumed.paused).toBe(false);
  expect(resumed.frames).toBeGreaterThan(stillPaused.frames);

  // The 1 s pause must not turn into a step: across the resume, the ship moves no further than one
  // capped frame at the fastest speed, and simulation time advances by at most one capped frame.
  const maxSpeed = Math.max(...SHIP_SPEED_LEVELS);
  const jump = Math.hypot(
    resumed.ship.position.x - stillPaused.ship.position.x,
    resumed.ship.position.y - stillPaused.ship.position.y,
    resumed.ship.position.z - stillPaused.ship.position.z,
  );
  expect(jump).toBeLessThanOrEqual(maxSpeed * DT_CAP_SECONDS);
  expect(resumed.ship.time - stillPaused.ship.time).toBeLessThanOrEqual(DT_CAP_SECONDS + 1e-9);

  // And it keeps travelling afterwards.
  await page.waitForTimeout(500);
  const later = await snapshot(page);
  expect(later.frames).toBeGreaterThan(resumed.frames);
  expect(later.ship.distance).toBeGreaterThan(resumed.ship.distance);
  expect(errors).toEqual([]);
});
