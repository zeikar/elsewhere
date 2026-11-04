import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { STAR_BASE_SIZE_PX } from '../src/config';

const APP_PATH = '/elsewhere/';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;

/** Soak: run this long in total, sampling the renderer every SOAK_SAMPLE_MS after the warm-up. */
const SOAK_WARMUP_MS = 5_000;
const SOAK_SAMPLE_MS = 5_000;
const SOAK_SAMPLES = 11;
/** Largest allowed JS heap growth (after a forced GC) between warm-up and the end of the soak. */
const SOAK_HEAP_GROWTH_LIMIT_BYTES = 4 * 1024 * 1024;

// SwiftShader renders at only a few fps, so the tests here routinely take 15+ s; leave headroom
// over Playwright's 30 s default. (The soak test sets its own, longer timeout.)
test.describe.configure({ timeout: 60_000 });

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

/** Screenshots the canvas and counts lit pixels, decoding the PNG in the page (no extra deps). */
async function canvasShot(page: Page): Promise<{ png: Buffer; lit: number; total: number }> {
  const png = await page.locator('canvas').screenshot();
  const counts = await page.evaluate(
    async ({ b64, threshold }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > threshold) lit++;
      }
      return { lit, total: bitmap.width * bitmap.height };
    },
    { b64: png.toString('base64'), threshold: LIT_THRESHOLD },
  );
  return { png, ...counts };
}

test('draws stars after 1 s, with no console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await page.waitForTimeout(1000);

  const shot = await canvasShot(page);
  const fraction = shot.lit / shot.total;
  // Small, crisp points on black: clearly something drawn, but nowhere near a filled screen.
  expect(fraction).toBeGreaterThanOrEqual(0.001);
  expect(fraction).toBeLessThan(0.25);

  const snap = await snapshot(page);
  expect(snap.renderer.calls).toBeGreaterThan(0);
  expect(snap.renderer.programs).toBeGreaterThan(0);
  // Shader compile errors are logged by Three.js through console.error.
  expect(errors).toEqual([]);
});

test('streak length responds to speed', async ({ page }) => {
  const errors = collectErrors(page);
  // A paused fake clock: no frame runs until the test steps time, so the first view is at speed 0.
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(APP_PATH);
  await page.waitForFunction(() => window.__elsewhere !== undefined);

  const still = await snapshot(page);
  expect(still.ship.speed).toBe(0);
  const slow = await canvasShot(page);

  // Step 8 s of simulation in 0.1 s frames at the top speed level (one frame per jump).
  // setSpeed clamps, so 99 selects the top level.
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  for (let i = 0; i < 80; i++) await page.clock.fastForward(100);
  const moving = await snapshot(page);
  expect(moving.frames).toBeGreaterThan(still.frames);
  expect(moving.ship.speed).toBeGreaterThan(100);
  const fast = await canvasShot(page);

  expect(fast.png.equals(slow.png)).toBe(false);
  // At speed 0 every star is a round dot; at speed the same stars become streaks covering far more pixels.
  expect(slow.lit).toBeGreaterThan(0);
  expect(fast.lit).toBeGreaterThan(slow.lit * 2);
  expect(errors).toEqual([]);
});

test.describe('at deviceScaleFactor 2', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

  test('multiplies star pixel sizes by the applied DPR', async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    const snap = await snapshot(page);
    expect(snap.dpr).toBe(2);
    expect(snap.starfield.dpr).toBe(2);
    expect(snap.starfield.pixelSize).toBeCloseTo(STAR_BASE_SIZE_PX * 2, 6);
    expect(errors).toEqual([]);
  });
});

test('soak: GPU resources stay constant and the JS heap does not grow', async ({ page }) => {
  test.setTimeout(SOAK_WARMUP_MS + SOAK_SAMPLE_MS * SOAK_SAMPLES + 60_000);
  const errors = collectErrors(page);
  // Starfield only: the e2e-only override pushes the first encounter far past the end of the run
  // (encounter.spec.ts checks the resources planets use and free).
  await page.goto(`${APP_PATH}?encounterInterval=1e9`);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  expect((await snapshot(page)).autopilot.interval).toBe(1e9);
  // Top speed (setSpeed clamps), so stars wrap around the cube many times during the run.
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));

  /** Used JS heap after a full GC, or null without --js-flags=--expose-gc / performance.memory. */
  const heapAfterGc = () =>
    page.evaluate(() => {
      const w = window as unknown as { gc?: () => void };
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (typeof w.gc !== 'function' || !memory) return null;
      w.gc();
      w.gc();
      return memory.usedJSHeapSize;
    });

  await page.waitForTimeout(SOAK_WARMUP_MS);
  const baseline = await snapshot(page);
  const heapStart = await heapAfterGc();
  const resources = (s: E2EHookSnapshot) => ({
    geometries: s.renderer.geometries,
    textures: s.renderer.textures,
    programs: s.renderer.programs,
  });
  expect(baseline.renderer.geometries).toBeGreaterThan(0);
  expect(baseline.renderer.programs).toBeGreaterThan(0);

  let last = baseline;
  for (let i = 0; i < SOAK_SAMPLES; i++) {
    await page.waitForTimeout(SOAK_SAMPLE_MS);
    const s = await snapshot(page);
    expect(resources(s), `sample ${i + 1}`).toEqual(resources(baseline));
    expect(s.frames).toBeGreaterThan(last.frames);
    last = s;
  }

  const heapEnd = await heapAfterGc();
  if (heapStart !== null && heapEnd !== null) {
    const growth = heapEnd - heapStart;
    test.info().annotations.push({ type: 'heap growth (bytes)', description: String(growth) });
    expect(growth).toBeLessThan(SOAK_HEAP_GROWTH_LIMIT_BYTES);
  } else {
    test.info().annotations.push({ type: 'heap growth', description: 'skipped: gc() or performance.memory unavailable' });
  }
  expect(last.ship.distance).toBeGreaterThan(baseline.ship.distance);
  expect(errors).toEqual([]);
});
