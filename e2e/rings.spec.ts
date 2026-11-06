/**
 * Planet variety (docs/PLAN.md section 9, Phase 4): ringed planets and icy dwarfs.
 *
 * - The ring's depth order, on the preview canvas: drawn with and without its ring, a ringed planet
 *   must change exactly where the ring is in front of its disc or against the sky, and nowhere else;
 *   the disc hides the ring's far side. Drawn airless too: where the ring crosses the atmosphere's
 *   halo past the limb, the glow shows through the ring in front of it, dimmed, and over the ring
 *   behind it, whole. Checked again with the planet out at its spawn distance (ENCOUNTER_DISTANCE)
 *   and the camera zoomed in to frame it the same, so the 24-bit depth buffer, with CAMERA_NEAR and
 *   CAMERA_FAR, resolves the ring and the disc as it does at the spawn: no z-fighting there.
 * - The look: a ringed gas giant, a ringed rocky planet and an icy dwarf, screenshotted for review.
 * - Performance under SwiftShader: a ringed encounter against a plain one of a similar planet, in
 *   the engine, with no program compiled during either (the ring draws with the atmosphere's
 *   program, which ProgramWarmup keeps compiled) and no stall in the frames that create the planet
 *   or first draw it. The main-thread work is compared over enough frames that a frame or two lost
 *   to the machine cannot decide it (issue #68; see the comparison in the test).
 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ENCOUNTER_BASE_SEED, ENCOUNTER_DISTANCE } from '../src/config';
import { planetParams, type PlanetParams } from '../src/engine/Planet';
import { hash } from '../src/engine/seed';
import { formatTripSeed } from '../src/tripSeed';
import { appUrl } from './app';
import { frameTimeStats, installFrameSampler, takeFrameWindow } from './frameSampler';
import { FAST_ENCOUNTERS_ARRIVAL_SPEED, SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS } from './limits';

test.describe.configure({ timeout: 300_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** The first appearance seed of the test default trip whose planet passes `test`. */
function firstSeed(test: (p: PlanetParams) => boolean): number {
  for (let i = 0; i < 5000; i++) {
    const seed = hash(ENCOUNTER_BASE_SEED, i);
    if (test(planetParams(seed))) return seed;
  }
  throw new Error('no such planet');
}

/** Screenshots the preview canvas into the test's output, attached for review. */
async function savePreview(page: Page, name: string): Promise<Buffer> {
  const png = await page.locator('#planet-preview').screenshot();
  writeFileSync(test.info().outputPath(name), png);
  await test.info().attach(name, { body: png, contentType: 'image/png' });
  return png;
}

