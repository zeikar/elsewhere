import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { NEBULA_NEAR_FADE_MIN_DISTANCE } from '../src/config';

const APP_PATH = '/elsewhere/';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 24;

// A forced nebula encounter at the top speed is about 45 s of simulated travel; SwiftShader renders
// slowly, and below 10 fps the dt cap slows simulated time further.
test.describe.configure({ timeout: 420_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

interface Resources {
  geometries: number;
  textures: number;
  programs: number;
}

/** What the in-page watcher records, sampling the hook once per animation frame. */
interface NebulaLog {
  states: { state: string; index: number | null; kind: string | null }[];
  baseline: Resources;
  /** Renderer resources and encounter-object count on each return to CRUISE. */
  afterEncounters: (Resources & { planets: number })[];
  /** Frames where the scene's object count does not match the state, or a planet appeared. */
  countErrors: string[];
  /** Frames where a layer within the minimum distance of its plane was drawn or not fully faded. */
  nearErrors: string[];
  /** Smallest camera-to-plane distance seen for any layer. */
  minPlaneDistance: number;
  /** Encounter opacity in the first frame the nebula is drawn. */
  firstOpacity: number | null;
  /** Snapshots taken where the watcher paused the engine (stars only; mid-APPROACH), or null. */
  starsAt: E2EHookSnapshot | null;
  nebulaAt: E2EHookSnapshot | null;
}

declare global {
  interface Window {
    __nebulaLog?: NebulaLog;
  }
}

/**
 * Installs the watcher. It pauses the engine twice for screenshots: in the first CRUISE before any
 * encounter (stars only), and mid-APPROACH once the nebula is fully faded in and near.
 */
function watch(page: Page): Promise<void> {
  return page.evaluate((nearMin) => {
    const hook = window.__elsewhere!;
    let prev = hook.snapshot();
    const resources = (s: typeof prev) => ({
      geometries: s.renderer.geometries,
      textures: s.renderer.textures,
      programs: s.renderer.programs,
    });
    const log: NebulaLog = {
      states: [{ state: prev.autopilot.state, index: prev.autopilot.encounterIndex, kind: prev.autopilot.kind }],
      baseline: resources(prev),
      afterEncounters: [],
      countErrors: [],
      nearErrors: [],
      minPlaneDistance: Number.POSITIVE_INFINITY,
      firstOpacity: null,
      starsAt: null,
      nebulaAt: null,
    };
    window.__nebulaLog = log;
    const tick = () => {
      requestAnimationFrame(tick);
      const s = hook.snapshot();
      if (s.frames === prev.frames) return;
      const a = s.autopilot;
      if (a.state !== log.states.at(-1)!.state) {
        log.states.push({ state: a.state, index: a.encounterIndex, kind: a.kind });
        if (a.state === 'CRUISE') log.afterEncounters.push({ ...resources(s), planets: s.planets });
      }
      const expected = a.encounterIndex === null ? 0 : 1;
      if (s.planets !== expected || s.planet !== null || (expected === 1) !== (s.nebula !== null)) {
        log.countErrors.push(`frame ${s.frames}: ${a.state}, ${s.planets} objects, nebula ${s.nebula !== null}`);
      }
      if (s.nebula !== null) {
        for (const [i, layer] of s.nebula.layers.entries()) {
          log.minPlaneDistance = Math.min(log.minPlaneDistance, layer.planeDistance);
          if (layer.planeDistance < nearMin && (layer.visible || layer.fade !== 0)) {
            log.nearErrors.push(`frame ${s.frames}: layer ${i} at ${layer.planeDistance} with fade ${layer.fade}`);
          }
        }
        if (log.firstOpacity === null && s.nebula.visible) log.firstOpacity = s.nebula.opacity;
      }
      if (log.starsAt === null && a.state === 'CRUISE' && a.encounterCount === 0 && s.frames >= 3) {
        hook.pause();
        log.starsAt = hook.snapshot();
      } else if (
        log.nebulaAt === null &&
        a.state === 'APPROACH' &&
        a.fade >= 0.9 &&
        a.remaining !== null &&
        a.remaining <= 1200 &&
        s.nebula?.visible
      ) {
        hook.pause();
        log.nebulaAt = hook.snapshot();
      }
      prev = s;
    };
    requestAnimationFrame(tick);
  }, NEBULA_NEAR_FADE_MIN_DISTANCE);
}

function nebulaLog(page: Page): Promise<NebulaLog> {
  return page.evaluate(() => window.__nebulaLog!);
}

/** Screenshots the engine canvas; returns the PNG and its RGBA pixels (decoded in the page). */
async function engineShot(page: Page): Promise<{ png: Buffer; pixels: number[]; width: number; height: number }> {
  const png = await page.locator('#scene').screenshot();
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { pixels: Array.from(data), width: bitmap.width, height: bitmap.height };
  }, png.toString('base64'));
  return { png, ...decoded };
}

/** Lit-pixel share, mean brightness (0–255) and share of lit, clearly coloured pixels. */
function imageStats(pixels: readonly number[]): { lit: number; mean: number; coloured: number } {
  let lit = 0;
  let coloured = 0;
  let sum = 0;
  const n = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const max = Math.max(r, g, b);
    sum += (r + g + b) / 3;
    if (max > LIT_THRESHOLD) {
      lit++;
      if (max - Math.min(r, g, b) > 0.35 * max) coloured++;
    }
  }
  return { lit: lit / n, mean: sum / n, coloured: coloured / n };
}

