import { describe, expect, it } from 'vitest';
import { ENCOUNTER_ARRIVAL_SPEED, ENCOUNTER_DISTANCE, SHIP_SPEED_LEVELS } from '../config';
import { asteroidParams } from './Asteroid';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  PLANET_VIEW_RADIUS_FACTOR,
  createTravel,
  encounterCruiseSpeed,
  encounterProfile,
  setCruiseSpeed,
  stepTravel,
  type ActiveEncounter,
  type AutopilotParams,
} from './Autopilot';
import { cometParams } from './Comet';
import { DEFAULT_ENCOUNTER_PROFILE, farStretchMinRoom } from './encounter';
import { nebulaParams } from './Nebula';
import { planetParams } from './Planet';
import { mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS } from './Ship';

/** Encounters flown per trip. */
const ENCOUNTERS = 4;

/** Distance past the end of each far stretch (or past the spawn, without one) the ship is measured to. */
const PAST_END = 200;

/**
 * The shortest far stretch (`farStretchMinRoom`), the same at every level: about 1,480 units.
 */
const MIN_ROOM = farStretchMinRoom(ENCOUNTER_ARRIVAL_SPEED, DEFAULT_ENCOUNTER_PROFILE);

/** The far stretch's length for the encounter seed `seed` before the minimum (see `shortRoomPlanet`). */
const shortRoom = (seed: number) => 2 * MIN_ROOM * mulberry32(seed)();

/**
 * A planet, with no ring or atmosphere extent, whose far-stretch threshold (its view sphere at
 * ENCOUNTER_FAR_MAX_ANGLE_DEG) lies `room` past its spawn, before the minimum is applied: drawn from a
 * seeded `room` between 0 and twice the minimum, so short stretches (left out) and stretches just
 * long enough are both flown many times.
 */
function shortRoomPlanet(seed: number, params: Readonly<AutopilotParams>): { radius: number } {
  const room = shortRoom(seed);
  const sinHalf = Math.sin(DEFAULT_ENCOUNTER_PROFILE.farMaxAngle / 2);
  const end = ENCOUNTER_DISTANCE - room;
  return { radius: end / Math.sqrt((PLANET_VIEW_RADIUS_FACTOR / sinHalf) ** 2 - params.sideOffsetFactor ** 2) };
}

interface Sweep {
  /** Encounters flown, and those with a far stretch. */
  encounters: number;
  far: number;
  /** Largest ship jerk (units per second cubed) from the spawn to PAST_END past the far stretch's end. */
  jerk: number;
  /** Largest step in the target speed across a spawn. */
  spawnStep: number;
  /** Every far stretch's length. */
  rooms: number[];
  /** Seeds of the encounters flown. */
  seeds: number[];
}

/**
 * Flies the first ENCOUNTERS encounters of each trip in `trips` at speed level `level` and step
 * `dt`, as the engine does (`stepTravel`), and measures the ship from each spawn to PAST_END past the
 * end of its far stretch: its largest jerk, from the speed change of the step across the spawn on,
 * and the step in the target speed at the spawn.
 */
function sweep(level: number, dt: number, trips: readonly number[], overrides: (params: AutopilotParams) => Partial<AutopilotParams>): Sweep {
  const result: Sweep = { encounters: 0, far: 0, jerk: 0, spawnStep: 0, rooms: [], seeds: [] };
  for (const trip of trips) {
    const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, baseSeed: (trip * 2654435761) >>> 0 };
    Object.assign(params, overrides(params));
    setCruiseSpeed(params, level);
    const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
    let done = 0;
    let prevSpeed = travel.ship.speed;
    let prevAccel = 0;
    let prevTarget = travel.autopilot.targetSpeed;
    let measured: ActiveEncounter | null = null;
    let seen: ActiveEncounter | null = null;
    for (let i = 0; done < ENCOUNTERS && i < 3000 / dt; i++) {
      stepTravel(travel, dt);
      const { ship, autopilot } = travel;
      const accel = (ship.speed - prevSpeed) / dt;
      if (measured !== null) {
        result.jerk = Math.max(result.jerk, Math.abs(accel - prevAccel) / dt);
        const room = measured.farRoom ?? 0;
        if (autopilot.encounter !== measured || measured.plan.spawnDistance - autopilot.remaining > room + PAST_END) {
          measured = null;
          done++;
        }
      }
      if (autopilot.encounter !== null && autopilot.encounter !== seen) {
        seen = measured = autopilot.encounter;
        result.encounters++;
        result.seeds.push(seen.seed);
        const room = seen.farRoom ?? 0;
        if (room > 0) {
          result.far++;
          result.rooms.push(room);
        }
        result.spawnStep = Math.max(result.spawnStep, Math.abs(autopilot.targetSpeed - prevTarget));
      }
      prevTarget = autopilot.targetSpeed;
      prevSpeed = ship.speed;
      prevAccel = accel;
    }
    expect(done, `trip ${trip}`).toBe(ENCOUNTERS);
  }
  return result;
}

