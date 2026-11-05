import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { FAR_STAR_BASE_SIZE_PX, FAR_STAR_COUNT, STAR_BASE_SIZE_PX } from '../src/config';
import { SOAK_HEAP_GROWTH_LIMIT_BYTES } from './limits';

const APP_PATH = '/elsewhere/';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;

/** Soak: run this long in total, sampling the renderer every SOAK_SAMPLE_MS after the warm-up. */
const SOAK_WARMUP_MS = 5_000;
const SOAK_SAMPLE_MS = 5_000;
const SOAK_SAMPLES = 11;

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

interface SpeedViews {
  slow: Awaited<ReturnType<typeof canvasShot>>;
  fast: Awaited<ReturnType<typeof canvasShot>>;
  still: E2EHookSnapshot;
}

/**
 * Loads `query` with a paused fake clock, so no frame runs until the test steps time and the first
 * view is at speed 0, then steps 8 s of simulation in 0.1 s frames at the top speed level (one frame
 * per jump) and takes a second view.
 */
async function speedViews(page: Page, query: string): Promise<SpeedViews> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(`${APP_PATH}${query}`);
  await page.waitForFunction(() => window.__elsewhere !== undefined);

  const still = await snapshot(page);
  expect(still.ship.speed).toBe(0);
  const slow = await canvasShot(page);

  // setSpeed clamps, so 99 selects the top level.
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  for (let i = 0; i < 80; i++) await page.clock.fastForward(100);
  const moving = await snapshot(page);
  expect(moving.frames).toBeGreaterThan(still.frames);
  expect(moving.ship.speed).toBeGreaterThan(100);
  expect(moving.autopilot.state).toBe('CRUISE');
  const fast = await canvasShot(page);
  test.info().annotations.push({
    type: 'lit pixels (slow, fast, ratio)',
    description: JSON.stringify({ slow: slow.lit, fast: fast.lit, ratio: +(fast.lit / slow.lit).toFixed(3) }),
  });
  return { slow, fast, still };
}

test('streak length responds to speed', async ({ page }) => {
  const errors = collectErrors(page);
  // The near layer alone (an e2e-only override): the far stars are round dots at any speed.
  const { slow, fast, still } = await speedViews(page, '?starLayers=near');
  expect(still.starfield.visible).toBe(true);
  expect(still.farStars.visible).toBe(false);

  expect(fast.png.equals(slow.png)).toBe(false);
  // At speed 0 every star is a round dot; at speed the same stars become streaks covering far more pixels.
  expect(slow.lit).toBeGreaterThan(0);
  expect(fast.lit).toBeGreaterThan(slow.lit * 2);
  expect(errors).toEqual([]);
});

test('streak length responds to speed in the default view, with both star layers', async ({ page }) => {
  const errors = collectErrors(page);
  const { slow, fast, still } = await speedViews(page, '');
  expect(still.starfield.visible).toBe(true);
  expect(still.farStars.visible).toBe(true);

  // The still far stars add the same lit pixels to both views, which dilutes the near layer's
  // ratio, but the sky as seen must still read clearly faster at the top speed.
  expect(slow.lit).toBeGreaterThan(0);
  expect(fast.lit).toBeGreaterThan(slow.lit * 1.6);
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
    expect(snap.farStars.dpr).toBe(2);
    expect(snap.farStars.pixelSize).toBeCloseTo(FAR_STAR_BASE_SIZE_PX * 2, 6);
    expect(errors).toEqual([]);
  });
});

/** Hides everything but the canvas while a screenshot is taken (the controls overlay the view). */
const CANVAS_ONLY = 'body > :not(canvas) { display: none !important; }';

/** Lit pixels in `a` and in `b`, and pixels that differ between them (equally sized PNGs, decoded in the page). */
function comparePngs(page: Page, a: Buffer, b: Buffer): Promise<{ litA: number; litB: number; differing: number }> {
  return page.evaluate(
    async ({ a, b, threshold }) => {
      const decode = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [pa, pb] = await Promise.all([decode(a), decode(b)]);
      if (pa.length !== pb.length) throw new Error('screenshots differ in size');
      let litA = 0;
      let litB = 0;
      let differing = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.max(pa[i]!, pa[i + 1]!, pa[i + 2]!) > threshold) litA++;
        if (Math.max(pb[i]!, pb[i + 1]!, pb[i + 2]!) > threshold) litB++;
        if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) differing++;
      }
      return { litA, litB, differing };
    },
    { a: a.toString('base64'), b: b.toString('base64'), threshold: LIT_THRESHOLD },
  );
}

