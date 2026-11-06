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
import { frameTimeStats, installFrameSampler, takeFrameWindow, waitOutLoadStall, watchLoadStall } from './frameSampler';
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
 * The fewest FLYBY frames the ringed run of the perf test compares a p75 over: its FLYBY is 23–28
 * frames under SwiftShader, idle or under CPU load, so this leaves room for slower runs. The plain
 * run's p75 only sets the limit, and its FLYBY is shorter (12–16 frames, down to 7 at about 4 fps
 * under load): a short one can loosen the check by a frame or two but not fail it, so it is not
 * guarded.
 */
const RINGED_FLYBY_MIN_FRAMES = 12;

/**
 * Flies the first encounter of trip `tripSeed` at the top speed (encounters flown from it, see
 * FAST_ENCOUNTERS_ARRIVAL_SPEED) and returns its frame work times over the whole encounter and over
 * FLYBY alone (where the planet is largest), the work of the frames that created and first drew the
 * planet, the program counts at cruise and during the encounter, and the planet as FLYBY begins
 * (its surface bake done by then).
 */
async function flyFirstEncounter(page: Page, tripSeed: number) {
  await watchLoadStall(page);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(appUrl(`seed=${formatTripSeed(tripSeed)}&encounterInterval=1&encounterKind=planet&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`));
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 5);
  await page.evaluate(() => window.__elsewhere!.setSpeed(99));
  // Paused through the post-load renderer stall, so the frames sampled (the one that creates the
  // encounter object in particular) do not meet it (frameSampler.ts, waitOutLoadStall).
  const loadStall = await waitOutLoadStall(page);
  const cruisePrograms = (await page.evaluate(() => window.__elsewhere!.snapshot())).renderer.programs;
  await page.evaluate(() => window.__elsewhere!.resume());
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
    loadStall,
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

  expect(ringed.planet?.ringed, 'ringed: planet has a ring').toBe(true);
  expect(plain.planet?.ringed, 'plain: planet has a ring').toBe(false);
  for (const [name, run] of [['ringed', ringed], ['plain', plain]] as const) {
    // No program compiled for the encounter: the ring shares the atmosphere's (halo) program.
    expect(run.encounterPrograms, `${name}: programs during the encounter vs at cruise`).toBe(run.cruisePrograms);
    // No stall where the planet is created or first drawn.
    expect(run.marks?.createWork ?? 0, `${name}: work of the frame that created the planet (ms)`).toBeLessThan(
      SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
    );
    expect(run.marks?.visibleWork ?? 0, `${name}: work of the frame that first drew the planet (ms)`).toBeLessThan(
      SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS,
    );
    expect(run.encounterWork, `${name}: encounter work sampled`).not.toBeNull();
    expect(run.flybyWork, `${name}: FLYBY work sampled`).not.toBeNull();
    // Both gas giants are drawn from their baked surfaces through FLYBY (issue #65), and both baked
    // the same 48 slices during APPROACH, so the frames compared differ by the ring alone.
    expect(run.flybyBake?.baked, `${name}: surface baked at FLYBY`).toBe(true);
  }
  // The ring is one more mesh of a few hundred triangles: its main-thread cost stays small.
  //
  // Compared so that a frame or two the main thread loses to the machine cannot decide it (issue
  // #68). With two workers, and more so under CPU load, up to about 1 frame in 50 of an encounter
  // takes 3 ms to over 100 ms instead of 0.2–0.5 ms, at random, in the simulation step (plain
  // JavaScript) about as often as in the render submission: the thread descheduled, or the GPU
  // process behind. FLYBY alone is only 7–28 frames, so its nearest-rank p95 was the plain run's
  // slowest frame and the ringed run's second slowest: two such frames in the ringed FLYBY failed the
  // check (3.4 ms against a 3.2 ms limit, with a 47 ms frame), and one in the plain FLYBY loosened it
  // to as much as 136 ms, past any regression. So it is now two checks, each with the factor 2 and
  // the 2 ms slack (work is timed to 0.1 ms) it had:
  // - the p95 over the whole encounter, APPROACH and FLYBY, about 530–650 frames, the ring drawn in
  //   nearly all of them (its main-thread cost does not grow with its size on screen). It takes
  //   about 30 slow frames to move it, so it catches a cost paid in more than about 1 frame in 20 of
  //   the encounter, but not one paid only in FLYBY, which has fewer frames than that. Measured
  //   0.8–2.0 ms for the ringed run, against limits of 3.2–6.2. The post-load renderer stall (issue
  //   #61) is waited out before the sampler starts (waitOutLoadStall, issue #74);
  // - the p75 over FLYBY, where the planet and its ring are largest, so it catches a cost paid only
  //   near the closest approach in more than about a quarter of those frames: 7 of 25 ringed frames
  //   must be slow to move it (against 2 for the old p95), and 4 of 13 plain ones to loosen it.
  //   Measured 0.3–0.6 ms against limits of 2.6–3.0, idle and under CPU load. It needs enough
  //   ringed frames to mean that, so a ringed run with fewer FLYBY frames than
  //   RINGED_FLYBY_MIN_FRAMES fails on the count rather than comparing a few frames.
  // A cost of more than about 2–3 ms paid in fewer than a quarter of the FLYBY frames, and nowhere
  // else, passes both. A FLYBY p90 would catch it, but 3 slow frames of 25 move that, which is the
  // flake again.
  expect(ringed.flybyWork!.n, 'ringed: FLYBY frames sampled').toBeGreaterThanOrEqual(RINGED_FLYBY_MIN_FRAMES);
  expect(ringed.encounterWork!.p95, 'encounter work p95 (ms), ringed vs plain × 2 + 2').toBeLessThan(plain.encounterWork!.p95 * 2 + 2);
  expect(ringed.flybyWork!.p75, 'FLYBY work p75 (ms), ringed vs plain × 2 + 2').toBeLessThan(plain.flybyWork!.p75 * 2 + 2);
  expect(errors).toEqual([]);
});