/** Trips 1–12, and trip 33, whose short far stretch (72 units) stepped the ship's acceleration before the minimum. */
const REAL_TRIPS = [...Array.from({ length: 12 }, (_, i) => i + 1), 33];

/** Trips of planets with short and just long enough far stretches (`shortRoomPlanet`). */
const SHORT_TRIPS = Array.from({ length: 12 }, (_, i) => 101 + i);

const realObjects = (): Partial<AutopilotParams> => ({ planetFor: planetParams, nebulaFor: nebulaParams, asteroidFor: asteroidParams, cometFor: cometParams });

const shortPlanets = (params: AutopilotParams): Partial<AutopilotParams> => ({
  nebulaShare: 0,
  asteroidShare: 0,
  cometShare: 0,
  planetFor: (seed) => shortRoomPlanet(seed, params),
});

describe('the far stretch in flight', () => {
  // Measured: the ship's jerk peaks at about 6.7 units per second cubed (a stretch just over the
  // minimum, at the default level), 4.8 at the top level and 0.25 at the slowest, at every step, and
  // the target speed steps by under 2e-5 across a spawn. Before the minimum, a short stretch (trip
  // 33's, 72 units) reached 66 at the default level, and 52, 81 and 162 at the top level at dt 1/30,
  // 1/60 and 1/120, with a 2.7 unit-per-second step in the target at its spawn.
  const cases = SHIP_SPEED_LEVELS.flatMap((level) => [1 / 30, 1 / 60, 1 / 120].map((dt) => ({ level, dt })));

  it.each(cases)(
    'at level $level (dt $dt), from the spawn to 200 units past the end of every far stretch, short ones included, the ship’s jerk stays under 10 and the target speed never steps',
    ({ level, dt }) => {
      for (const [label, trips, overrides] of [
        ['real objects', REAL_TRIPS, realObjects],
        ['short stretches', SHORT_TRIPS, shortPlanets],
      ] as const) {
        const result = sweep(level, dt, trips, overrides);
        expect(result.encounters, label).toBe(trips.length * ENCOUNTERS);
        expect(result.jerk, label).toBeLessThan(10);
        expect(result.spawnStep, label).toBeLessThan(0.01);
        // No stretch is shorter than the whole fall from the far speed.
        for (const room of result.rooms) expect(room, label).toBeGreaterThanOrEqual(MIN_ROOM);
        if (label === 'real objects') {
          expect(result.far, label).toBeGreaterThan(trips.length * 2);
        } else {
          // Both sides of the minimum are flown: stretches left out, and stretches just long enough.
          const rooms = result.seeds.map(shortRoom);
          expect(rooms.filter((room) => room > 0 && room < MIN_ROOM).length, label).toBeGreaterThan(10);
          expect(rooms.filter((room) => room >= MIN_ROOM && room < 1.5 * MIN_ROOM).length, label).toBeGreaterThan(5);
          expect(result.far, label).toBe(rooms.filter((room) => room >= MIN_ROOM).length);
        }
      }
    },
  );

  it('the shortest far stretch is the same at every level', () => {
    for (const level of SHIP_SPEED_LEVELS) {
      const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS };
      setCruiseSpeed(params, level);
      for (const kind of ['planet', 'asteroid', 'comet'] as const) {
        expect(farStretchMinRoom(encounterCruiseSpeed(params), encounterProfile(params, kind))).toBeCloseTo(MIN_ROOM, 9);
      }
    }
  });
});
