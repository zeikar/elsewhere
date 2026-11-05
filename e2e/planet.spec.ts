import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ENCOUNTER_DISTANCE } from '../src/config';
import type { PlanetPreviewOptions } from '../src/e2ePlanetPreview';
import { appUrl } from './app';

/**
 * Where the occlusion tests draw the planet: at its usual framing distance, and out at its spawn
 * distance (ENCOUNTER_DISTANCE), grown by the factor it moved out so it is framed the same against
 * the far layers while its depth is the spawn's (inside CAMERA_FAR, so it still paints over them).
 */
const OCCLUSION_PLACES: readonly { name: string; at: PlanetPreviewOptions }[] = [
  { name: '', at: {} },
  { name: ' (at its spawn distance)', at: { distance: ENCOUNTER_DISTANCE, farFraming: 'grow' } },
];

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;

// SwiftShader renders the procedural planet shaders slowly (a full-screen draw can take seconds);
// leave generous headroom over Playwright's 30 s default.
test.describe.configure({ timeout: 120_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

interface ShotStats {
  /** Fraction of pixels brighter than LIT_THRESHOLD. */
  litFraction: number;
  /** Mean colour of the lit pixels (0–255 per channel). */
  meanLit: [number, number, number];
  /** Spread (standard deviation) of lit-pixel luminance, 0–255: 0 for a flat disc. */
  lumaSpread: number;
}

/** Screenshots the preview canvas; returns the PNG and its decoded RGBA pixels (decoded in the page). */
async function previewShot(page: Page): Promise<{ png: Buffer; pixels: number[]; width: number; height: number }> {
  const png = await page.locator('#planet-preview').screenshot();
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    // Downsample, so the per-pixel comparison stays cheap.
    const width = Math.round(bitmap.width / 4);
    const height = Math.round(bitmap.height / 4);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { pixels: Array.from(ctx.getImageData(0, 0, width, height).data), width, height };
  }, png.toString('base64'));
  return { png, ...decoded };
}

function stats(pixels: readonly number[]): ShotStats {
  let lit = 0;
  const sum = [0, 0, 0];
  let lumaSum = 0;
  let lumaSq = 0;
  const total = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    if (Math.max(r, g, b) <= LIT_THRESHOLD) continue;
    lit++;
    sum[0]! += r;
    sum[1]! += g;
    sum[2]! += b;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;
    lumaSq += luma * luma;
  }
  const mean = lit > 0 ? lumaSum / lit : 0;
  return {
    litFraction: lit / total,
    meanLit: [sum[0]! / Math.max(lit, 1), sum[1]! / Math.max(lit, 1), sum[2]! / Math.max(lit, 1)],
    lumaSpread: lit > 0 ? Math.sqrt(Math.max(0, lumaSq / lit - mean * mean)) : 0,
  };
}

/** Mean absolute per-channel difference between two equally sized RGBA buffers, 0–255. */
function meanAbsDiff(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c]! - b[i + c]!);
    count += 3;
  }
  return sum / count;
}

