import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { FAR_STAR_BASE_SIZE_PX, FAR_STAR_COUNT, SHIP_DEFAULT_SPEED_LEVEL, SHIP_SPEED_LEVELS, STAR_BASE_SIZE_PX } from '../src/config';
import { SOAK_HEAP_GROWTH_LIMIT_BYTES } from './limits';
import { appUrl } from './app';

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
  await page.goto(appUrl());
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

/**
 * Screenshots the canvas and counts lit pixels, decoding the PNG in the page (no extra deps). The
 * controls are hidden for the shot: they are shown for the first UI_HIDE_DELAY_MS after load and
 * would otherwise count as lit pixels in a view taken at rest.
 */
async function canvasShot(page: Page): Promise<{ png: Buffer; lit: number; total: number }> {
  const png = await page.locator('canvas').screenshot({ style: CANVAS_ONLY });
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
  /** At rest (speed 0). */
  slow: Awaited<ReturnType<typeof canvasShot>>;
  /** At the default speed level's cruise speed. */
  cruise: Awaited<ReturnType<typeof canvasShot>>;
  /** At the top speed level's cruise speed. */
  fast: Awaited<ReturnType<typeof canvasShot>>;
  still: E2EHookSnapshot;
}

/**
 * Loads `query` with a paused fake clock, so no frame runs until the test steps time and the first
 * view is at speed 0. Then steps 8 s of simulation in 0.1 s frames (one frame per jump) at the
 * default speed level, which travel starts at, and takes a second view, then 8 s more at the top
 * speed level and takes a third.
 */
async function speedViews(page: Page, query: string): Promise<SpeedViews> {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(appUrl(query));
  await page.waitForFunction(() => window.__elsewhere !== undefined);

  const still = await snapshot(page);
  expect(still.ship.speed).toBe(0);
  const slow = await canvasShot(page);

  for (let i = 0; i < 80; i++) await page.clock.fastForward(100);
  const cruising = await snapshot(page);
  expect(cruising.frames).toBeGreaterThan(still.frames);
  expect(cruising.speed).toBe(SHIP_DEFAULT_SPEED_LEVEL);
  expect(cruising.ship.speed).toBeGreaterThan(0.9 * SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL]);
  expect(cruising.ship.speed).toBeLessThan(SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL] + 1);
  const cruise = await canvasShot(page);

  // setSpeed clamps, so 99 selects the top level.
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  for (let i = 0; i < 80; i++) await page.clock.fastForward(100);
  const moving = await snapshot(page);
  expect(moving.frames).toBeGreaterThan(cruising.frames);
  expect(moving.ship.speed).toBeGreaterThan(0.9 * SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
  expect(moving.autopilot.state).toBe('CRUISE');
  const fast = await canvasShot(page);
  test.info().annotations.push({
    type: 'lit pixels (rest, default level, top level; streak excess over rest; ratios)',
    description: JSON.stringify({
      slow: slow.lit,
      cruise: cruise.lit,
      fast: fast.lit,
      cruiseExcess: cruise.lit - slow.lit,
      fastExcess: fast.lit - slow.lit,
      fastOverSlow: +(fast.lit / slow.lit).toFixed(3),
      fastOverCruise: +(fast.lit / cruise.lit).toFixed(3),
      excessRatio: +((fast.lit - slow.lit) / (cruise.lit - slow.lit)).toFixed(3),
    }),
  });
  return { slow, cruise, fast, still };
}

/**
 * The speed cue, as lit pixels (brightest channel above LIT_THRESHOLD) in views at rest (`slow`),
 * at the default level (`cruise`) and at the top level (`fast`). The model behind the bounds:
 *
 *   lit(v) = S + E(v)
 *
 * S is what is lit at rest (the far stars and the near stars' still dots), and E(v), the streak
 * excess, is what the near streaks add at speed v. A streak's length is v × the streak time, so E
 * grows in proportion to the speed, whatever the dust's brightness: the brightness decides which
 * streaks clear the threshold, and the length how many pixels each of them lights. Two numbers
 * describe the cue:
 *
 * - k = E(top) / E(default): how much the streaks grow from the default level to the top level.
 *   Ideally the speed ratio, 150 / 60 = 2.5; the length cap (STAR_MAX_STREAK_PX) and the fades
 *   near the camera take a little off. Measured 2.37 in the default view, and 2.44 on main before
 *   the dust was dimmed, so k does not depend on the brightness. Bound: 1.75, halfway from no
 *   growth (1) to the ideal 2.5.
 * - e = E(default) / S: how much the default level's streaks add to the sky seen at rest. This is
 *   what dimming the dust lowers: measured 0.66 in the default view (1.25 on main). Bound: 0.4, so
 *   that even at the default level the streaks add 40% to the lit sky.
 *
 * Together they bound the ratios between the views (both increase with k and with e):
 * lit(top) / lit(rest) = 1 + k·e ≥ 1.7, and lit(top) / lit(default) = (1 + k·e) / (1 + e) ≥ 1.21.
 * Measured 2.56 and 1.54.
 *
 * The previous guard was lit(top) > 1.6 × lit(rest) alone, measured 2.61 at the time. It took the
 * view at rest with the controls still on screen (they hide after UI_HIDE_DELAY_MS), which added
 * about 1,600 lit pixels to S and so understated the ratio: with the controls hidden (canvasShot
 * now hides them), main measures 4.06. It never looked at the default level either.
 *
 * What this guard accepts on purpose: #46 asks for dust dimmer than PR #40's first attempt (near
 * brightness 0.3–0.8), the one that was reverted because the speed cue felt weak. That attempt
 * scores k 2.66, e 0.72 and top/default 1.70 here, better than this design on every number, so this
 * guard cannot reject that level of dimming. The cue at the default level is now about half of
 * main's (e 1.25 → 0.66, top/default 1.80 → 1.54), a trade-off the owner asked for. The guard still
 * catches dimming beyond this design: it passes at 0.7× the current dust brightness and fails at
 * 0.5× (e 0.23), so it trips at roughly 0.7×.
 */