interface TranslationViews {
  /** Canvas screenshots at rest, after 8 s at the top speed, and 1 s later. */
  shots: [Buffer, Buffer, Buffer];
  snaps: [E2EHookSnapshot, E2EHookSnapshot, E2EHookSnapshot];
}

/**
 * Loads the app with only star layer `layer` drawn (an e2e-only URL override), the heading drift
 * off, so the ship only translates along -Z, and a paused fake clock, so each view is drawn at
 * exactly the step it is taken. Takes views at rest, after 8 s at the top speed and 1 s later.
 */
async function translationViews(page: Page, layer: 'far' | 'near'): Promise<TranslationViews> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(`${APP_PATH}?encounterInterval=1e9&headingDrift=0&starLayers=${layer}`);
  await page.waitForFunction(() => window.__elsewhere !== undefined);
  for (let i = 0; i < 2; i++) await page.clock.fastForward(100);
  const shot = () => page.locator('#scene').screenshot({ style: CANVAS_ONLY });
  const s0 = await snapshot(page);
  const atRest = await shot();
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  for (let i = 0; i < 80; i++) await page.clock.fastForward(100);
  const s1 = await snapshot(page);
  const cruise = await shot();
  for (let i = 0; i < 10; i++) await page.clock.fastForward(100);
  const s2 = await snapshot(page);
  const later = await shot();
  return { shots: [atRest, cruise, later], snaps: [s0, s1, s2] };
}

test('after the ship translates with no rotation, far-star pixels stay put while near stars move', async ({ page, browser }) => {
  const errors = collectErrors(page);
  const far = await translationViews(page, 'far');
  const nearPage = await browser.newPage();
  const nearErrors = collectErrors(nearPage);
  const near = await translationViews(nearPage, 'near');

  for (const [layer, views] of [
    ['far', far],
    ['near', near],
  ] as const) {
    const [s0, s1, s2] = views.snaps;
    expect(s0.starfield.visible, layer).toBe(layer === 'near');
    expect(s0.farStars.visible, layer).toBe(layer === 'far');
    // A pure translation: hundreds of units along -Z, with the heading exactly unchanged.
    expect(s1.ship.speed, layer).toBeGreaterThan(100);
    expect(s0.ship.position.z - s2.ship.position.z, layer).toBeGreaterThan(500);
    for (const s of views.snaps) expect(s.ship.heading, layer).toEqual({ x: 0, y: 0, z: -1 });
  }
  expect(far.snaps[0].farStars.count).toBe(FAR_STAR_COUNT);

  const farRestToCruise = await comparePngs(page, far.shots[0], far.shots[1]);
  const farCruiseToLater = await comparePngs(page, far.shots[1], far.shots[2]);
  const nearRestToCruise = await comparePngs(page, near.shots[0], near.shots[1]);
  const nearCruiseToLater = await comparePngs(page, near.shots[1], near.shots[2]);
  test.info().annotations.push({
    type: 'translation views',
    description: JSON.stringify({ farRestToCruise, farCruiseToLater, nearRestToCruise, nearCruiseToLater }),
  });
  // Both layers draw plenty of stars.
  expect(farRestToCruise.litA).toBeGreaterThan(200);
  expect(nearRestToCruise.litA).toBeGreaterThan(200);
  // The far stars are at infinity: not one pixel changes, at rest or at the top speed.
  expect(farRestToCruise.differing).toBe(0);
  expect(farCruiseToLater.differing).toBe(0);
  // The near stars streak with speed, and move between two views at the same speed.
  expect(nearRestToCruise.differing).toBeGreaterThan(1000);
  expect(nearCruiseToLater.differing).toBeGreaterThan(1000);
  await nearPage.close();
  expect(errors).toEqual([]);
  expect(nearErrors).toEqual([]);
});

test('soak: GPU resources stay constant and the JS heap does not grow', async ({ page }) => {
  test.setTimeout(SOAK_WARMUP_MS + SOAK_SAMPLE_MS * SOAK_SAMPLES + 60_000);
  const errors = collectErrors(page);
  // Starfield only: the e2e-only override pushes the first encounter far past the end of the run
  // (encounter.spec.ts checks the GPU resources planets use and free, and the JS heap across
  // encounters).
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
