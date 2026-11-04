/**
 * Autopilot travel state machine (docs/PLAN.md sections 4, 6 and 9, Phase 2):
 * `CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE`.
 *
 * A pure update with no Three.js or DOM dependencies. Each simulation step, after `updateShip` has
 * advanced the ship, `updateAutopilot` reads the new ship state and returns the travel state, the
 * active encounter and the planet's fade, plus the `targetSpeed` and `driftRate` to copy into the
 * ship's params for the next step:
 *
 * ```ts
 * updateShip(ship, dt, shipParams, ship);
 * updateAutopilot(autopilot, ship, dt, autopilotParams, autopilot);
 * shipParams.targetSpeed = autopilot.targetSpeed;
 * shipParams.driftRate = autopilot.driftRate;
 * ```
 *
 * Heading: `planEncounter` assumes the ship holds the planned heading. Shrinking the drift
 * amplitudes would turn the heading back toward -Z and move the path sideways, eating into the
 * clearance. Instead the autopilot slows the ship's drift clock to a stop over the end of the
 * cruise, plans the encounter along the now still heading, holds it through APPROACH and FLYBY, and
 * restarts the clock gradually in DEPARTURE. The heading continues from where it stopped, so it
 * never jumps, and the ship flies the planned straight line past the planet.
 */
import {
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
} from '../config';
import {
  DEFAULT_ENCOUNTER_PROFILE,
  encounterOpacity,
  encounterRemaining,
  encounterTargetSpeed,
  planEncounter,
  smoothstep,
  type Encounter,
  type EncounterProfile,
} from './encounter';
import { hash, hashUnit } from './seed';
import { clampDt, type ShipState } from './Ship';

export type TravelState = 'CRUISE' | 'APPROACH' | 'FLYBY' | 'DEPARTURE';

/**
 * The planet met in an encounter. Only the radius for now; seeded planet parameters (type,
 * palette, …) extend this and replace `defaultPlanet` through `AutopilotParams.planetFor`.
 */
export interface PlanetSpec {
  /** Planet radius in world units. */
  radius: number;
}

/** Placeholder planet choice until planets are seeded: every planet has the default radius. */
export function defaultPlanet(_seed: number): PlanetSpec {
  return { radius: ENCOUNTER_PLANET_RADIUS };
}

export interface ActiveEncounter {
  /** Encounter index, counted from 0 since load. */
  index: number;
  /** Appearance seed: `hash(baseSeed, index)`. */
  seed: number;
  /** The planet chosen for this seed. */
  planet: PlanetSpec;
  /** Planned path and planet position (`plan.radius` is `planet.radius`). */
  plan: Encounter;
}

export interface AutopilotParams {
  /** Speed outside encounters, in world units per second; the encounter speed profile scales from it. */
  cruiseSpeed: number;
  /** Seconds of cruise before each encounter starts (the encounter interval). */
  interval: number;
  /** Seconds at the end of the cruise over which the heading drift eases to a stop. */
  driftSettleTime: number;
  /** Remaining distance at which APPROACH becomes FLYBY. */
  flybyDistance: number;
  /** `D`: how far ahead the planet is placed, which is also the spawn distance. */
  encounterDistance: number;
  /** `k`: the closest approach to the planet centre is `radius × k`. */
  sideOffsetFactor: number;
  /** Speed and fade profile; its despawn distance also ends DEPARTURE. */
  profile: Readonly<EncounterProfile>;
  /** Base seed for encounter appearance seeds. */
  baseSeed: number;
  /** Chooses the planet for an encounter seed. Called once when each encounter starts. */
  planetFor: (seed: number) => PlanetSpec;
}

export const DEFAULT_AUTOPILOT_PARAMS: Readonly<AutopilotParams> = {
  cruiseSpeed: SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL],
  interval: ENCOUNTER_INTERVAL_SECONDS,
  driftSettleTime: ENCOUNTER_DRIFT_SETTLE_SECONDS,
  flybyDistance: ENCOUNTER_FLYBY_DISTANCE,
  encounterDistance: ENCOUNTER_DISTANCE,
  sideOffsetFactor: ENCOUNTER_SIDE_OFFSET_FACTOR,
  profile: DEFAULT_ENCOUNTER_PROFILE,
  baseSeed: ENCOUNTER_BASE_SEED,
  planetFor: defaultPlanet,
};

export interface AutopilotState {
  state: TravelState;
  /**
   * Seconds spent in the current CRUISE. During an encounter it holds how late (under one frame) the
   * encounter started, which the next CRUISE starts from, so the lateness never adds up over cycles.
   */
  cruiseTime: number;
  /** Encounters started so far, which is also the index the next encounter gets. */
  encounterCount: number;
  /** The encounter in progress, or `null` in CRUISE. */
  encounter: ActiveEncounter | null;
  /** Remaining distance to the closest approach (see encounter.ts); `Infinity` with no encounter. */
  remaining: number;
  /** Planet opacity in [0, 1]; 0 with no encounter. */
  fade: number;
  /** Target speed for the ship's next step, in world units per second. */
  targetSpeed: number;
  /** Drift rate for the ship's next step, in [0, 1]. */
  driftRate: number;
}

/** Salt for the side-angle hash, so it is independent of other values drawn from the same seed. */
const SIDE_ANGLE_SALT = 0x51de;