const SPEED_CUE = { kMin: 1.75, eMin: 0.4 } as const;

function speedCue(views: SpeedViews): { k: number; e: number } {
  const { slow, cruise, fast } = views;
  return { k: (fast.lit - slow.lit) / (cruise.lit - slow.lit), e: (cruise.lit - slow.lit) / slow.lit };
}

test('streak length responds to speed', async ({ page }) => {
  const errors = collectErrors(page);
  // The near layer alone (an e2e-only override): the far stars are round dots at any speed.
  const views = await speedViews(page, '?starLayers=near');
  const { slow, cruise, fast, still } = views;
  expect(still.starfield.visible).toBe(true);
  expect(still.farStars.visible).toBe(false);

  expect(fast.png.equals(slow.png)).toBe(false);
  // At speed 0 every star is a round dot; at speed the same stars become streaks covering far more
  // pixels (measured 5.2× at the default level and 10.6× at the top level), and the streaks grow
  // with the speed (k measured 2.26).
  expect(slow.lit).toBeGreaterThan(0);
  expect(cruise.lit).toBeGreaterThan(slow.lit * 2);
  expect(fast.lit).toBeGreaterThan(slow.lit * 2);
  expect(speedCue(views).k).toBeGreaterThan(SPEED_CUE.kMin);
  expect(errors).toEqual([]);
});

