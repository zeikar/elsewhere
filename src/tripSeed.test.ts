import { describe, expect, it } from 'vitest';
import { ENCOUNTER_BASE_SEED } from './config';
import { DEFAULT_AUTOPILOT_PARAMS, createTravel, stepTravel, type EncounterKind } from './engine/Autopilot';
import { nebulaParams } from './engine/Nebula';
import { planetParams } from './engine/Planet';
import { DEFAULT_SHIP_PARAMS } from './engine/Ship';
import {
  TRIP_SEED_PARAM,
  cryptoRandomUint32,
  formatTripSeed,
  parseTripSeed,
  resolveTripSeed,
  showTripSeedInUrl,
  urlWithTripSeed,
} from './tripSeed';

/** What a viewer sees of one encounter: its kind, look and placement. */
interface SeenEncounter {
  index: number;
  kind: EncounterKind;
  /** Planet type (`rocky` or `gas`), or `nebula`. */
  type: string;
  family: string;
  palette: unknown;
  side: string;
  /** Object centre relative to where the encounter was planned. */
  offset: { x: number; y: number; z: number };
  /** Ship time at which the encounter started, in seconds. */
  start: number;
}

/**
 * Flies the first `count` encounters of the trip with seed `tripSeed`, as the engine does (its
 * planet and nebula choosers, at the default speed level), and lists what each one was.
 */
function flyTrip(tripSeed: number, count: number): SeenEncounter[] {
  const travel = createTravel(
    { ...DEFAULT_AUTOPILOT_PARAMS, baseSeed: tripSeed, planetFor: planetParams, nebulaFor: nebulaParams },
    DEFAULT_SHIP_PARAMS,
  );
  const seen: SeenEncounter[] = [];
  let state = travel.autopilot.state;
  for (let step = 0; seen.length < count; step++) {
    if (step > 60 * 60 * 30) throw new Error(`trip ${formatTripSeed(tripSeed)}: too few encounters`);
    stepTravel(travel, 1 / 60);
    const { autopilot } = travel;
    if (autopilot.state === 'APPROACH' && state === 'CRUISE') {
      const e = autopilot.encounter!;
      const look = e.kind === 'planet' ? planetParams(e.seed) : nebulaParams(e.seed);
      seen.push({
        index: e.index,
        kind: e.kind,
        type: e.kind === 'planet' ? planetParams(e.seed).type : 'nebula',
        family: look.family,
        palette: look.palette,
        side: e.side,
        offset: { ...e.plan.offset },
        start: travel.ship.time,
      });
    }
    state = autopilot.state;
  }
  return seen;
}

