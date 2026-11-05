/**
 * GPU cost measurement (issue #65; docs/PLAN.md section 6, Performance).
 *
 * - `?gpuTiming=1` times every engine frame on the GPU where `EXT_disjoint_timer_query_webgl2` is
 *   there (SwiftShader has it), reported by the hook; `gpuCost()` adds the fallback estimate (shaded
 *   fragments × a per-shader cost, src/e2eGpuCost.ts), and `?perfOverlay=1` shows both on screen.
 * - The benchmark (`bench`, src/e2eGpuBench.ts) measures one frame of cruise or of an encounter at
 *   its most expensive moment. The full table, at 1512×982 @2× (a 14" MacBook Pro) and 1920×1080
 *   @1×, runs only with GPU_BENCH=1, as it takes several minutes under SwiftShader:
 *   `GPU_BENCH=1 npx playwright test e2e/gpuCost.spec.ts` after `npm run build:e2e`. SwiftShader is
 *   a software renderer: its numbers are a relative proxy, not what a GPU would take.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ENCOUNTER_BASE_SEED } from '../src/config';
import type { GpuBenchRequest, GpuBenchResult } from '../src/e2eGpuBench';
import { asteroidParams } from '../src/engine/Asteroid';
import { planetParams } from '../src/engine/Planet';
import { hash } from '../src/engine/seed';
import { formatTripSeed } from '../src/tripSeed';
import { appUrl } from './app';
import { CRUISE_PROGRAMS, SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS } from './limits';

test.describe.configure({ timeout: 300_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test('?gpuTiming=1 times frames on the GPU, gpuCost() adds an estimate, and ?perfOverlay=1 shows them', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 480, height: 270 });
  await page.goto(appUrl('encounterInterval=1e9&perfOverlay=1'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().perf.gpuMs?.count ?? 0) >= 3, undefined, { timeout: 60_000 });
  const s = await page.evaluate(() => window.__elsewhere!.snapshot());
  const cost = await page.evaluate(() => window.__elsewhere!.gpuCost());
  test.info().annotations.push({ type: 'gpu cost at cruise (SwiftShader, 480×270)', description: JSON.stringify(cost) });
  expect(cost.timing).toBe(true);
  expect(cost.timer).toBe(true);
  expect(s.perf.gpuMs!.mean).toBeGreaterThan(0);
  // At cruise only the star layers are drawn.
  expect(Object.keys(cost.estimate.fragments)).toEqual(['stars']);
  expect(cost.estimate.pixels).toBe(480 * 270);
  expect(cost.estimate.mops).toBeGreaterThan(0);
  await expect(page.locator('#perf-overlay')).toContainText('fps');
  await expect(page.locator('#perf-overlay')).toContainText('gpu');

  // Without the flag nothing is timed.
  await page.goto(appUrl('encounterInterval=1e9'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) >= 5);
  const off = await page.evaluate(() => window.__elsewhere!.gpuCost());
  expect(off.timing).toBe(false);
  expect(off.gpuMs).toBeNull();
  await expect(page.locator('#perf-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the benchmark draws a planet encounter at its most expensive moment and times it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 320, height: 180 });
  await page.goto(appUrl('encounterInterval=1e9'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) >= 3);
  await page.evaluate(() => window.__elsewhere!.pause());
  const cruise = await page.evaluate(() => window.__elsewhere!.bench({ scene: 'cruise', frames: 3 }));
  const planet = await page.evaluate(() => window.__elsewhere!.bench({ scene: 'planet', frames: 3 }));
  test.info().annotations.push({ type: 'bench (SwiftShader, 320×180)', description: JSON.stringify({ cruise, planet }) });
  expect(cruise.timer).toBe(true);
  expect(cruise.gpuMs?.n).toBe(3);
  expect(cruise.state.kind).toBeNull();
  // The test default trip's first planet, on screen and well past a dot.
  expect(planet.state.kind).toBe('planet');
  expect(planet.state.visible).toBe(true);
  expect(planet.state.family).toBe('oceanic');
  expect(planet.state.angularDiameterDeg).toBeGreaterThan(10);
  expect(planet.estimate.mops).toBeGreaterThan(cruise.estimate.mops);
  await page.evaluate(() => window.__elsewhere!.hideBench());
  expect(errors).toEqual([]);
});

test('a planet bakes its surface while it is still a dot, from warmed programs, and frees the cube maps with it', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 320, height: 180 });
  // The default speed level, so the far approach is flown as in a real trip.
  await page.goto(appUrl('encounterInterval=1&encounterKind=planet'));
  await expect
    .poll(async () => (await page.evaluate(() => window.__elsewhere!.snapshot())).renderer.programs, { timeout: 60_000 })
    .toBe(CRUISE_PROGRAMS.withGalaxies);
  const cruise = await page.evaluate(() => window.__elsewhere!.snapshot());
  expect(cruise.planet).toBeNull();
  // Watch every frame from the planet's creation until its bake is done.
  const log = await page.evaluate(
    () =>
      new Promise<{ frames: number; procedural: number; maxProgressStep: number; textures: number[]; programs: number[]; doneAtDeg: number; workMax: number; workMaxAt: number; work: number[] }>(
        (resolve) => {
          const hook = window.__elsewhere!;
          const out = { frames: 0, procedural: 0, maxProgressStep: 0, textures: [] as number[], programs: [] as number[], doneAtDeg: 0, workMax: 0, workMaxAt: -1, work: [] as number[] };
          let last = -1;
          let progress = 0;
          const tick = () => {
            const s = hook.snapshot();
            const p = s.planet;
            if (p !== null && p.bake !== null && s.frames !== last) {
              last = s.frames;
              out.frames++;
              out.maxProgressStep = Math.max(out.maxProgressStep, p.bake.progress - progress);
              progress = p.bake.progress;
              if (!p.bake.baked) out.procedural++;
              out.textures.push(s.renderer.textures);
              out.programs.push(s.renderer.programs);
              out.work.push(s.perf.workMs.last ?? 0);
              if ((s.perf.workMs.last ?? 0) > out.workMax) {
                out.workMax = s.perf.workMs.last ?? 0;
                out.workMaxAt = p.bake.progress;
              }
              if (p.bake.baked) {
                out.doneAtDeg = (2 * Math.asin(Math.min(1, p.drawnRadius / p.distance)) * 180) / Math.PI;
                resolve(out);
                return;
              }
            }
            requestAnimationFrame(tick);
          };
          tick();
        },
      ),
  );
  test.info().annotations.push({ type: 'bake (SwiftShader, 320×180)', description: JSON.stringify({ ...log, textures: [...new Set(log.textures)], programs: [...new Set(log.programs)] }) });
  const sorted = [...log.work].sort((a, b) => a - b);
  const workP95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
  console.log(`bake: ${JSON.stringify({ ...log, work: undefined, workP95, textures: [...new Set(log.textures)], programs: [...new Set(log.programs)] })}`);
  // Spread over frames: a rocky world (the test default trip's first planet) takes 96 slices of
  // 1/96 each (the first drawn in the frame that creates the planet), drawn procedurally until the
  // last.
  expect(log.maxProgressStep).toBeLessThanOrEqual(1 / 96 + 1e-9);
  expect(log.procedural).toBeGreaterThanOrEqual(95);
  // Done while the planet is a dot (well under 2° across).
  expect(log.doneAtDeg).toBeLessThan(1);
  // Its two cube maps, and no program compiled.
  expect(Math.max(...log.textures)).toBe(cruise.renderer.textures + 2);
  expect(new Set(log.programs)).toEqual(new Set([cruise.renderer.programs]));
  // No frame of the bake stalls the main thread. (The first slice used to, by 150–300 ms under
  // SwiftShader on a loaded machine: Three.js' first cube map queried the GPU with calls that wait
  // for it. The engine now makes a stand-in at start-up, see Engine.ts.)
  expect(log.workMax).toBeLessThan(SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS);
  expect(workP95).toBeLessThan(20);
  // After the encounter, the cube maps are gone.
  await page.waitForFunction(() => window.__elsewhere!.snapshot().autopilot.encounterCount >= 1 && window.__elsewhere!.snapshot().planet === null, undefined, {
    timeout: 500_000,
    polling: 100,
  });
  const after = await page.evaluate(() => window.__elsewhere!.snapshot());
  expect(after.renderer.textures).toBe(cruise.renderer.textures);
  expect(after.renderer.geometries).toBe(cruise.renderer.geometries);
  expect(after.renderer.programs).toBe(cruise.renderer.programs);
  expect(errors).toEqual([]);
});

/** Trip seeds for the table's encounters: each trip's first encounter (forced to the kind) is the one measured. */
function benchTrips() {
  const first = (test: (seed: number) => boolean) => {
    for (let base = 0; base < 100_000; base++) if (test(hash(base, 0))) return base;
    throw new Error('no such trip');
  };
  return {
    // The test default trip's first planet: an oceanic world (k ≈ 2.1).
    rocky: ENCOUNTER_BASE_SEED,
    // A large rocky world on one of the closest passes (k < 1.7): the worst case for the surface.
    rockyClose: first((s) => {
      const p = planetParams(s);
      return p.type === 'rocky' && p.ring === null && p.family !== 'icy' && p.radius > 40 && p.passFactor < 1.7;
    }),
    // A large ringed gas giant (as e2e/rings.spec.ts flies).
    ringedGas: first((s) => {
      const p = planetParams(s);
      return p.type === 'gas' && p.ring !== null && p.radius > 60;
    }),
    nebula: ENCOUNTER_BASE_SEED,
    // A field of 7 rocks.
    asteroid: first((s) => asteroidParams(s).rocks.length === 7),
  };
}

