/**
 * Comets (docs/PLAN.md section 9, Phase 4).
 *
 * - The e2e-only `?encounterKind=comet` override (src/e2eHook.ts; `npm run check:hook` checks that
 *   production reads no such override) makes every encounter a comet: it runs the full state cycle,
 *   draws the coma and tails on the engine canvas, fading in from nothing, never brings the camera
 *   within the minimum pass distance of the nucleus while the encounter lasts (and, measured on past
 *   its end, keeps the real pass near the planned distance and outside the coma), compiles no
 *   program (the nucleus draws with the rocky planet surface program and the coma and tails with
 *   the halo program, both kept compiled by ProgramWarmup), and leaves every GPU resource at its
 *   baseline. The engine canvas is screenshotted
 *   mid-approach and on the frame the comet has left the screen (the first DEPARTURE frame; the
 *   encounter ends as soon as the coma and the tails are off the screen, a few seconds short of the
 *   closest approach), and the share of the view the glow brightens is measured at both.
 * - The look: three seeded comets, one per family, on the preview canvas, screenshotted for review.
 * - Performance under SwiftShader: a comet encounter against a rocky planet's, in the engine, with no
 *   program compiled during either and no stall in the frames that create the object or first draw it.
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { COMET_MIN_PASS_DISTANCE, ENCOUNTER_BASE_SEED, ENCOUNTER_CLEARANCE_MARGIN } from '../src/config';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { COMET_FAMILY_NAMES, cometParams } from '../src/engine/Comet';
import { generateGalaxies } from '../src/engine/Galaxies';
import { planetParams } from '../src/engine/Planet';
import { hash } from '../src/engine/seed';
import { formatTripSeed } from '../src/tripSeed';
import { appUrl } from './app';
import { frameTimeStats, installFrameSampler, takeFrameWindow } from './frameSampler';
import { FAST_ENCOUNTERS_ARRIVAL_SPEED, SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS } from './limits';

/** A pixel counts as lit when its brightest channel is above this (0–255). */
const LIT_THRESHOLD = 16;
/** A pixel counts as washed out when its brightest channel is above this. */
const BRIGHT_THRESHOLD = 200;

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

/** Share of the image's pixels whose brightest channel is above `threshold`. */
function shareAbove(image: { pixels: readonly number[] }, threshold: number): number {
  let n = 0;
  for (let i = 0; i < image.pixels.length; i += 4) {
    if (Math.max(image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!) > threshold) n++;
  }
  return n / (image.pixels.length / 4);
}

/** Fraction of lit pixels within the disc of radius `r` around (cx, cy), in pixels. */
function litWithin(image: { pixels: readonly number[]; width: number; height: number }, cx: number, cy: number, r: number): number {
  const { pixels, width, height } = image;
  let lit = 0;
  let total = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= r) continue;
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
interface CometLog {
  states: { state: string; index: number | null; kind: string | null }[];
  baseline: Resources;
  /** Resources and encounter object count on each return to CRUISE. */
  afterEncounters: (Resources & { planets: number })[];
  /** The most resources seen during an encounter. */
  peak: Resources;
  /** Frames whose object count or kind does not match the state, or whose program count changed. */
  errors: string[];
  /** Smallest distance from the camera to the nucleus, in world units, and the remaining distance to the closest approach then. */
  minDistance: number;
  remainingAtMin: number | null;
  /**
   * The real pass, measured on past the end of the encounter: the nucleus's world position and the
   * planned path's direction (the heading, held during the encounter), as last seen while the comet
   * was in the scene; the remaining distance when it left the scene; the smallest distance from the
   * camera to the nucleus from the spawn until the ship is a coma radius past the closest approach;
   * and whether it has got that far.
   */
  nucleus: { x: number; y: number; z: number } | null;
  pathDirection: { x: number; y: number; z: number } | null;
  comaRadius: number | null;
  remainingAtEnd: number | null;
  realMinDistance: number;
  passed: boolean;
  /** The comet's opacity in the first frame it is drawn. */
  firstOpacity: number | null;
  /** Snapshot taken when the watcher paused the engine late in the approach (250 short of the closest approach), the tails stretched past the camera's side. */
  pausedAt: E2EHookSnapshot | null;
  /**
   * Snapshot taken when the watcher paused the engine on the first DEPARTURE frame: once the comet is
   * off the screen (before the closest approach), or at the closest approach should it still be on it.
   */
  pausedAtDeparture: E2EHookSnapshot | null;
}

