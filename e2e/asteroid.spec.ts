/**
 * Asteroids (docs/PLAN.md section 9, Phase 4).
 *
 * - The e2e-only `?encounterKind=asteroid` override (src/e2eHook.ts; `npm run check:hook` checks that
 *   production reads no such override) makes every encounter an asteroid: it runs the full state
 *   cycle, draws lit rocks on the engine canvas, never brings the camera within the minimum pass
 *   distance of any rock, compiles no program (the rocks draw with the rocky planet surface program,
 *   which ProgramWarmup keeps compiled), and leaves every GPU resource at its baseline.
 * - The look: three seeded asteroids on the preview canvas, a single rock and two fields,
 *   screenshotted for review.
 * - Performance under SwiftShader: a field of seven rocks against a rocky planet, in the engine, with
 *   no program compiled during either and no stall in the frames that create the object or first
 *   draw it.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ASTEROID_MIN_PASS_DISTANCE, CAMERA_FOV_DEG, ENCOUNTER_BASE_SEED } from '../src/config';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { asteroidParams, type AsteroidParams } from '../src/engine/Asteroid';
import { generateGalaxies } from '../src/engine/Galaxies';
import { planetParams } from '../src/engine/Planet';
import { hash } from '../src/engine/seed';
import { formatTripSeed } from '../src/tripSeed';
import { appUrl } from './app';
import { frameTimeStats, installFrameSampler, takeFrameWindow, waitOutLoadStall, watchLoadStall } from './frameSampler';
import { FAST_ENCOUNTERS_ARRIVAL_SPEED, SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS, CRUISE_PROGRAMS } from './limits';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;

test.describe.configure({ timeout: 300_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

/** Screenshots `selector`; returns the PNG and its RGBA pixels (decoded in the page). */
async function shot(page: Page, selector: string): Promise<{ png: Buffer; pixels: number[]; width: number; height: number }> {
  const png = await page.locator(selector).screenshot();
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return { pixels: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data), width: bitmap.width, height: bitmap.height };
  }, png.toString('base64'));
  return { png, ...decoded };
}

/** Fraction of lit pixels within the annulus [inner, outer) around (cx, cy), in pixels. */
function litFraction(image: { pixels: readonly number[]; width: number; height: number }, cx: number, cy: number, inner: number, outer: number): number {
  const { pixels, width, height } = image;
  let lit = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(cy - outer)); y < Math.min(height, Math.ceil(cy + outer)); y++) {
    for (let x = Math.max(0, Math.floor(cx - outer)); x < Math.min(width, Math.ceil(cx + outer)); x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (r < inner || r >= outer) continue;
      const i = (y * width + x) * 4;
      total++;
      if (Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > LIT_THRESHOLD) lit++;
    }
  }
  return total > 0 ? lit / total : 0;
}

interface Resources {
  geometries: number;
  textures: number;
  programs: number;
  calls: number;
}

/** What the in-page watcher records, sampling the hook once per animation frame. */
interface AsteroidLog {
  states: { state: string; index: number | null; kind: string | null }[];
  baseline: Resources;
  /** Resources and encounter object count on each return to CRUISE. */
  afterEncounters: (Resources & { planets: number })[];
  /** The most resources seen during an encounter, and its rock count. */
  peak: Resources & { rocks: number };
  /** Frames whose object count or kind does not match the state, or whose program count changed. */
  errors: string[];
  /** Smallest distance from the camera to any rock's centre, in world units. */
  minRockDistance: number;
  /** The asteroid's opacity in the first frame it is drawn. */
  firstOpacity: number | null;
  /** Snapshot taken when the watcher paused the engine with the main rock near and on screen. */
  pausedAt: E2EHookSnapshot | null;
}

declare global {
  interface Window {
    __asteroidLog?: AsteroidLog;
  }
}