test('draws a rocky and a gas planet that are non-blank and clearly differ, with no shader errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(appUrl());
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  // The starfield is not needed here; pausing it frees SwiftShader for the planet draws.
  await page.evaluate(() => window.__elsewhere!.pause());

  const rockyInfo = await page.evaluate(() => window.__elsewhere!.showPlanet('rocky'));
  expect(rockyInfo.type).toBe('rocky');
  const rocky = await previewShot(page);
  const gasInfo = await page.evaluate(() => window.__elsewhere!.showPlanet('gas'));
  expect(gasInfo.type).toBe('gas');
  expect(gasInfo.seed).not.toBe(rockyInfo.seed);
  const gas = await previewShot(page);

  writeFileSync(test.info().outputPath('rocky.png'), rocky.png);
  writeFileSync(test.info().outputPath('gas.png'), gas.png);
  await test.info().attach('rocky planet', { body: rocky.png, contentType: 'image/png' });
  await test.info().attach('gas planet', { body: gas.png, contentType: 'image/png' });

  for (const [name, shot] of [
    ['rocky', rocky],
    ['gas', gas],
  ] as const) {
    const s = stats(shot.pixels);
    test.info().annotations.push({ type: `${name} stats`, description: JSON.stringify(s) });
    // A lit sphere, not a blank canvas nor a filled screen: the planet's disc spans about 1/3.4 of
    // the view height in radius, and its night side is dark.
    expect(s.litFraction, name).toBeGreaterThan(0.05);
    expect(s.litFraction, name).toBeLessThan(0.6);
    // Shading and surface detail, not a flat disc.
    expect(s.lumaSpread, name).toBeGreaterThan(8);
  }

  expect(rocky.width).toBe(gas.width);
  expect(rocky.height).toBe(gas.height);
  expect(rocky.png.equals(gas.png)).toBe(false);
  // Both planets are framed the same, so the difference is in the surfaces themselves.
  expect(meanAbsDiff(rocky.pixels, gas.pixels)).toBeGreaterThan(4);

  // One program per planet type plus the atmosphere, all compiled without errors.
  expect(gasInfo.programs).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.__elsewhere!.hidePlanet());
  await expect(page.locator('#planet-preview')).toHaveCount(0);
  // Three.js logs shader compile and link errors through console.error.
  expect(errors).toEqual([]);
});

/** Hides everything but the canvases while a screenshot is taken (the controls overlay the view). */
const CANVAS_ONLY = 'body > :not(canvas) { display: none !important; }';

for (const { name, at } of OCCLUSION_PLACES) test(`a planet hides the far stars behind its disc, and they show all around it${name}`, async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(appUrl());
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.pause());

  // The same planet, framed the same, drawn without and then with the far-star layer behind it.
  const plainInfo = await page.evaluate((o) => window.__elsewhere!.showPlanet('rocky', 0, o), at);
  expect(plainInfo.farStarsBehindDisc).toBeNull();
  const plain = await page.locator('#planet-preview').screenshot({ style: CANVAS_ONLY });
  const info = await page.evaluate((o) => window.__elsewhere!.showPlanet('rocky', 0, { ...o, farStars: true }), at);
  const starry = await page.locator('#planet-preview').screenshot({ style: CANVAS_ONLY });
  await test.info().attach('planet with far stars', { body: starry, contentType: 'image/png' });
  // Plenty of far stars lie behind the disc, so hiding them is a real check.
  expect(info.farStarsBehindDisc).toBeGreaterThan(20);
  expect(info.disc.radius).toBeGreaterThan(50);

  // Pixels that differ between the two draws, inside the disc (0.8 × its radius, clear of the
  // antialiased limb) and well outside it (beyond 1.6 × its radius, clear of the atmosphere glow).
  const diff = await page.evaluate(
    async ({ a, b, disc }) => {
      const decode = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return { data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
      };
      const [pa, pb] = await Promise.all([decode(a), decode(b)]);
      // Screenshot pixels per CSS pixel.
      const scale = pa.width / window.innerWidth;
      let inside = 0;
      let insidePixels = 0;
      let outside = 0;
      for (let y = 0; y < pa.height; y++) {
        for (let x = 0; x < pa.width; x++) {
          const r = Math.hypot((x + 0.5) / scale - disc.x, (y + 0.5) / scale - disc.y) / disc.radius;
          const i = (y * pa.width + x) * 4;
          const differs = pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2];
          if (r < 0.8) {
            insidePixels++;
            if (differs) inside++;
          } else if (r > 1.6 && differs) {
            outside++;
          }
        }
      }
      return { inside, insidePixels, outside, sameSize: pa.width === pb.width && pa.height === pb.height };
    },
    { a: plain.toString('base64'), b: starry.toString('base64'), disc: info.disc },
  );
  test.info().annotations.push({ type: 'far-star occlusion', description: JSON.stringify({ ...diff, behindDisc: info.farStarsBehindDisc }) });
  expect(diff.sameSize).toBe(true);
  expect(diff.insidePixels).toBeGreaterThan(10_000);
  // Not one far-star pixel shows through the planet...
  expect(diff.inside).toBe(0);
  // ...while the far stars are drawn all around it.
  expect(diff.outside).toBeGreaterThan(200);
  await page.evaluate(() => window.__elsewhere!.hidePlanet());
  expect(errors).toEqual([]);
});