/** A fake random source that returns `values` in turn. */
function fakeRandom(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('trip seed format', () => {
  it('formats a seed as 8 lowercase hex digits, zero-padded, and parses it back', () => {
    expect(formatTripSeed(ENCOUNTER_BASE_SEED)).toBe('91b3a5ba');
    expect(formatTripSeed(0)).toBe('00000000');
    expect(formatTripSeed(1)).toBe('00000001');
    expect(formatTripSeed(0xffff_ffff)).toBe('ffffffff');
    for (const seed of [0, 1, 0xabc, ENCOUNTER_BASE_SEED, 0x8000_0000, 0xffff_ffff]) {
      expect(parseTripSeed(formatTripSeed(seed))).toBe(seed);
    }
  });

  it('accepts 1–8 hex digits in either case, with surrounding whitespace', () => {
    expect(parseTripSeed('91B3A5BA')).toBe(ENCOUNTER_BASE_SEED);
    expect(parseTripSeed(' 91b3a5ba ')).toBe(ENCOUNTER_BASE_SEED);
    expect(parseTripSeed('1')).toBe(1);
    expect(parseTripSeed('00000001')).toBe(1);
    expect(parseTripSeed('ff')).toBe(255);
  });

  it('rejects missing and malformed values', () => {
    for (const value of [null, '', ' ', 'xyz', '91b3a5bg', '123456789', '0x91b3a5ba', '-1', '+1', '12 34', '1.5', 'ffffffffff']) {
      expect(parseTripSeed(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('resolveTripSeed', () => {
  it('a valid ?seed= is used as is, without drawing', () => {
    const random = () => {
      throw new Error('drew a random seed');
    };
    expect(resolveTripSeed('?seed=91b3a5ba', random)).toEqual({ seed: ENCOUNTER_BASE_SEED, source: 'url' });
    expect(resolveTripSeed('encounterInterval=1&seed=00000001', random)).toEqual({ seed: 1, source: 'url' });
  });

  it('a missing or malformed ?seed= falls back to a random seed, without error', () => {
    for (const search of ['', '?', '?seed', '?seed=', '?seed=nothex', '?seed=123456789', '?seed=zz&seed=12', '?seed=%E0%A4%A', '?%zz']) {
      expect(resolveTripSeed(search, fakeRandom(0x1234_5678)), search).toEqual({ seed: 0x1234_5678, source: 'random' });
    }
    // The random source's value is taken as a uint32.
    expect(resolveTripSeed('', fakeRandom(-1)).seed).toBe(0xffff_ffff);
  });

  it('the default random source gives uint32 seeds that differ between loads', () => {
    const seeds = Array.from({ length: 16 }, () => resolveTripSeed('').seed);
    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffff_ffff);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
    expect(Number.isInteger(cryptoRandomUint32())).toBe(true);
  });
});

describe('trips', () => {
  it('two loads without ?seed fly different encounter sequences', () => {
    // Two loads with an injected random source that draws a different value each time.
    const random = fakeRandom(0x0bad_cafe, 0x7e57_5eed);
    const a = resolveTripSeed('', random);
    const b = resolveTripSeed('', random);
    expect(a.source).toBe('random');
    expect(b.source).toBe('random');
    expect(a.seed).not.toBe(b.seed);
    const tripA = flyTrip(a.seed, 4);
    const tripB = flyTrip(b.seed, 4);
    expect(tripA).not.toEqual(tripB);
    // Each encounter differs in look as well as in placement.
    for (let i = 0; i < 4; i++) {
      expect(tripA[i]!.palette, `encounter ${i}`).not.toEqual(tripB[i]!.palette);
      expect(tripA[i]!.offset, `encounter ${i}`).not.toEqual(tripB[i]!.offset);
    }
  });

  it('loading with ?seed=X replays the same kinds, planet types, palettes and placements', () => {
    for (const value of ['91b3a5ba', '0badcafe', '7e575eed']) {
      const first = resolveTripSeed(`?seed=${value}`, fakeRandom(1));
      const again = resolveTripSeed(`?encounterKind=&seed=${value.toUpperCase()}`, fakeRandom(2));
      expect(first).toEqual({ seed: parseTripSeed(value), source: 'url' });
      expect(again).toEqual(first);
      const trip = flyTrip(first.seed, 5);
      expect(flyTrip(again.seed, 5), value).toEqual(trip);
      expect(trip.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('the test default trip seed opens with an oceanic planet, a nebula, a planet and a nebula', () => {
    const trip = flyTrip(ENCOUNTER_BASE_SEED, 4);
    expect(trip.map((e) => e.kind)).toEqual(['planet', 'nebula', 'planet', 'nebula']);
    expect(trip[0]!.family).toBe('oceanic');
  });
});

describe('the seed in the URL', () => {
  it('sets ?seed= to the formatted seed, keeping the path, the other parameters and the hash', () => {
    expect(urlWithTripSeed('https://zeikar.dev/elsewhere/', ENCOUNTER_BASE_SEED)).toBe('https://zeikar.dev/elsewhere/?seed=91b3a5ba');
    expect(urlWithTripSeed('https://zeikar.dev/elsewhere/?a=1#x', 1)).toBe('https://zeikar.dev/elsewhere/?a=1&seed=00000001#x');
    expect(urlWithTripSeed('https://zeikar.dev/elsewhere/?seed=nothex&a=1', 0xff)).toBe(
      'https://zeikar.dev/elsewhere/?seed=000000ff&a=1',
    );
    expect(new URL(urlWithTripSeed('http://localhost/', 0xdead_beef)).searchParams.get(TRIP_SEED_PARAM)).toBe('deadbeef');
  });

  it('shows the active seed with history.replaceState, and does nothing when it is already shown', () => {
    const calls: unknown[][] = [];
    const history = { state: { kept: true }, replaceState: (...args: unknown[]) => void calls.push(args) };
    showTripSeedInUrl(ENCOUNTER_BASE_SEED, { href: 'https://zeikar.dev/elsewhere/' }, history);
    expect(calls).toEqual([[{ kept: true }, '', 'https://zeikar.dev/elsewhere/?seed=91b3a5ba']]);
    showTripSeedInUrl(ENCOUNTER_BASE_SEED, { href: 'https://zeikar.dev/elsewhere/?seed=91b3a5ba' }, history);
    expect(calls).toHaveLength(1);
  });

  it('a browser that refuses replaceState leaves the URL as it was, without error', () => {
    const history = {
      state: null,
      replaceState: () => {
        throw new DOMException('refused', 'SecurityError');
      },
    };
    expect(() => showTripSeedInUrl(1, { href: 'https://zeikar.dev/elsewhere/' }, history)).not.toThrow();
    expect(() => showTripSeedInUrl(1, { href: 'not a url' }, history)).not.toThrow();
  });
});