declare global {
  interface Window {
    __cometLog?: CometLog;
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
    const log: CometLog = {
      states: [{ state: prev.autopilot.state, index: prev.autopilot.encounterIndex, kind: prev.autopilot.kind }],
      baseline: resources(prev),
      afterEncounters: [],
      peak: { geometries: 0, textures: 0, programs: 0, calls: 0 },
      errors: [],
      minDistance: Number.POSITIVE_INFINITY,
      remainingAtMin: null,
      nucleus: null,
      pathDirection: null,
      comaRadius: null,
      remainingAtEnd: null,
      realMinDistance: Number.POSITIVE_INFINITY,
      passed: false,
      firstOpacity: null,
      pausedAt: null,
      pausedAtDeparture: null,
    };
    window.__cometLog = log;
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
      if (inEncounter && (a.kind !== 'comet' || s.comet === null || s.planet !== null || s.asteroid !== null || s.nebula !== null)) {
        log.errors.push(`frame ${s.frames}: a ${a.kind} encounter`);
      }
      const comet = s.comet;
      if (comet !== null) {
        const r = resources(s);
        log.peak = {
          geometries: Math.max(log.peak.geometries, r.geometries),
          textures: Math.max(log.peak.textures, r.textures),
          programs: Math.max(log.peak.programs, r.programs),
          calls: Math.max(log.peak.calls, r.calls),
        };
        if (comet.distance < log.minDistance) {
          log.minDistance = comet.distance;
          log.remainingAtMin = a.remaining;
        }
        if (comet.index === 0) {
          const ship = s.ship.position;
          log.nucleus = { x: ship.x + comet.position.x, y: ship.y + comet.position.y, z: ship.z + comet.position.z };
          log.pathDirection = { ...s.ship.heading };
          log.comaRadius = comet.radius;
          log.remainingAtEnd = a.remaining;
          log.realMinDistance = Math.min(log.realMinDistance, comet.distance);
        }
        if (log.firstOpacity === null && comet.visible) log.firstOpacity = comet.opacity;
        if (log.pausedAt === null && comet.visible && comet.opacity >= 0.9 && a.remaining !== null && a.remaining <= 250) {
          hook.pause();
          log.pausedAt = hook.snapshot();
        } else if (log.pausedAt !== null && log.pausedAtDeparture === null && a.state === 'DEPARTURE') {
          hook.pause();
          log.pausedAtDeparture = hook.snapshot();
        }
      }
      if (comet?.index !== 0 && log.nucleus !== null && log.pathDirection !== null && log.comaRadius !== null && !log.passed) {
        // The first comet has left the scene short of the closest approach: its pass goes on (whether
        // or not the next encounter has begun).
        const n = log.nucleus;
        const d = log.pathDirection;
        const rel = { x: n.x - s.ship.position.x, y: n.y - s.ship.position.y, z: n.z - s.ship.position.z };
        log.realMinDistance = Math.min(log.realMinDistance, Math.hypot(rel.x, rel.y, rel.z));
        if (rel.x * d.x + rel.y * d.y + rel.z * d.z < -log.comaRadius) log.passed = true;
      }
      prev = s;
    };
    requestAnimationFrame(tick);
  });
}

function cometLog(page: Page): Promise<CometLog> {
  return page.evaluate(() => window.__cometLog!);
}