test('streak length responds to speed in the default view, with both star layers', async ({ page }) => {
  const errors = collectErrors(page);
  const views = await speedViews(page, '');
  const { slow, cruise, fast, still } = views;
  expect(still.starfield.visible).toBe(true);
  expect(still.farStars.visible).toBe(true);

  // The still far stars add the same lit pixels to every view, which dilutes the near layer's
  // ratios, but the sky as seen must still read clearly faster at the default level than at rest,
  // and at the top level than at the default level (SPEED_CUE).
  expect(slow.lit).toBeGreaterThan(0);
  const { k, e } = speedCue(views);
  expect(k).toBeGreaterThan(SPEED_CUE.kMin);
  expect(e).toBeGreaterThan(SPEED_CUE.eMin);
  // Implied by the two above; spelled out as the ratios between the views.
  expect(fast.lit).toBeGreaterThan(slow.lit * (1 + SPEED_CUE.kMin * SPEED_CUE.eMin));
  expect(fast.lit).toBeGreaterThan(cruise.lit * ((1 + SPEED_CUE.kMin * SPEED_CUE.eMin) / (1 + SPEED_CUE.eMin)));
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

/**
 * Lit pixels within `radius` CSS pixels of `centre` (CSS pixels from the canvas's top-left corner)
 * in a canvas screenshot, decoded in the page.
 */
function litWithin(page: Page, png: Buffer, centre: { x: number; y: number }, radius: number): Promise<number> {
  return page.evaluate(
    async ({ b64, centre, radius, threshold }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const scale = bitmap.width / window.innerWidth;
      let lit = 0;
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          if (Math.hypot((x + 0.5) / scale - centre.x, (y + 0.5) / scale - centre.y) > radius) continue;
          const i = (y * bitmap.width + x) * 4;
          if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > threshold) lit++;
        }
      }
      return lit;
    },
    { b64: png.toString('base64'), centre, radius, threshold: LIT_THRESHOLD },
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
  await page.goto(appUrl(`encounterInterval=1e9&headingDrift=0&starLayers=${layer}`));
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
  // The test default trip's galaxies belong to the far layer, and its spiral is in this view, so the
  // pixel comparisons below cover a galaxy too (distant galaxies, docs/PLAN.md section 9, Phase 4).
  expect(far.snaps[0].galaxies.visible).toBe(true);
  expect(near.snaps[0].galaxies.visible).toBe(false);
  const spiral = far.snaps[0].galaxies.items[0]!;
  expect(spiral.type).toBe('spiral');
  expect(spiral.ndc.z).toBeLessThan(1);
  expect(Math.abs(spiral.ndc.x)).toBeLessThan(0.9);
  expect(Math.abs(spiral.ndc.y)).toBeLessThan(0.9);
  const viewport = page.viewportSize()!;
  const spiralCentre = { x: ((spiral.ndc.x + 1) / 2) * viewport.width, y: ((1 - spiral.ndc.y) / 2) * viewport.height };
  // Its quad's half-height (vertical field of view in the camera's projection, as the engine applies it).
  const focal = viewport.height / 2 / Math.tan((far.snaps[0].cameraFovDeg / 2) * (Math.PI / 180));
  const spiralRadius = Math.tan(((spiral.sizeDeg / 2) * Math.PI) / 180) * focal;
  const spiralLit = await litWithin(page, far.shots[0], spiralCentre, spiralRadius);
  // Far more lit pixels than the far stars alone would give such a small patch of sky (about 2 at
  // their density; measured 54 with the spiral).
  expect(spiralLit).toBeGreaterThan(25);

  const farRestToCruise = await comparePngs(page, far.shots[0], far.shots[1]);
  const farCruiseToLater = await comparePngs(page, far.shots[1], far.shots[2]);
  const nearRestToCruise = await comparePngs(page, near.shots[0], near.shots[1]);
  const nearCruiseToLater = await comparePngs(page, near.shots[1], near.shots[2]);
  test.info().annotations.push({
    type: 'translation views',
    description: JSON.stringify({ farRestToCruise, farCruiseToLater, nearRestToCruise, nearCruiseToLater, spiralLit, spiralRadius }),
  });
  // Both layers draw plenty of stars.
  expect(farRestToCruise.litA).toBeGreaterThan(200);
  expect(nearRestToCruise.litA).toBeGreaterThan(200);
  // The far stars and the galaxy are at infinity: not one pixel changes, at rest or at the top speed.
  expect(farRestToCruise.differing).toBe(0);
  expect(farCruiseToLater.differing).toBe(0);
  // The near stars streak with speed, and move between two views at the same speed.
  expect(nearRestToCruise.differing).toBeGreaterThan(1000);
  expect(nearCruiseToLater.differing).toBeGreaterThan(1000);
  await nearPage.close();
  expect(errors).toEqual([]);
  expect(nearErrors).toEqual([]);
});

/** Lit pixels in a PNG, their mean brightest channel (0–255), and pixels above 128 (decoded in the page). */
function brightnessStats(page: Page, png: Buffer): Promise<{ lit: number; meanLit: number; bright: number }> {
  return page.evaluate(
    async ({ b64, threshold }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let lit = 0;
      let sum = 0;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        const value = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
        if (value > threshold) {
          lit++;
          sum += value;
        }
        if (value > 128) bright++;
      }
      return { lit, meanLit: lit === 0 ? 0 : sum / lit, bright };
    },
    { b64: png.toString('base64'), threshold: LIT_THRESHOLD },
  );
}

test('the near dust is drawn dimmer than the far stars, at rest and at the top speed', async ({ page, browser }) => {
  const errors = collectErrors(page);
  const far = await translationViews(page, 'far');
  const nearPage = await browser.newPage();
  const nearErrors = collectErrors(nearPage);
  const near = await translationViews(nearPage, 'near');
  expect(near.snaps[1].ship.speed).toBeGreaterThan(100);

  const stats = {
    farRest: await brightnessStats(page, far.shots[0]),
    farCruise: await brightnessStats(page, far.shots[1]),
    nearRest: await brightnessStats(page, near.shots[0]),
    nearCruise: await brightnessStats(page, near.shots[1]),
  };
  test.info().annotations.push({ type: 'brightness per layer', description: JSON.stringify(stats) });
  for (const s of Object.values(stats)) expect(s.lit).toBeGreaterThan(200);
  // A lit dust pixel is on average well under the far stars' (measured 0.43 of it at rest and at
  // the top speed; 0.71 and 0.79 before the dust was dimmed).
  expect(stats.nearRest.meanLit).toBeLessThan(0.6 * stats.farRest.meanLit);
  expect(stats.nearCruise.meanLit).toBeLessThan(0.6 * stats.farCruise.meanLit);
  // The brightest points in the sky are far stars, even with the dust streaking at the top speed
  // (measured 0 dust pixels above 128 against 201 far ones; 215 against 122 before).
  expect(stats.farCruise.bright).toBeGreaterThan(50);
  expect(stats.nearCruise.bright).toBeLessThan(0.25 * stats.farCruise.bright);
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
  await page.goto(appUrl(`encounterInterval=1e9`));
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
