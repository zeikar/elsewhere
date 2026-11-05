/**
 * Trip seed: one 32-bit seed per load that every encounter is derived from (encounter `i` uses the
 * appearance seed `hash(tripSeed, i)`, which sets its kind, appearance, side, elevation and the
 * cruise before it; see engine/Autopilot.ts). It is the engine's `tripSeed` option.
 *
 * - Without `?seed=`, a load draws a random trip seed (`crypto.getRandomValues`), so every load is a
 *   new trip.
 * - `?seed=<value>` replays that trip. It works in production builds; it is not an e2e-only override.
 * - After load the URL shows the active seed (`history.replaceState`), so copying the URL replays it.
 *
 * Format: 8 hexadecimal digits, lowercase and zero-padded (`91b3a5ba`), which is the whole uint32
 * range. On input, 1–8 hex digits in either case are accepted (surrounding whitespace is ignored),
 * so `?seed=1` and `?seed=00000001` are the same trip. Anything else (empty, too long, not hex) is
 * malformed and falls back to a random seed without error, and the URL then shows that seed.
 *
 * No DOM access besides `showTripSeedInUrl`, and the random source can be injected, so the rest is
 * unit-tested in Node.
 */

/** Name of the query parameter that holds the trip seed. */
export const TRIP_SEED_PARAM = 'seed';

/** A random source returning a uint32 (values are taken `>>> 0`). */
export type RandomUint32 = () => number;

const SEED_PATTERN = /^[0-9a-f]{1,8}$/i;

/** A uniformly random uint32 from `crypto.getRandomValues`, or from `Math.random` where that is missing. */
export function cryptoRandomUint32(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint32Array(1))[0]! >>> 0;
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/** The trip seed as it appears in the URL: 8 lowercase hex digits, zero-padded. */
export function formatTripSeed(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0');
}

/** Parses a `?seed=` value (see the module comment for the format); `null` when missing or malformed. */
export function parseTripSeed(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!SEED_PATTERN.test(trimmed)) return null;
  return Number.parseInt(trimmed, 16) >>> 0;
}

export interface TripSeed {
  /** The trip seed, a uint32. */
  seed: number;
  /** Where it came from: a valid `?seed=` in the URL, or the random source. */
  source: 'url' | 'random';
}

/**
 * The trip seed for a load with query string `search`: the `?seed=` value when it is valid, else a
 * fresh draw from `random` (missing or malformed `?seed=`).
 */
export function resolveTripSeed(search: string, random: RandomUint32 = cryptoRandomUint32): TripSeed {
  const parsed = parseTripSeed(new URLSearchParams(search).get(TRIP_SEED_PARAM));
  if (parsed !== null) return { seed: parsed, source: 'url' };
  return { seed: random() >>> 0, source: 'random' };
}

/**
 * `href` with its `seed` query parameter set to `seed` (formatted), keeping the path, the other
 * parameters and the hash. Replaces any existing `seed` value, valid or not. The query is
 * re-serialised by URLSearchParams, so the other parameters keep their meaning but not always their
 * spelling: `%20` becomes `+`, and a bare `flag` becomes `flag=`.
 */
export function urlWithTripSeed(href: string, seed: number): string {
  const url = new URL(href);
  url.searchParams.set(TRIP_SEED_PARAM, formatTripSeed(seed));
  return url.href;
}

/**
 * Shows the active trip seed in the address bar with `history.replaceState` (no new history entry,
 * no reload). A browser that refuses (for example a sandboxed frame) leaves the URL as it was.
 */
export function showTripSeedInUrl(
  seed: number,
  location: Pick<Location, 'href'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): void {
  try {
    const next = urlWithTripSeed(location.href, seed);
    if (next !== location.href) history.replaceState(history.state, '', next);
  } catch {
    // The seed still drives the trip; only the shareable URL is missing.
  }
}
