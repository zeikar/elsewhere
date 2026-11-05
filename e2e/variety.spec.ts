import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { EncounterKind } from '../src/engine/Autopilot';
import { appUrl } from './app';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;

/**
 * Forced appearance seeds, three per kind, chosen to show the widened parameter space (docs/PLAN.md
 * section 9, Phase 3): an oceanic and a ferric rocky planet and an emerald gas giant; a planetary,
 * an aurora and a rosette nebula, on both sides of the path, with different layer counts and shapes.
 */
const SEEDS: Record<EncounterKind, readonly number[]> = {
  planet: [14, 2, 3],
  nebula: [9, 2, 1],
};

// SwiftShader renders the procedural shaders slowly; six full-viewport draws need some headroom.
test.describe.configure({ timeout: 180_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Screenshots the preview canvas; returns the PNG and its decoded, downsampled RGBA pixels. */
async function previewShot(page: Page): Promise<{ png: Buffer; pixels: number[] }> {
  const png = await page.locator('#planet-preview').screenshot();
  const pixels = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const width = Math.round(bitmap.width / 2);
    const height = Math.round(bitmap.height / 2);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return Array.from(ctx.getImageData(0, 0, width, height).data);
  }, png.toString('base64'));
  return { png, pixels };
}

/** Lit-pixel share, spread of lit luminance (0–255), and share of lit, clearly coloured pixels. */
function stats(pixels: readonly number[]): { lit: number; lumaSpread: number; coloured: number } {
  let lit = 0;
  let coloured = 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const max = Math.max(r, g, b);
    if (max <= LIT_THRESHOLD) continue;
    lit++;
    if (max - Math.min(r, g, b) > 0.35 * max) coloured++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sq += luma * luma;
  }
  const n = pixels.length / 4;
  const mean = lit > 0 ? sum / lit : 0;
  return { lit: lit / n, lumaSpread: lit > 0 ? Math.sqrt(Math.max(0, sq / lit - mean * mean)) : 0, coloured: coloured / n };
}

/** Mean absolute per-channel difference between two equally sized RGBA buffers, 0–255. */
function meanAbsDiff(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c]! - b[i + c]!);
  }
  return sum / ((a.length / 4) * 3);
}

for (const kind of ['planet', 'nebula'] as const) {
  test(`three forced ${kind} seeds draw non-blank ${kind === 'nebula' ? 'nebulae' : 'planets'} that are pairwise different, with no console errors`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    // SwiftShader is fill-rate bound; a small viewport keeps the six draws quick.
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(appUrl());
    await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
    // The starfield is not needed here; pausing it frees SwiftShader for the preview draws.
    await page.evaluate(() => window.__elsewhere!.pause());

    const shots: { seed: number; family: string; side: string; pixels: number[] }[] = [];
    for (const seed of SEEDS[kind]) {
      const info = await page.evaluate(([k, s]) => window.__elsewhere!.showEncounter(k, s), [kind, seed] as const);
      expect(info.kind).toBe(kind);
      expect(info.seed).toBe(seed);
      const shot = await previewShot(page);
      const name = `${kind}-seed-${seed}-${info.family}.png`;
      writeFileSync(test.info().outputPath(name), shot.png);
      await test.info().attach(name, { body: shot.png, contentType: 'image/png' });
      const s = stats(shot.pixels);
      test.info().annotations.push({ type: `${kind} seed ${seed}`, description: JSON.stringify({ ...info, ...s }) });
      // Non-blank, and not a flat fill.
      if (kind === 'planet') {
        expect(s.lit, `seed ${seed}`).toBeGreaterThan(0.05);
        expect(s.lit, `seed ${seed}`).toBeLessThan(0.6);
        expect(s.lumaSpread, `seed ${seed}`).toBeGreaterThan(8);
      } else {
        expect(s.lit, `seed ${seed}`).toBeGreaterThan(0.1);
        expect(s.coloured, `seed ${seed}`).toBeGreaterThan(0.05);
        expect(s.lumaSpread, `seed ${seed}`).toBeGreaterThan(4);
      }
      shots.push({ seed, family: info.family, side: info.side, pixels: shot.pixels });
    }

    // Pairwise different: distinct palette families, and clearly different images.
    expect(new Set(shots.map((s) => s.family)).size).toBe(shots.length);
    for (let i = 0; i < shots.length; i++) {
      for (let j = i + 1; j < shots.length; j++) {
        const diff = meanAbsDiff(shots[i]!.pixels, shots[j]!.pixels);
        test.info().annotations.push({ type: `${kind} diff ${shots[i]!.seed}–${shots[j]!.seed}`, description: diff.toFixed(2) });
        expect(diff, `seeds ${shots[i]!.seed} and ${shots[j]!.seed}`).toBeGreaterThan(4);
      }
    }
    if (kind === 'nebula') expect(new Set(shots.map((s) => s.side))).toEqual(new Set(['left', 'right']));

    await page.evaluate(() => window.__elsewhere!.hidePlanet());
    await expect(page.locator('#planet-preview')).toHaveCount(0);
    // Three.js logs shader compile and link errors through console.error.
    expect(errors).toEqual([]);
  });
}