/**
 * Drift rate after `cruiseTime` seconds of cruise: 1, easing (smoothstep) to 0 over the last
 * `driftSettleTime` seconds before the encounter starts. The settle time is capped at the interval,
 * so the rate is always 1 when a cruise begins and the drift never stalls abruptly.
 */
function cruiseDriftRate(cruiseTime: number, params: Readonly<AutopilotParams>): number {
  const { interval } = params;
  const settle = Math.min(params.driftSettleTime, interval);
  if (!(settle > 0)) return cruiseTime >= interval ? 0 : 1;
  return smoothstep(interval, interval - settle, cruiseTime);
}

/** Starting autopilot state: CRUISE from the beginning, with no encounter yet. */
export function createAutopilotState(params: Readonly<AutopilotParams> = DEFAULT_AUTOPILOT_PARAMS): AutopilotState {
  return {
    state: 'CRUISE',
    cruiseTime: 0,
    encounterCount: 0,
    encounter: null,
    remaining: Number.POSITIVE_INFINITY,
    fade: 0,
    targetSpeed: params.cruiseSpeed,
    driftRate: cruiseDriftRate(0, params),
  };
}

/**
 * Advances the autopilot by `dt` seconds (clamped with `clampDt`, like the ship) given the ship
 * state at the end of that step, and returns the new state.
 *
 * `state` is never modified. The result is written into `out` (a fresh state by default), which may
 * be `state` itself; the only allocation is the plan made when an encounter starts.
 *
 * - CRUISE counts cruise time. Once it reaches `interval`, it plans an encounter along the ship's
 *   current heading with the next index and seed, and moves to APPROACH.
 * - A transition fires on the first step past its threshold, up to one step late. That overshoot is
 *   carried into the next CRUISE (the time past `interval`, plus the time since passing the despawn
 *   distance), so the timeline does not depend on dt and does not drift over many encounters.
 * - APPROACH becomes FLYBY once the remaining distance is at most `flybyDistance`, FLYBY becomes
 *   DEPARTURE once the closest approach is passed (remaining ≤ 0), and DEPARTURE returns to CRUISE
 *   once the ship is the profile's despawn distance past it, where the fade has reached 0.
 * - The target speed follows the encounter speed profile, and is `cruiseSpeed` in CRUISE.
 * - The drift rate eases to 0 at the end of CRUISE, stays 0 through APPROACH and FLYBY, and eases
 *   back to 1 over DEPARTURE as the ship recedes, reaching 1 as CRUISE resumes.
 */
export function updateAutopilot(
  state: Readonly<AutopilotState>,
  ship: Readonly<ShipState>,
  rawDt: number,
  params: Readonly<AutopilotParams> = DEFAULT_AUTOPILOT_PARAMS,
  out: AutopilotState = createAutopilotState(params),
): AutopilotState {
  const dt = clampDt(rawDt);
  const { profile } = params;
  let travel = state.state;
  let cruiseTime = state.cruiseTime;
  let encounterCount = state.encounterCount;
  let encounter = state.encounter;

  if (travel === 'CRUISE') {
    cruiseTime += dt;
    if (cruiseTime >= params.interval) {
      const index = encounterCount;
      const seed = hash(params.baseSeed, index);
      const planet = params.planetFor(seed);
      const sideAngle = 2 * Math.PI * hashUnit(seed, SIDE_ANGLE_SALT);
      const plan = planEncounter(
        ship.position,
        ship.heading,
        planet.radius,
        params.encounterDistance,
        params.sideOffsetFactor,
        sideAngle,
      );
      encounter = { index, seed, planet, plan };
      encounterCount = index + 1;
      // How late this encounter starts. The plan stays at the ship's actual position; the next CRUISE
      // is shortened by this instead.
      cruiseTime = Math.min(cruiseTime - params.interval, dt);
      travel = 'APPROACH';
    }
  }

  let remaining = Number.POSITIVE_INFINITY;
  if (encounter !== null) {
    remaining = encounterRemaining(encounter.plan, ship.position);
    // Fall through, so a step that crosses several thresholds still ends in the right state.
    if (travel === 'APPROACH' && remaining <= params.flybyDistance) travel = 'FLYBY';
    if (travel === 'FLYBY' && remaining <= 0) travel = 'DEPARTURE';
    if (travel === 'DEPARTURE' && remaining <= -profile.despawnDistance) {
      // Time since the ship passed the despawn distance, carried with the encounter's late start.
      const past = ship.speed > 0 ? (-profile.despawnDistance - remaining) / ship.speed : 0;
      cruiseTime += Math.min(past, dt);
      travel = 'CRUISE';
      encounter = null;
      remaining = Number.POSITIVE_INFINITY;
    }
  }

  out.state = travel;
  out.cruiseTime = cruiseTime;
  out.encounterCount = encounterCount;
  out.encounter = encounter;
  out.remaining = remaining;
  if (encounter === null) {
    out.fade = 0;
    out.targetSpeed = params.cruiseSpeed;
    out.driftRate = cruiseDriftRate(cruiseTime, params);
  } else {
    out.fade = encounterOpacity(encounter.plan, remaining, profile);
    out.targetSpeed = encounterTargetSpeed(remaining, params.cruiseSpeed, profile);
    out.driftRate = travel === 'DEPARTURE' ? smoothstep(0, -profile.despawnDistance, remaining) : 0;
  }
  return out;
}
