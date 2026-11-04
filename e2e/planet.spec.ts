import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const APP_PATH = '/elsewhere/';

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
  await page.goto(APP_PATH);
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