test('a forced comet encounter draws its coma and tails, runs the full cycle, compiles nothing and frees its GPU resources', async ({ page }) => {
  test.setTimeout(480_000);
  const errors = collectErrors(page);
  // Pixels are checked, but SwiftShader is fill-rate bound: a small viewport keeps the encounter short.
  await page.setViewportSize({ width: 640, height: 360 });
  // Flown from the top speed (see FAST_ENCOUNTERS_ARRIVAL_SPEED): this checks the glow's pixels, the
  // state cycle, the clearance and the resources, not the speed profile.
  await page.goto(appUrl(`encounterInterval=1&encounterKind=comet&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  // The encounter programs are compiled asynchronously at start-up: wait until they all are (the
  // test default trip has galaxies: 7, see e2e/perf.spec.ts). Comets add none.
  await expect.poll(async () => (await snapshot(page)).renderer.programs, { timeout: 60_000 }).toBe(7);
  await watch(page);
  // The stars alone, before the comet has faded in (at the spawn it is at opacity 0).
  const cruiseShot = await shot(page, '#scene');

  // Mid-approach: the coma ahead, the tails stretching back past the camera's side.
  await expect.poll(async () => (await cometLog(page)).pausedAt !== null, { timeout: 300_000, intervals: [1_000] }).toBe(true);
  const pausedAt = (await cometLog(page)).pausedAt!;
  expect(pausedAt.paused).toBe(true);
  expect(pausedAt.autopilot.kind).toBe('comet');
  const comet = pausedAt.comet!;
  // The trip's first encounter is a comet too (forced), drawn with the seeded parameters and its tails.
  expect(comet.index).toBe(0);
  expect(comet.seed).toBe(hash(ENCOUNTER_BASE_SEED, 0));
  const params = cometParams(comet.seed);
  expect(comet.family).toBe(params.family);
  expect(comet.radius).toBe(params.radius);
  expect(comet.tails).toBe(true);
  // Both tails point straight away from the comet's sun.
  for (const tail of [comet.ion, comet.dust]) {
    expect(tail.x * comet.sun.x + tail.y * comet.sun.y + tail.z * comet.sun.z).toBeCloseTo(-1, 6);
  }
  const image = await shot(page, '#scene');
  writeFileSync(test.info().outputPath('comet-approach.png'), image.png);
  await test.info().attach('engine canvas mid-approach (comet)', { body: image.png, contentType: 'image/png' });
  // The coma glows around the nucleus; the glow brightens part of the view, and washes out almost none.
  const focal = image.height / 2 / Math.tan(((pausedAt.cameraFov / 2) * Math.PI) / 180);
  const at = { x: ((comet.ndc.x + 1) / 2) * image.width, y: ((1 - comet.ndc.y) / 2) * image.height };
  const comaPx = Math.tan(Math.asin(Math.min(1, comet.radius / comet.distance))) * focal;
  const coma = litWithin(image, at.x, at.y, Math.max(2, comaPx * 0.3));
  const approach = { lit: shareAbove(image, LIT_THRESHOLD), bright: shareAbove(image, BRIGHT_THRESHOLD) };
  const cruise = { lit: shareAbove(cruiseShot, LIT_THRESHOLD), bright: shareAbove(cruiseShot, BRIGHT_THRESHOLD) };

  // DEPARTURE: the coma has left the screen to the side, and the tails, trailing back and away from
  // the path, with it.
  await page.evaluate(() => window.__elsewhere!.resume());
  await expect.poll(async () => (await cometLog(page)).pausedAtDeparture !== null, { timeout: 300_000, intervals: [500] }).toBe(true);
  const departureShot = await shot(page, '#scene');
  writeFileSync(test.info().outputPath('comet-departure.png'), departureShot.png);
  await test.info().attach('engine canvas once the comet has left the screen (comet)', { body: departureShot.png, contentType: 'image/png' });
  const departure = { lit: shareAbove(departureShot, LIT_THRESHOLD), bright: shareAbove(departureShot, BRIGHT_THRESHOLD) };
  const departed = (await cometLog(page)).pausedAtDeparture!;
  test.info().annotations.push({
    type: 'comet on screen (share of the view lit / washed out)',
    description: JSON.stringify({ family: comet.family, comaPx, coma, cruise, approach, departure, remainingAtDeparture: departed.autopilot.remaining }),
  });
  expect(comaPx).toBeGreaterThan(4);
  expect(coma).toBeGreaterThan(0.9);
  // The glow lights up part of the view mid-approach (more than the stars alone), never most of it,
  // and next to nothing is washed out; once the autopilot has found the comet off the screen, the view
  // is back to the stars, tails and all.
  expect(approach.lit).toBeGreaterThan(cruise.lit + 0.02);
  expect(approach.lit).toBeLessThan(0.35);
  expect(approach.bright).toBeLessThan(0.01);
  expect(departed.autopilot.viewMargin).not.toBeNull();
  expect(departed.autopilot.viewMargin!).toBeGreaterThan(0);
  expect(departure.lit).toBeLessThan(cruise.lit + 0.005);
  expect(departure.bright).toBeLessThan(0.005);

  // The encounter carries on to CRUISE, and the ship on past the closest approach.
  await page.evaluate(() => window.__elsewhere!.resume());
  await expect.poll(async () => (await cometLog(page)).afterEncounters.length, { timeout: 300_000, intervals: [2_000] }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await cometLog(page)).passed, { timeout: 120_000, intervals: [500] }).toBe(true);
  const log = await cometLog(page);
  test.info().annotations.push({ type: 'comet log', description: JSON.stringify({ ...log, pausedAt: undefined, pausedAtDeparture: undefined, planned: params.radius * params.passFactor }) });
  expect(log.states.slice(0, 5)).toEqual([
    { state: 'CRUISE', index: null, kind: null },
    { state: 'APPROACH', index: 0, kind: 'comet' },
    { state: 'FLYBY', index: 0, kind: 'comet' },
    { state: 'DEPARTURE', index: 0, kind: 'comet' },
    { state: 'CRUISE', index: null, kind: null },
  ]);
  // One comet in the scene during the encounter, none outside it, and no program compiled.
  expect(log.errors).toEqual([]);
  // Fades in from (nearly) nothing.
  expect(log.firstOpacity).not.toBeNull();
  expect(log.firstOpacity!).toBeLessThan(0.1);
  // While the encounter lasts, the camera never comes within the minimum pass distance of the nucleus
  // (nor, with it, into the coma).
  expect(log.minDistance).toBeGreaterThanOrEqual(COMET_MIN_PASS_DISTANCE * (1 - 1e-6));
  // The ship flies the planned path: its distance from the nucleus is the planned one for where it
  // is along the path (the encounter ends a little short of the closest approach, once the comet is
  // off the screen).
  expect(log.remainingAtMin).not.toBeNull();
  expect(log.minDistance).toBeLessThan(Math.hypot(params.radius * params.passFactor, log.remainingAtMin!) * 1.01);
  // The real pass, measured on until the ship is a coma radius past the closest approach: the comet
  // left the scene short of it, and the next cruise eases the heading drift back up while the ship is
  // still short of the nucleus, so the real pass can be a little nearer than the planned one (issue
  // #62 removes the drift), and well outside the coma. A smoke check of the measurement: this flies
  // at the top level with encounterInterval=1 (measured 0.998 × the planned distance);
  // Comet.test.ts covers the dip at level 0. The upper bound fails unless the post-end samples
  // reach the closest approach: the in-encounter ones alone stay near hypot(planned,
  // remainingAtEnd), well above it (the widest real pass is 1.013 × at level 0, 1.004 × at the top).
  expect(log.remainingAtEnd).not.toBeNull();
  expect(log.remainingAtEnd!).toBeGreaterThan(0);
  expect(log.realMinDistance).toBeGreaterThanOrEqual(0.95 * params.radius * params.passFactor);
  expect(log.realMinDistance).toBeLessThan(1.02 * params.radius * params.passFactor);
  expect(log.realMinDistance).toBeGreaterThan(params.radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
  // While it lasts: two geometries (the nucleus and the glow), at most two draw calls more, no program.
  expect(log.peak.geometries).toBe(log.baseline.geometries + 2);
  expect(log.peak.calls).toBeLessThanOrEqual(log.baseline.calls + 2);
  expect(log.peak.programs).toBe(log.baseline.programs);
  // Geometries, textures and programs are back at the pre-encounter baseline.
  const after = log.afterEncounters[0]!;
  expect(after.planets).toBe(0);
  expect(after.geometries).toBe(log.baseline.geometries);
  expect(after.textures).toBe(log.baseline.textures);
  expect(after.programs).toBe(log.baseline.programs);
  expect(errors).toEqual([]);
});

/** Appearance seeds of the test default trip: the first comet of each family. */
function previewSeeds(): number[] {
  const all = Array.from({ length: 500 }, (_, i) => hash(ENCOUNTER_BASE_SEED, i));
  return COMET_FAMILY_NAMES.map((family) => all.find((s) => cometParams(s).family === family)!);
}

test('three seeded comets, one per family, draw a lit coma and tails, pairwise different, with no console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto(appUrl('encounterInterval=1e9'));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  await page.evaluate(() => window.__elsewhere!.pause());
  const shots: { seed: number; family: string; pixels: number[] }[] = [];
  for (const seed of previewSeeds()) {
    const info = await page.evaluate((s) => window.__elsewhere!.showEncounter('comet', s), seed);
    expect(info.kind).toBe('comet');
    expect(info.type).toBeNull();
    expect(info.rocks).toBeNull();
    expect(info.radius).toBe(cometParams(seed).radius);
    // Two programs: the rocky planet surface's (the nucleus) and the halo's (the coma and the tails).
    expect(info.programs).toBe(2);
    const image = await shot(page, '#planet-preview');
    const name = `comet-${seed}-${info.family}.png`;
    writeFileSync(test.info().outputPath(name), image.png);
    await test.info().attach(name, { body: image.png, contentType: 'image/png' });
    const lit = shareAbove(image, LIT_THRESHOLD);
    const bright = shareAbove(image, BRIGHT_THRESHOLD);
    test.info().annotations.push({ type: `comet ${seed}`, description: JSON.stringify({ ...info, lit, bright }) });
    expect(lit, `seed ${seed}`).toBeGreaterThan(0.003);
    expect(lit, `seed ${seed}`).toBeLessThan(0.5);
    expect(bright, `seed ${seed}`).toBeLessThan(0.01);
    shots.push({ seed, family: info.family, pixels: image.pixels });
  }
  expect(new Set(shots.map((s) => s.family))).toEqual(new Set(COMET_FAMILY_NAMES));
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      let differing = 0;
      const a = shots[i]!.pixels;
      const b = shots[j]!.pixels;
      for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k]! - b[k]!) + Math.abs(a[k + 1]! - b[k + 1]!) + Math.abs(a[k + 2]! - b[k + 2]!) > 24) differing++;
      expect(differing / (a.length / 4), `seeds ${shots[i]!.seed} and ${shots[j]!.seed}`).toBeGreaterThan(0.003);
    }
  }
  await page.evaluate(() => window.__elsewhere!.hidePlanet());
  expect(errors).toEqual([]);
});

/** A trip seed whose first encounter, forced to a planet, is a rocky one with no ring (as e2e/asteroid.spec.ts compares against). */
function rockyPlanetTrip(): number {
  for (let base = 0; ; base++) {
    const p = planetParams(hash(base, 0));
    if (p.type === 'rocky' && p.ring === null && p.family !== 'icy') return base;
  }
}

/**
 * Flies the first encounter of trip `tripSeed`, forced to `kind`, at the top speed (flown from it,
 * see FAST_ENCOUNTERS_ARRIVAL_SPEED), and returns its frame times over APPROACH (where a comet's
 * tails stretch past the camera's side) and over FLYBY (where the object is largest), the work of the
 * frames that created and first drew it, and the program counts at cruise and during the encounter.
 */
async function flyFirstEncounter(page: Page, tripSeed: number, kind: 'comet' | 'planet') {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(appUrl(`seed=${formatTripSeed(tripSeed)}&encounterInterval=1&encounterKind=${kind}&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 5);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  const programs = generateGalaxies(tripSeed).length > 0 ? 7 : 6;
  await expect.poll(async () => (await snapshot(page)).renderer.programs, { timeout: 60_000 }).toBe(programs);
  const cruisePrograms = (await snapshot(page)).renderer.programs;
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
    object: kind === 'comet' ? { family: at.comet?.family, radius: at.comet?.radius } : { family: at.planet?.family, radius: at.planet?.radius },
    cruisePrograms,
    encounterPrograms: during.renderer.programs,
    encounterCalls: during.renderer.calls,
    cruiseInterval: frameTimeStats(approach.cruise.interval),
    approachInterval: frameTimeStats(approach.encounter.interval),
    approachWork: frameTimeStats(approach.encounter.work),
    flybyWork: frameTimeStats(flyby.encounter.work),
    flybyInterval: frameTimeStats(flyby.encounter.interval),
    marks,
  };
}

test('a comet encounter costs about what a rocky planet encounter does under SwiftShader, compiles nothing and never stalls', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  const trips = { comet: ENCOUNTER_BASE_SEED, planet: rockyPlanetTrip() };
  const comet = await flyFirstEncounter(page, trips.comet, 'comet');
  const planet = await flyFirstEncounter(page, trips.planet, 'planet');
  const report = { trips, comet, planet };
  test.info().annotations.push({ type: 'comet vs rocky planet encounter (SwiftShader, 960×540)', description: JSON.stringify(report) });
  console.log(`comet vs planet: ${JSON.stringify(report, null, 2)}`);

  for (const run of [comet, planet]) {
    // No program compiled for the encounter: the comet shares the rocky surface and halo programs.
    expect(run.encounterPrograms).toBe(run.cruisePrograms);
    // No stall where the object is created or first drawn.
    expect(run.marks?.createWork ?? 0).toBeLessThan(SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS);
    expect(run.marks?.visibleWork ?? 0).toBeLessThan(SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS);
    expect(run.approachInterval).not.toBeNull();
    expect(run.flybyWork).not.toBeNull();
    expect(run.flybyInterval).not.toBeNull();
  }
  // Two draw calls of a few thousand triangles: little main-thread work, and the frame interval
  // (fill-rate bound under SwiftShader) within noise of the rocky planet's or less, both while the
  // tails stretch past the camera's side and while the planet fills more of the view.
  expect(comet.flybyWork!.p95).toBeLessThan(planet.flybyWork!.p95 * 2 + 2);
  expect(comet.flybyInterval!.p50).toBeLessThan(planet.flybyInterval!.p50 * 1.25 + 2);
  expect(comet.approachInterval!.p50).toBeLessThan(planet.approachInterval!.p50 * 1.25 + 2);
  expect(errors).toEqual([]);
});