function watch(page: Page): Promise<void> {
  return page.evaluate(() => {
    const hook = window.__elsewhere!;
    let prev = hook.snapshot();
    const resources = (s: typeof prev): Resources => ({
      geometries: s.renderer.geometries,
      textures: s.renderer.textures,
      programs: s.renderer.programs,
      calls: s.renderer.calls,
    });
    const log: AsteroidLog = {
      states: [{ state: prev.autopilot.state, index: prev.autopilot.encounterIndex, kind: prev.autopilot.kind }],
      baseline: resources(prev),
      afterEncounters: [],
      peak: { geometries: 0, textures: 0, programs: 0, calls: 0, rocks: 0 },
      errors: [],
      minRockDistance: Number.POSITIVE_INFINITY,
      firstOpacity: null,
      pausedAt: null,
    };
    window.__asteroidLog = log;
    const tick = () => {
      requestAnimationFrame(tick);
      const s = hook.snapshot();
      if (s.frames === prev.frames) return;
      const a = s.autopilot;
      if (a.state !== log.states.at(-1)!.state) {
        log.states.push({ state: a.state, index: a.encounterIndex, kind: a.kind });
        if (a.state === 'CRUISE') log.afterEncounters.push({ ...resources(s), planets: s.planets });
      }
      if (s.renderer.programs !== log.baseline.programs) log.errors.push(`frame ${s.frames}: ${s.renderer.programs} programs`);
      const inEncounter = a.encounterIndex !== null;
      if (s.planets !== (inEncounter ? 1 : 0)) log.errors.push(`frame ${s.frames}: ${a.state} with ${s.planets} objects`);
      if (inEncounter && (a.kind !== 'asteroid' || s.asteroid === null || s.planet !== null || s.nebula !== null)) {
        log.errors.push(`frame ${s.frames}: a ${a.kind} encounter`);
      }
      const asteroid = s.asteroid;
      if (asteroid !== null) {
        const r = resources(s);
        log.peak = {
          geometries: Math.max(log.peak.geometries, r.geometries),
          textures: Math.max(log.peak.textures, r.textures),
          programs: Math.max(log.peak.programs, r.programs),
          calls: Math.max(log.peak.calls, r.calls),
          rocks: Math.max(log.peak.rocks, asteroid.rocks.length),
        };
        for (const rock of asteroid.rocks) {
          log.minRockDistance = Math.min(log.minRockDistance, Math.hypot(rock.position.x, rock.position.y, rock.position.z));
        }
        if (log.firstOpacity === null && asteroid.visible) log.firstOpacity = asteroid.opacity;
        const main = asteroid.rocks[0]!;
        const distance = Math.hypot(main.position.x, main.position.y, main.position.z);
        if (
          log.pausedAt === null &&
          asteroid.visible &&
          asteroid.opacity >= 0.9 &&
          main.ndc.z < 1 &&
          Math.abs(main.ndc.x) < 0.75 &&
          Math.abs(main.ndc.y) < 0.75 &&
          main.radius / distance > Math.sin((3 * Math.PI) / 180)
        ) {
          hook.pause();
          log.pausedAt = hook.snapshot();
        }
      }
      prev = s;
    };
    requestAnimationFrame(tick);
  });
}

function asteroidLog(page: Page): Promise<AsteroidLog> {
  return page.evaluate(() => window.__asteroidLog!);
}

