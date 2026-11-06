import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { CAMERA_FOV_DEG, DT_CAP_SECONDS, VIEW_WIDEST_ASPECT } from '../src/config';
import { appUrl } from './app';

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
  await page.goto(appUrl());
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

/**
 * How long the resize polls below wait. Under headless SwiftShader the page's renderer stops dead
 * for several seconds once, about a second after the page loads (issue #61): Chromium tears down the
 * previous document's compositor then and waits on its main thread for the GPU process to finish
 * everything queued, and SwiftShader is seconds behind the frames already sent. No task, timer,
 * `requestAnimationFrame`, `resize` event or `page.evaluate` runs meanwhile. That took 3.5–4 s on
 * an idle machine and up to about 6 s under CPU load, so a poll that met it timed out at the default
 * 5 s. The resize is not lost: it is handled as soon as the renderer runs again. A lost resize, or
 * one handled with a stale size, still fails these polls; they just wait out the stall.
 */
const RESIZE_POLL = { timeout: 20_000 };

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
    expect(snap.cameraFov).toBe(CAMERA_FOV_DEG);

    await page.setViewportSize({ width: 800, height: 600 });
    await expect
      .poll(async () => {
        const s = await canvasSize(page);
        return [s.innerWidth, s.innerHeight, s.width, s.height];
      }, RESIZE_POLL)
      .toEqual([800, 600, 1600, 1200]);
    await expect.poll(async () => (await snapshot(page)).cameraAspect, RESIZE_POLL).toBeCloseTo(800 / 600, 6);

    const resized = await canvasSize(page);
    expect(resized.cssWidth).toBe(800);
    expect(resized.cssHeight).toBe(600);
    expect((await snapshot(page)).cameraFov).toBe(CAMERA_FOV_DEG);

    // 32:9, wider than the widest supported 21:9: the vertical field of view narrows so the
    // horizontal one stays at the 21:9 one (config.ts, VIEW_WIDEST_ASPECT).
    await page.setViewportSize({ width: 1280, height: 360 });
    await expect.poll(async () => (await snapshot(page)).cameraAspect, RESIZE_POLL).toBeCloseTo(32 / 9, 6);
    const wide = await snapshot(page);
    const tanHalf = (deg: number): number => Math.tan((deg * Math.PI) / 360);
    expect(wide.cameraFov).toBeLessThan(CAMERA_FOV_DEG);
    expect(tanHalf(wide.cameraFov) * wide.cameraAspect).toBeCloseTo(tanHalf(CAMERA_FOV_DEG) * VIEW_WIDEST_ASPECT, 6);
    // The autopilot tests encounter objects against this same, live view.
    expect(wide.autopilot.view!.aspect).toBeCloseTo(wide.cameraAspect, 9);
    expect(wide.autopilot.view!.halfFovY).toBeCloseTo((wide.cameraFov * Math.PI) / 360, 9);
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
  // capped frame at its current speed, and simulation time advances by at most one capped frame.
  // Speed eases monotonically within a frame, so the larger end-point speed bounds the step.
  const speed = Math.max(stillPaused.ship.speed, resumed.ship.speed);
  const jump = Math.hypot(
    resumed.ship.position.x - stillPaused.ship.position.x,
    resumed.ship.position.y - stillPaused.ship.position.y,
    resumed.ship.position.z - stillPaused.ship.position.z,
  );
  expect(jump).toBeLessThanOrEqual(speed * DT_CAP_SECONDS + 1e-6);
  expect(resumed.ship.time - stillPaused.ship.time).toBeLessThanOrEqual(DT_CAP_SECONDS + 1e-9);

  // And it keeps travelling afterwards.
  await page.waitForTimeout(500);
  const later = await snapshot(page);
  expect(later.frames).toBeGreaterThan(resumed.frames);
  expect(later.ship.distance).toBeGreaterThan(resumed.ship.distance);
  expect(errors).toEqual([]);
});

test('a hidden tab stops the clock and returning to it does not jump', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  // Let the ship get under way.
  await page.waitForTimeout(500);

  // Headless pages never really go hidden, so stub visibilityState and dispatch the events.
  const hidden = await page.evaluate(() => {
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    (window as unknown as { __setVisibility: (s: DocumentVisibilityState) => void }).__setVisibility = (s) => {
      state = s;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
    return window.__elsewhere!.snapshot();
  });

  // requestAnimationFrame keeps running in the stubbed-hidden page, but no simulation time passes.
  await page.waitForTimeout(1000);
  const stillHidden = await snapshot(page);
  expect(stillHidden.frames).toBeGreaterThan(hidden.frames);
  expect(stillHidden.ship.time).toBe(hidden.ship.time);

  // Back to visible, then sample after the first two engine frames.
  const visible = await page.evaluate(async () => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    (window as unknown as { __setVisibility: (s: DocumentVisibilityState) => void }).__setVisibility('visible');
    await nextFrame();
    await nextFrame();
    return window.__elsewhere!.snapshot();
  });
  expect(visible.frames).toBeGreaterThan(stillHidden.frames);
  // The 1 s hidden period must not become a step: at most one capped frame of simulation time.
  expect(visible.ship.time - hidden.ship.time).toBeLessThanOrEqual(DT_CAP_SECONDS + 1e-9);

  // And it keeps travelling afterwards.
  await page.waitForTimeout(500);
  const later = await snapshot(page);
  expect(later.ship.time).toBeGreaterThan(visible.ship.time);
  expect(later.ship.distance).toBeGreaterThan(visible.ship.distance);
  expect(errors).toEqual([]);
});
