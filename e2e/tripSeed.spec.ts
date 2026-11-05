import { expect, test, type Page } from '@playwright/test';
import { ENCOUNTER_BASE_SEED } from '../src/config';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { formatTripSeed } from '../src/tripSeed';
import { APP_PATH, TEST_TRIP_SEED, appUrl } from './app';
import { FAST_ENCOUNTERS_ARRIVAL_SPEED } from './limits';

// The trip seed (src/tripSeed.ts): random on each load without `?seed=`, replayed with it, and shown
// in the URL after load. These loads skip appUrl's pinned test seed on purpose, except where noted.

// SwiftShader renders at only a few fps, which slows every page interaction.
test.describe.configure({ timeout: 120_000 });

/** No encounter during these tests, unless a test asks for one. */
const NO_ENCOUNTERS = 'encounterInterval=1e9';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function open(page: Page, url: string): Promise<E2EHookSnapshot> {
  await page.goto(url);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

/** The URL's query parameters. */
function query(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

test('without ?seed, each load is a new random trip and the URL shows its seed', async ({ page }) => {
  const errors = collectErrors(page);
  const seeds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const snap = await open(page, `${APP_PATH}?${NO_ENCOUNTERS}`);
    const shown = query(page).get('seed');
    expect(shown).toMatch(/^[0-9a-f]{8}$/);
    expect(shown).toBe(formatTripSeed(snap.tripSeed));
    // The other parameters are kept.
    expect(query(page).get('encounterInterval')).toBe('1e9');
    seeds.push(shown!);
  }
  // Three uniform 32-bit draws all equal by chance: about 1 in 2^64.
  expect(new Set(seeds).size).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('?seed=<8 hex digits> is the trip seed and stays in the URL, in lowercase', async ({ page }) => {
  const errors = collectErrors(page);
  let snap = await open(page, appUrl(NO_ENCOUNTERS));
  expect(snap.tripSeed).toBe(ENCOUNTER_BASE_SEED);
  expect(query(page).get('seed')).toBe(TEST_TRIP_SEED);
  snap = await open(page, `${APP_PATH}?seed=${TEST_TRIP_SEED.toUpperCase()}&${NO_ENCOUNTERS}`);
  expect(snap.tripSeed).toBe(ENCOUNTER_BASE_SEED);
  expect(query(page).get('seed')).toBe(TEST_TRIP_SEED);
  expect(errors).toEqual([]);
});

test('a malformed ?seed falls back to a random seed, shown in the URL, without errors', async ({ page }) => {
  const errors = collectErrors(page);
  for (const bad of ['not-a-seed', '123456789', '']) {
    const snap = await open(page, `${APP_PATH}?seed=${encodeURIComponent(bad)}&${NO_ENCOUNTERS}`);
    const shown = query(page).get('seed');
    expect(shown, `?seed=${bad}`).toMatch(/^[0-9a-f]{8}$/);
    expect(shown, `?seed=${bad}`).toBe(formatTripSeed(snap.tripSeed));
    expect(snap.frames).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test('a copied URL replays the trip: the same first encounter, a planet', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  // Encounters come within about a second, flown from the top speed.
  const search = `encounterInterval=1&arrivalSpeed=${FAST_ENCOUNTERS_ARRIVAL_SPEED}`;
  const firstEncounter = async (url: string) => {
    await open(page, url);
    await page.waitForFunction(
      () => {
        const snap = window.__elsewhere!.snapshot();
        return snap.planet !== null || snap.nebula !== null;
      },
      undefined,
      { timeout: 60_000 },
    );
    const snap = await page.evaluate(() => window.__elsewhere!.snapshot());
    return {
      tripSeed: snap.tripSeed,
      index: snap.autopilot.encounterIndex,
      kind: snap.autopilot.kind,
      side: snap.autopilot.side,
      seed: snap.planet?.seed ?? snap.nebula?.seed,
      type: snap.planet?.type ?? null,
      radius: snap.planet?.radius ?? snap.nebula?.radius,
    };
  };
  const first = await firstEncounter(`${APP_PATH}?${search}`);
  const copied = page.url();
  expect(new URL(copied).searchParams.get('seed')).toBe(formatTripSeed(first.tripSeed));
  const replay = await firstEncounter(copied);
  expect(replay).toEqual(first);
  expect(first.index).toBe(0);
  expect(first.kind).toBe('planet');
  expect(errors).toEqual([]);
});