interface Row {
  name: string;
  request: GpuBenchRequest;
}

function rows(): Row[] {
  const t = benchTrips();
  return [
    { name: 'cruise', request: { scene: 'cruise', tripSeed: ENCOUNTER_BASE_SEED } },
    { name: 'rocky planet, closest (oceanic)', request: { scene: 'planet', tripSeed: t.rocky } },
    { name: 'rocky planet, closest, without atmosphere', request: { scene: 'planet', tripSeed: t.rocky, without: ['atmosphere'] } },
    { name: 'rocky planet, closest pass k<1.7', request: { scene: 'planet', tripSeed: t.rockyClose } },
    { name: 'ringed gas giant, closest', request: { scene: 'planet', tripSeed: t.ringedGas } },
    { name: 'ringed gas giant, closest, without ring', request: { scene: 'planet', tripSeed: t.ringedGas, without: ['ring'] } },
    { name: 'nebula, peak', request: { scene: 'nebula', tripSeed: t.nebula } },
    { name: 'asteroid field (7 rocks), closest', request: { scene: 'asteroid', tripSeed: t.asteroid } },
  ];
}

const RESOLUTIONS = [
  { label: '1512×982 @2×', width: 1512, height: 982, dpr: 2 },
  { label: '1920×1080 @1×', width: 1920, height: 1080, dpr: 1 },
] as const;