for (const { name, at } of OCCLUSION_PLACES) test(`a planet hides a distant galaxy behind its disc, and one beside it shows${name}`, async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(appUrl());
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.pause());

  // The same planet, framed the same, drawn without and then with the galaxy layer: the test
  // default trip's first galaxy straight behind the disc's centre and beside the disc.
  const plainInfo = await page.evaluate((o) => window.__elsewhere!.showPlanet('rocky', 0, o), at);
  expect(plainInfo.galaxies).toBeNull();
  const plain = await page.locator('#planet-preview').screenshot({ style: CANVAS_ONLY });
  const info = await page.evaluate((o) => window.__elsewhere!.showPlanet('rocky', 0, { ...o, galaxies: true }), at);
  const withGalaxies = await page.locator('#planet-preview').screenshot({ style: CANVAS_ONLY });
  await test.info().attach('planet with galaxies', { body: withGalaxies, contentType: 'image/png' });
  expect(info.galaxies).not.toBeNull();
  const galaxies = info.galaxies!;
  const galaxyRadius = galaxies.radius;
  // Small against the disc, so the copy behind it is wholly hidden, and its centre on the disc's.
  expect(galaxyRadius).toBeLessThan(0.3 * info.disc.radius);
  expect(Math.hypot(galaxies.behind.x - info.disc.x, galaxies.behind.y - info.disc.y)).toBeLessThan(1);

  const diff = await page.evaluate(
    async ({ a, b, disc, beside, galaxyRadius }) => {
      const decode = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return { data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
      };
      const [pa, pb] = await Promise.all([decode(a), decode(b)]);
      const scale = pa.width / window.innerWidth;
      let inside = 0;
      let besideDiffering = 0;
      let elsewhere = 0;
      for (let y = 0; y < pa.height; y++) {
        for (let x = 0; x < pa.width; x++) {
          const cx = (x + 0.5) / scale;
          const cy = (y + 0.5) / scale;
          const i = (y * pa.width + x) * 4;
          const differs = pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2];
          if (!differs) continue;
          if (Math.hypot(cx - disc.x, cy - disc.y) < 0.8 * disc.radius) inside++;
          // Off-centre, perspective stretches the quad a little: allow 25% and a pixel of margin.
          else if (Math.hypot(cx - beside.x, cy - beside.y) <= 1.25 * galaxyRadius + 1) besideDiffering++;
          else elsewhere++;
        }
      }
      return { inside, beside: besideDiffering, elsewhere, sameSize: pa.width === pb.width && pa.height === pb.height };
    },
    { a: plain.toString('base64'), b: withGalaxies.toString('base64'), disc: info.disc, beside: galaxies.beside, galaxyRadius },
  );
  test.info().annotations.push({ type: 'galaxy occlusion', description: JSON.stringify({ ...diff, galaxyRadius, disc: info.disc }) });
  expect(diff.sameSize).toBe(true);
  // Not one galaxy pixel shows through the planet...
  expect(diff.inside).toBe(0);
  // ...while the copy beside the disc is drawn, and nothing else changes.
  expect(diff.beside).toBeGreaterThan(100);
  expect(diff.elsewhere).toBe(0);
  await page.evaluate(() => window.__elsewhere!.hidePlanet());
  expect(errors).toEqual([]);
});