test('a ring shows in front of its planet and against the sky, and the planet hides the ring behind it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(appUrl('encounterInterval=1e9'));
  await page.waitForFunction(() => window.__elsewhere !== undefined);

  // A ringed gas giant and a ringed rocky planet, with rings open enough to pass behind the disc.
  const seeds = [
    firstSeed((p) => p.type === 'gas' && p.ring !== null && p.ring.opening < 0.45 && p.ring.inner < 1.5),
    firstSeed((p) => p.type === 'rocky' && p.ring !== null && p.ring.opening < 0.5),
  ];
  const results = [];
  // As framed for review, and out at the spawn distance with the camera zoomed in to frame it the same.
  const cases = seeds.flatMap((seed, index) => [null, ENCOUNTER_DISTANCE].map((distance) => ({ index, seed, distance })));
  for (const { index, seed, distance } of cases) {
    const info = await page.evaluate(({ s, d }) => window.__elsewhere!.checkRingDepth(s, d ?? undefined), { s: seed, d: distance });
    results.push({ distance, ...info });
    await savePreview(page, `ringed-${info.family}-${seed}${distance === null ? '' : `-at-${distance}`}.png`);
    const label = `${info.family} ${seed} at ${distance ?? 'the preview distance'}: ${JSON.stringify(info)}`;
    // Every class sampled.
    for (const cls of [info.frontOfDisc, info.behindDisc, info.overSky, info.elsewhere]) expect(cls.n, label).toBeGreaterThan(30);
    // The ring shows where it is in front of the disc and against the sky…
    expect(info.frontOfDisc.meanDiff, label).toBeGreaterThan(8);
    expect(info.overSky.meanDiff, label).toBeGreaterThan(8);
    // …the disc hides it exactly where it is behind…
    expect(info.behindDisc.maxDiff, label).toBe(0);
    // …and nothing else changes.
    expect(info.elsewhere.maxDiff, label).toBe(0);
    // Where the ring crosses the halo past the limb, the glow shows through it: dimmed by the ring
    // in front of it, never cut off, and whole over the ring behind it. (The rocky planet's faint
    // glow may leave these classes empty; the gas giant's never does.)
    if (index === 0) {
      expect(info.haloFront.n, label).toBeGreaterThan(30);
      expect(info.haloBehind.n, label).toBeGreaterThan(30);
    }
    if (info.haloFront.n > 0) {
      expect(info.haloFront.zeroed, label).toBe(0);
      expect(info.haloFront.glowWith / info.haloFront.glowWithout, label).toBeGreaterThan(0.15);
      expect(info.haloFront.glowWith / info.haloFront.glowWithout, label).toBeLessThan(0.95);
    }
    if (info.haloBehind.n > 0) {
      expect(info.haloBehind.zeroed, label).toBe(0);
      expect(Math.abs(info.haloBehind.glowWith / info.haloBehind.glowWithout - 1), label).toBeLessThan(0.03);
    }
  }
  test.info().annotations.push({ type: 'ring depth', description: JSON.stringify(results) });

  // An icy dwarf: small, pale, cratered; drawn with the rocky program.
  const icy = await page.evaluate((s) => window.__elsewhere!.showEncounter('planet', s), firstSeed((p) => p.family === 'icy' && p.ring === null));
  expect(icy.family).toBe('icy');
  expect(icy.type).toBe('rocky');
  await savePreview(page, `icy-${icy.seed}.png`);
  expect(errors).toEqual([]);
});

/** Trip seeds whose first encounter (always a planet) is a gas giant, ringed and plain, passed at a similar distance. */
function perfTrips(): { ringed: number; plain: number } {
  let ringed = -1;
  for (let base = 0; ringed < 0; base++) {
    const p = planetParams(hash(base, 0));
    if (p.type === 'gas' && p.ring !== null && p.radius > 60) ringed = base;
  }
  const target = planetParams(hash(ringed, 0));
  let plain = -1;
  for (let base = 0; plain < 0; base++) {
    const p = planetParams(hash(base, 0));
    if (p.type === 'gas' && p.ring === null && Math.abs(p.radius * p.passFactor - target.radius * target.passFactor) < 25) plain = base;
  }
  return { ringed, plain };
}

/**
 * Flies the first encounter of trip `tripSeed` at the top speed (encounters flown from it, see
 * FAST_ENCOUNTERS_ARRIVAL_SPEED) and returns its frame work times over the whole encounter and over
 * FLYBY alone (where the planet is largest), the work of the frames that created and first drew the
 * planet, the program counts at cruise and during the encounter, and the planet as FLYBY begins
 * (its surface bake done by then).
 */