async function benchAt(browser: Browser, resolution: (typeof RESOLUTIONS)[number], list: readonly Row[]) {
  const context = await browser.newContext({ viewport: { width: resolution.width, height: resolution.height }, deviceScaleFactor: resolution.dpr });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(appUrl(`encounterInterval=1e9&seed=${formatTripSeed(ENCOUNTER_BASE_SEED)}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) >= 3);
  // The engine's own canvas is not measured: stop it, so it does not compete for the renderer.
  await page.evaluate(() => window.__elsewhere!.pause());
  const results: { name: string; result: GpuBenchResult }[] = [];
  for (const row of list) {
    const result = await page.evaluate((request) => window.__elsewhere!.bench(request), { ...row.request, frames: 4 });
    results.push({ name: row.name, result });
    console.log(`${resolution.label} ${row.name}: ${JSON.stringify({ gpu: result.gpuMs, wall: result.wallMs, mops: result.estimate.mops, state: result.state })}`);
  }
  await context.close();
  return { results, errors };
}

test('GPU cost table (GPU_BENCH=1): cruise and encounters at their most expensive, at 1512×982 @2× and 1920×1080 @1×', async ({ browser }) => {
  test.skip(process.env.GPU_BENCH !== '1', 'set GPU_BENCH=1 to run the full table (several minutes under SwiftShader)');
  test.setTimeout(3_600_000);
  const table: Record<string, { name: string; result: GpuBenchResult }[]> = {};
  const errors: string[] = [];
  for (const resolution of RESOLUTIONS) {
    const run = await benchAt(browser, resolution, rows());
    table[resolution.label] = run.results;
    errors.push(...run.errors);
  }
  const out = test.info().outputPath('gpu-cost.json');
  writeFileSync(out, JSON.stringify({ trips: benchTrips(), table }, null, 2));
  if (process.env.GPU_BENCH_OUT !== undefined) writeFileSync(process.env.GPU_BENCH_OUT, JSON.stringify({ trips: benchTrips(), table }, null, 2));
  await test.info().attach('gpu-cost.json', { path: out, contentType: 'application/json' });
  for (const runs of Object.values(table)) for (const { result } of runs) expect(result.gpuMs ?? result.wallMs).not.toBeNull();
  expect(errors).toEqual([]);
});
