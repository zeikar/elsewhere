/**
 * The app URL for e2e specs. Every load without `?seed=` is a new random trip (src/tripSeed.ts), so
 * specs load the app through `appUrl`, which pins the documented test default trip seed
 * (ENCOUNTER_BASE_SEED: an oceanic planet first, then a nebula, then a planet and a nebula, then an
 * asteroid, then a comet) unless the query already sets one. That keeps the suite deterministic.
 * e2e/tripSeed.spec.ts loads the bare APP_PATH on purpose, to check the random seed.
 */
import { ENCOUNTER_BASE_SEED } from '../src/config';
import { TRIP_SEED_PARAM, formatTripSeed } from '../src/tripSeed';

/** The site's base path (vite.config.ts `base`). */
export const APP_PATH = '/elsewhere/';

/** The test default trip seed as it appears in the URL (`91b3a5ba`). */
export const TEST_TRIP_SEED = formatTripSeed(ENCOUNTER_BASE_SEED);

/**
 * APP_PATH with the query `search` (with or without its leading `?`), plus `seed=TEST_TRIP_SEED`
 * when `search` does not set a seed.
 */
export function appUrl(search = ''): string {
  const query = new URLSearchParams(search);
  if (!query.has(TRIP_SEED_PARAM)) query.append(TRIP_SEED_PARAM, TEST_TRIP_SEED);
  return `${APP_PATH}?${query.toString()}`;
}