test('a forced asteroid encounter draws lit rocks, runs the full cycle, compiles nothing and frees its GPU resources', async ({ page }) => {
  test.setTimeout(480_000);
  const errors = collectErrors(page);
  // Pixels are checked, but SwiftShader is fill-rate bound: a small viewport keeps the encounter short.
  await page.setViewportSize({ width: 640, height: 360 });
  // Flown from the top speed (see FAST_ENCOUNTERS_ARRIVAL_SPEED): this checks the rocks' pixels, the
  // state cycle, the clearance and the resources, not the speed profile.
  await page.goto(appUrl(`encounterInterval=1&encounterKind=asteroid&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  // The encounter programs are compiled asynchronously at start-up: wait until they all are (the
  // test default trip has galaxies: CRUISE_PROGRAMS, see e2e/limits.ts).
  await expect.poll(async () => (await snapshot(page)).renderer.programs, { timeout: 60_000 }).toBe(CRUISE_PROGRAMS.withGalaxies);
  await watch(page);

  // Mid-encounter, the main rock near, faded in and on screen.
  await expect.poll(async () => (await asteroidLog(page)).pausedAt !== null, { timeout: 300_000, intervals: [1_000] }).toBe(true);
  const pausedAt = (await asteroidLog(page)).pausedAt!;
  expect(pausedAt.paused).toBe(true);
  expect(pausedAt.autopilot.kind).toBe('asteroid');
  expect(pausedAt.planet).toBeNull();
  const asteroid = pausedAt.asteroid!;
  // The trip's first encounter is an asteroid too (forced), drawn with the seeded parameters.
  expect(asteroid.index).toBe(0);
  expect(asteroid.seed).toBe(hash(ENCOUNTER_BASE_SEED, 0));
  const params = asteroidParams(asteroid.seed);
  expect(asteroid.family).toBe(params.family);
  expect(asteroid.rocks.map((r) => r.radius)).toEqual(params.rocks.map((r) => r.radius));
  const image = await shot(page, '#scene');
  writeFileSync(test.info().outputPath('asteroid-approach.png'), image.png);
  await test.info().attach('engine canvas mid-encounter (asteroid)', { body: image.png, contentType: 'image/png' });
  // The main rock is lit at its centre; the sky beyond the field's bounding sphere is mostly dark.
  const focal = image.height / 2 / Math.tan(((pausedAt.cameraFov / 2) * Math.PI) / 180);
  const toPx = (ndc: { x: number; y: number }) => ({ x: ((ndc.x + 1) / 2) * image.width, y: ((1 - ndc.y) / 2) * image.height });
  const main = asteroid.rocks[0]!;
  const mainAt = toPx(main.ndc);
  const mainPx = Math.tan(Math.asin(main.radius / Math.hypot(main.position.x, main.position.y, main.position.z))) * focal;
  const fieldAt = toPx(asteroid.ndc);
  const fieldPx = Math.tan(Math.asin(Math.min(1, asteroid.radius / asteroid.distance))) * focal;
  const centre = litFraction(image, mainAt.x, mainAt.y, 0, mainPx * 0.35);
  const sky = litFraction(image, fieldAt.x, fieldAt.y, fieldPx * 1.4, fieldPx * 2);
  test.info().annotations.push({
    type: 'asteroid on screen',
    description: JSON.stringify({ family: asteroid.family, rocks: asteroid.rocks.length, mainAt, mainPx, fieldPx, centre, sky, fov: CAMERA_FOV_DEG }),
  });
  expect(mainPx).toBeGreaterThan(8);
  expect(centre).toBeGreaterThan(0.5);
  expect(sky).toBeLessThan(0.3);

  // The encounter carries on to CRUISE.
  await page.evaluate(() => window.__elsewhere!.resume());
  await expect.poll(async () => (await asteroidLog(page)).afterEncounters.length, { timeout: 300_000, intervals: [2_000] }).toBeGreaterThanOrEqual(1);
  const log = await asteroidLog(page);
  test.info().annotations.push({ type: 'asteroid log', description: JSON.stringify({ ...log, pausedAt: undefined }) });
  expect(log.states.slice(0, 5)).toEqual([
    { state: 'CRUISE', index: null, kind: null },
    { state: 'APPROACH', index: 0, kind: 'asteroid' },
    { state: 'FLYBY', index: 0, kind: 'asteroid' },
    { state: 'DEPARTURE', index: 0, kind: 'asteroid' },
    { state: 'CRUISE', index: null, kind: null },
  ]);
  // One asteroid in the scene during the encounter, none outside it, and no program compiled.
  expect(log.errors).toEqual([]);
  // Fades in from (nearly) nothing.
  expect(log.firstOpacity).not.toBeNull();
  expect(log.firstOpacity!).toBeLessThan(0.1);
  // The camera never comes within the minimum pass distance of any rock's centre (well clear of
  // every rock's bounding sphere).
  expect(log.minRockDistance).toBeGreaterThanOrEqual(ASTEROID_MIN_PASS_DISTANCE * (1 - 1e-6));
  // While it lasts: one geometry and at most one draw call more per rock, and no program.
  expect(log.peak.rocks).toBe(params.rocks.length);
  expect(log.peak.geometries).toBe(log.baseline.geometries + params.rocks.length);
  expect(log.peak.calls).toBeLessThanOrEqual(log.baseline.calls + params.rocks.length);
  expect(log.peak.programs).toBe(log.baseline.programs);
  // Geometries, textures and programs are back at the pre-encounter baseline.
  const after = log.afterEncounters[0]!;
  expect(after.planets).toBe(0);
  expect(after.geometries).toBe(log.baseline.geometries);
  expect(after.textures).toBe(log.baseline.textures);
  expect(after.programs).toBe(log.baseline.programs);
  expect(errors).toEqual([]);
});

/** Appearance seeds of the test default trip: a single rock, a field of at least five, and a field of another family. */
function previewSeeds(): number[] {
  const all = Array.from({ length: 500 }, (_, i) => hash(ENCOUNTER_BASE_SEED, i));
  const single = all.find((s) => asteroidParams(s).rocks.length === 1)!;
  const big = all.find((s) => asteroidParams(s).rocks.length >= 5 && asteroidParams(s).family !== asteroidParams(single).family)!;
  const families = new Set([asteroidParams(single).family, asteroidParams(big).family]);
  const third = all.find((s) => {
    const p: AsteroidParams = asteroidParams(s);
    return p.rocks.length > 1 && p.rocks.length < 5 && !families.has(p.family);
  })!;
  return [single, big, third];
}

test('three seeded asteroids, a single rock and two fields, draw lit, pairwise different, with no console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto(appUrl('encounterInterval=1e9'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.pause());
  const shots: { seed: number; family: string; pixels: number[] }[] = [];
  for (const seed of previewSeeds()) {
    const info = await page.evaluate((s) => window.__elsewhere!.showEncounter('asteroid', s), seed);
    expect(info.kind).toBe('asteroid');
    expect(info.type).toBeNull();
    expect(info.rocks).toBe(asteroidParams(seed).rocks.length);
    // One program: the rocky planet surface's.
    expect(info.programs).toBe(1);
    const image = await shot(page, '#planet-preview');
    const name = `asteroid-${seed}-${info.family}-${info.rocks}.png`;
    writeFileSync(test.info().outputPath(name), image.png);
    await test.info().attach(name, { body: image.png, contentType: 'image/png' });
    let lit = 0;
    for (let i = 0; i < image.pixels.length; i += 4) {
      if (Math.max(image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!) > LIT_THRESHOLD) lit++;
    }
    const share = lit / (image.pixels.length / 4);
    test.info().annotations.push({ type: `asteroid ${seed}`, description: JSON.stringify({ ...info, lit: share }) });
    expect(share, `seed ${seed}`).toBeGreaterThan(0.005);
    expect(share, `seed ${seed}`).toBeLessThan(0.5);
    shots.push({ seed, family: info.family, pixels: image.pixels });
  }
  expect(new Set(shots.map((s) => s.family)).size).toBe(3);
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      let differing = 0;
      const a = shots[i]!.pixels;
      const b = shots[j]!.pixels;
      for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k]! - b[k]!) + Math.abs(a[k + 1]! - b[k + 1]!) + Math.abs(a[k + 2]! - b[k + 2]!) > 24) differing++;
      expect(differing / (a.length / 4), `seeds ${shots[i]!.seed} and ${shots[j]!.seed}`).toBeGreaterThan(0.005);
    }
  }
  await page.evaluate(() => window.__elsewhere!.hidePlanet());
  expect(errors).toEqual([]);
});

/** Trip seeds whose first encounter is, forced to an asteroid, a field of seven rocks, and, forced to a planet, a rocky one with no ring. */
function perfTrips(): { asteroid: number; planet: number } {
  let asteroid = -1;
  for (let base = 0; asteroid < 0; base++) if (asteroidParams(hash(base, 0)).rocks.length === 7) asteroid = base;
  let planet = -1;
  for (let base = 0; planet < 0; base++) {
    const p = planetParams(hash(base, 0));
    if (p.type === 'rocky' && p.ring === null && p.family !== 'icy') planet = base;
  }
  return { asteroid, planet };
}

/**
 * The fewest FLYBY frames the asteroid run of the perf test compares a p75 over: its FLYBY is
 * 39–45 frames under SwiftShader, so this leaves room for slower runs. The planet run's p75 only
 * sets the limit, and its FLYBY is shorter (16–17 frames): a short one can loosen the check by a
 * frame or two but not fail it, so it is not guarded.
 */
const ASTEROID_FLYBY_MIN_FRAMES = 20;

/**
 * Flies the first encounter of trip `tripSeed`, forced to `kind`, at the top speed (flown from it,
 * see FAST_ENCOUNTERS_ARRIVAL_SPEED), and returns its frame times over the whole encounter and over
 * FLYBY alone (where the object is largest), the work of the frames that created and first drew it,
 * and the program counts at cruise and during the encounter.
 */
async function flyFirstEncounter(page: Page, tripSeed: number, kind: 'asteroid' | 'planet') {
  await watchLoadStall(page);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(appUrl(`seed=${formatTripSeed(tripSeed)}&encounterInterval=1&encounterKind=${kind}&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 5);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  // Paused through the post-load renderer stall, so the frames sampled (the one that creates the
  // encounter object in particular) do not meet it (frameSampler.ts, waitOutLoadStall).
  const loadStall = await waitOutLoadStall(page);
  // The encounter programs are compiled asynchronously at start-up: wait until they all are (one
  // more with any galaxy in the trip, see e2e/perf.spec.ts).
  const programs = generateGalaxies(tripSeed).length > 0 ? CRUISE_PROGRAMS.withGalaxies : CRUISE_PROGRAMS.withoutGalaxies;
  await expect.poll(async () => (await snapshot(page)).renderer.programs, { timeout: 60_000 }).toBe(programs);
  const cruisePrograms = (await snapshot(page)).renderer.programs;
  await page.evaluate(() => window.__elsewhere!.resume());
  await installFrameSampler(page);
  await page.waitForFunction(() => window.__elsewhere!.probe().state === 'APPROACH', undefined, { timeout: 120_000, polling: 100 });
  const at = await snapshot(page);
  await page.waitForFunction(() => window.__elsewhere!.probe().state === 'FLYBY', undefined, { timeout: 240_000, polling: 100 });
  const approach = await takeFrameWindow(page);
  const during = await snapshot(page);
  await page.waitForFunction(() => window.__elsewhere!.probe().state === 'CRUISE', undefined, { timeout: 240_000, polling: 100 });
  const flyby = await takeFrameWindow(page);
  const marks = [...approach.marks, ...flyby.marks].find((m) => m.index === 0) ?? null;
  return {
    loadStall,
    object: kind === 'asteroid' ? { family: at.asteroid?.family, rocks: at.asteroid?.rocks.length } : { family: at.planet?.family, radius: at.planet?.radius },
    cruisePrograms,
    encounterPrograms: during.renderer.programs,
    encounterCalls: during.renderer.calls,
    cruiseInterval: frameTimeStats(approach.cruise.interval),
    approachInterval: frameTimeStats(approach.encounter.interval),
    encounterWork: frameTimeStats([...approach.encounter.work, ...flyby.encounter.work]),
    flybyWork: frameTimeStats(flyby.encounter.work),
    flybyInterval: frameTimeStats(flyby.encounter.interval),
    marks,
  };
}

test('an asteroid field costs about what a planet encounter does under SwiftShader, compiles nothing and never stalls', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  const trips = perfTrips();
  const asteroid = await flyFirstEncounter(page, trips.asteroid, 'asteroid');
  const planet = await flyFirstEncounter(page, trips.planet, 'planet');
  const report = { trips, asteroid, planet };
  test.info().annotations.push({ type: 'asteroid field vs rocky planet encounter (SwiftShader, 960×540)', description: JSON.stringify(report) });
  console.log(`asteroid vs planet: ${JSON.stringify(report, null, 2)}`);

  expect(asteroid.object.rocks).toBe(7);
  for (const [name, run] of [['asteroid', asteroid], ['planet', planet]] as const) {
    // No program compiled for the encounter: the rocks share the rocky planet surface program.
    expect(run.encounterPrograms, `${name}: programs during the encounter vs at cruise`).toBe(run.cruisePrograms);
    // No stall where the object is created or first drawn.
    expect(run.marks?.createWork ?? 0, `${name}: work of the frame that created the object (ms)`).toBeLessThan(
      SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
    );
    expect(run.marks?.visibleWork ?? 0, `${name}: work of the frame that first drew the object (ms)`).toBeLessThan(
      SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
    );
    expect(run.encounterWork, `${name}: encounter work sampled`).not.toBeNull();
    expect(run.flybyWork, `${name}: FLYBY work sampled`).not.toBeNull();
    expect(run.flybyInterval, `${name}: FLYBY interval sampled`).not.toBeNull();
  }
  // Seven small meshes of a few hundred triangles each: their main-thread cost stays small, and
  // the frame interval (fill-rate bound under SwiftShader) is within noise of the planet's or less.
  //
  // The work is compared as e2e/rings.spec.ts compares it (issue #68), so that a frame or two the
  // main thread loses to the machine cannot decide it (issue #74): up to about 1 frame in 50 of an
  // encounter takes 3 ms to over 100 ms instead of well under 1 ms, at random (measured there). The
  // FLYBY p95 this used to compare is the nearest rank of 16–17 planet frames and 39–45 asteroid
  // ones: the planet's slowest and the asteroid's third slowest. So one slow planet frame loosens it,
  // and three slow asteroid frames can fail it. With 5 ms of work added to every asteroid FLYBY frame,
  // one planet FLYBY frame of 3.7 ms set its limit at 9.4 ms, and the asteroid's 8.2 ms passed it
  // (the checks below failed it: encounter p95 5.4 ms against 3.4). So it is two checks, each with
  // the factor 2 and the 2 ms slack it had:
  // - the p95 over the whole encounter, APPROACH and FLYBY (about 370–395 frames, the rocks drawn in
  //   nearly all of them), which catches a cost paid in more than about 1 frame in 20 of the
  //   encounter; measured 1.5–2.1 ms for the asteroid against limits of 4.4–4.6;
  // - the p75 over FLYBY, where the rocks are largest, which catches a cost paid only near the
  //   closest approach in more than about a quarter of those frames; measured 0.3–0.4 ms against
  //   limits of 2.6–2.8. It needs enough asteroid frames to mean that, so an asteroid run with fewer
  //   FLYBY frames than ASTEROID_FLYBY_MIN_FRAMES fails on the count rather than comparing a few.
  // A cost of more than about 2–3 ms paid in fewer than a quarter of the FLYBY frames, and nowhere
  // else, passes both. The interval's p50 is the median already, which one slow frame cannot move.
  expect(asteroid.flybyWork!.n, 'asteroid: FLYBY frames sampled').toBeGreaterThanOrEqual(ASTEROID_FLYBY_MIN_FRAMES);
  expect(asteroid.encounterWork!.p95, 'encounter work p95 (ms), asteroid vs planet × 2 + 2').toBeLessThan(planet.encounterWork!.p95 * 2 + 2);
  expect(asteroid.flybyWork!.p75, 'FLYBY work p75 (ms), asteroid vs planet × 2 + 2').toBeLessThan(planet.flybyWork!.p75 * 2 + 2);
  expect(asteroid.flybyInterval!.p50, 'FLYBY interval p50 (ms), asteroid vs planet × 1.25 + 2').toBeLessThan(
    planet.flybyInterval!.p50 * 1.25 + 2,
  );
  expect(errors).toEqual([]);
});