async function flyFirstEncounter(page: Page, tripSeed: number) {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(appUrl(`seed=${formatTripSeed(tripSeed)}&encounterInterval=1&encounterKind=planet&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 5);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  const cruisePrograms = (await page.evaluate(() => window.__elsewhere!.snapshot())).renderer.programs;
  await installFrameSampler(page);
  await page.waitForFunction(() => window.__elsewhere!.probe().state === 'APPROACH', undefined, { timeout: 120_000, polling: 100 });
  const planet = (await page.evaluate(() => window.__elsewhere!.snapshot())).planet;
  await page.waitForFunction(() => window.__elsewhere!.probe().state === 'FLYBY', undefined, { timeout: 240_000, polling: 100 });
  const approach = await takeFrameWindow(page);
  const atFlyby = await page.evaluate(() => window.__elsewhere!.snapshot());
  const encounterPrograms = atFlyby.renderer.programs;
  await page.waitForFunction(() => window.__elsewhere!.probe().state === 'CRUISE', undefined, { timeout: 240_000, polling: 100 });
  const flyby = await takeFrameWindow(page);
  const marks = [...approach.marks, ...flyby.marks].find((m) => m.index === 0) ?? null;
  return {
    planet,
    flybyBake: atFlyby.planet?.bake ?? null,
    cruiseInterval: frameTimeStats(approach.cruise.interval),
    approachInterval: frameTimeStats(approach.encounter.interval),
    cruisePrograms,
    encounterPrograms,
    encounterWork: frameTimeStats([...approach.encounter.work, ...flyby.encounter.work]),
    flybyWork: frameTimeStats(flyby.encounter.work),
    flybyInterval: frameTimeStats(flyby.encounter.interval),
    marks,
  };
}

test('a ringed encounter costs about what a plain one does under SwiftShader, compiles nothing and never stalls', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  const trips = perfTrips();
  const ringed = await flyFirstEncounter(page, trips.ringed);
  const plain = await flyFirstEncounter(page, trips.plain);
  const report = { trips, ringed, plain };
  test.info().annotations.push({ type: 'ringed vs plain encounter (SwiftShader, 960×540)', description: JSON.stringify(report) });
  console.log(`ringed vs plain: ${JSON.stringify(report, null, 2)}`);

  expect(ringed.planet?.ringed).toBe(true);
  expect(plain.planet?.ringed).toBe(false);
  for (const run of [ringed, plain]) {
    // No program compiled for the encounter: the ring shares the atmosphere's (halo) program.
    expect(run.encounterPrograms).toBe(run.cruisePrograms);
    // No stall where the planet is created or first drawn.
    expect(run.marks?.createWork ?? 0).toBeLessThan(SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS);
    expect(run.marks?.visibleWork ?? 0).toBeLessThan(SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS);
    expect(run.encounterWork).not.toBeNull();
    expect(run.flybyWork).not.toBeNull();
    // Both gas giants are drawn from their baked surfaces through FLYBY (issue #65), and both baked
    // the same 48 slices during APPROACH, so the frames compared differ by the ring alone.
    expect(run.flybyBake?.baked).toBe(true);
  }
  // The ring is one more mesh of a few hundred triangles: its main-thread cost stays small.
  //
  // Compared so that a frame or two the main thread loses to the machine cannot decide it (issue
  // #68). With two workers, and more so under CPU load, up to about 1 frame in 50 of an encounter
  // takes 3 ms to over 100 ms instead of 0.2–0.5 ms, at random, in the simulation step (plain
  // JavaScript) about as often as in the render submission: the thread descheduled, or the GPU
  // process behind. FLYBY alone is only 12–28 frames, so its nearest-rank p95 was the plain run's
  // slowest frame and the ringed run's second slowest: two such frames in the ringed FLYBY failed the
  // check (3.4 ms against a 3.2 ms limit, with a 47 ms frame), and one in the plain FLYBY loosened it
  // to as much as 136 ms, past any regression. So it is now two checks, each with the factor 2 and
  // the 2 ms slack (work is timed to 0.1 ms) it had:
  // - the p95 over the whole encounter, APPROACH and FLYBY, about 530–650 frames, the ring drawn in
  //   nearly all of them (its main-thread cost does not grow with its size on screen): it takes about
  //   30 slow frames to move it. Measured 0.9–2.0 ms for the ringed run, against limits of 3.4–6.2.
  //   The post-load renderer stall (issue #61) is over before APPROACH: the 1 s of cruise before the
  //   encounter is simulated time, of which the stall adds one capped step (DT_CAP_SECONDS), so
  //   APPROACH begins 0.2–1.6 s after it ends, two minutes before FLYBY. The few slow frames there,
  //   as the GPU process catches up, are well within those 30;
  // - the median over FLYBY, where the planet and its ring are largest, so a cost paid only near
  //   the closest approach still shows: half its frames must be slow to move it. Measured
  //   0.2–0.4 ms against limits of 2.4–2.8.
  // A real cost paid every frame, or in more than about 1 frame in 20, still fails the first; one
  // paid every frame of the close pass, the second.
  expect(ringed.encounterWork!.p95).toBeLessThan(plain.encounterWork!.p95 * 2 + 2);
  expect(ringed.flybyWork!.p50).toBeLessThan(plain.flybyWork!.p50 * 2 + 2);
  expect(errors).toEqual([]);
});