/** Share of pixels whose brightest channel differs by more than 24 between the two images. */
function differingShare(a: readonly number[], b: readonly number[]): number {
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
    if (d > 24) differing++;
  }
  return differing / (a.length / 4);
}

test('a forced nebula encounter draws a coloured nebula over the stars, runs the full cycle and frees its GPU resources', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // Pixels are checked, but SwiftShader is fill-rate bound: a small viewport keeps the encounter short.
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto(`${APP_PATH}?encounterInterval=1&encounterKind=nebula`);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  await watch(page);

  // Stars only: the watcher pauses in the first CRUISE.
  await expect.poll(async () => (await nebulaLog(page)).starsAt !== null, { timeout: 60_000 }).toBe(true);
  const starsAt = (await nebulaLog(page)).starsAt!;
  expect(starsAt.paused).toBe(true);
  expect(starsAt.planets).toBe(0);
  const stars = await engineShot(page);
  writeFileSync(test.info().outputPath('stars-only.png'), stars.png);
  await test.info().attach('engine canvas, stars only', { body: stars.png, contentType: 'image/png' });
  await page.evaluate(() => window.__elsewhere!.resume());

  // Mid-APPROACH, the nebula fully faded in and near.
  await expect
    .poll(async () => (await nebulaLog(page)).nebulaAt !== null, { timeout: 240_000, intervals: [1_000] })
    .toBe(true);
  const nebulaAt = (await nebulaLog(page)).nebulaAt!;
  expect(nebulaAt.paused).toBe(true);
  expect(nebulaAt.autopilot.kind).toBe('nebula');
  expect(nebulaAt.planets).toBe(1);
  expect(nebulaAt.planet).toBeNull();
  const nebula = nebulaAt.nebula!;
  expect(nebula.visible).toBe(true);
  expect(nebula.opacity).toBeGreaterThanOrEqual(0.9);
  expect(nebula.layers.some((l) => l.visible)).toBe(true);
  const shot = await engineShot(page);
  writeFileSync(test.info().outputPath('nebula-approach.png'), shot.png);
  await test.info().attach('engine canvas mid-APPROACH (nebula)', { body: shot.png, contentType: 'image/png' });

  // Non-blank, and clearly unlike the stars-only frame: much more of the frame is lit, brighter and
  // coloured (the nebula gas), not just a few moving stars.
  const starStats = imageStats(stars.pixels);
  const nebulaStats = imageStats(shot.pixels);
  const differing = differingShare(stars.pixels, shot.pixels);
  test.info().annotations.push({
    type: 'image stats',
    description: JSON.stringify({ stars: starStats, nebula: nebulaStats, differing, family: nebula.family }),
  });
  expect(shot.width).toBe(stars.width);
  expect(nebulaStats.lit).toBeGreaterThan(0.15);
  expect(nebulaStats.lit).toBeGreaterThan(starStats.lit * 3);
  expect(nebulaStats.mean).toBeGreaterThan(starStats.mean * 2);
  expect(nebulaStats.coloured).toBeGreaterThan(0.08);
  expect(differing).toBeGreaterThan(0.1);
  // Not washed out: the gas settles toward its colours rather than adding up to white.
  expect(nebulaStats.mean).toBeLessThan(160);

  // The encounter carries on to CRUISE.
  await page.evaluate(() => window.__elsewhere!.resume());
  await expect
    .poll(async () => (await nebulaLog(page)).afterEncounters.length, { timeout: 300_000, intervals: [2_000] })
    .toBeGreaterThanOrEqual(1);
  const log = await nebulaLog(page);
  test.info().annotations.push({
    type: 'nebula log',
    description: JSON.stringify({ ...log, starsAt: undefined, nebulaAt: undefined }),
  });
  expect(log.states.slice(0, 5).map((s) => [s.state, s.index, s.kind])).toEqual([
    ['CRUISE', null, null],
    ['APPROACH', 0, 'nebula'],
    ['FLYBY', 0, 'nebula'],
    ['DEPARTURE', 0, 'nebula'],
    ['CRUISE', null, null],
  ]);
  expect(log.countErrors).toEqual([]);
  // Fades in from (nearly) nothing, and every layer is hidden before the camera nears its plane.
  expect(log.firstOpacity).not.toBeNull();
  expect(log.firstOpacity!).toBeLessThan(0.1);
  expect(log.minPlaneDistance).toBeLessThan(NEBULA_NEAR_FADE_MIN_DISTANCE * 4);
  expect(log.nearErrors).toEqual([]);
  // Geometries, textures and programs are back at the pre-encounter baseline.
  const after = log.afterEncounters[0]!;
  expect(log.baseline.geometries).toBeGreaterThan(0);
  expect(after.planets).toBe(0);
  expect(after.geometries).toBe(log.baseline.geometries);
  expect(after.textures).toBe(log.baseline.textures);
  expect(after.programs).toBe(log.baseline.programs);
  expect(errors).toEqual([]);
});
