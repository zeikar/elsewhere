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
 * `stepTravel` is that step, and is what the engine runs each frame. The user's speed setting goes
 * through `setCruiseSpeed`, which scales the whole speed profile rather than overriding it.
 *
 * Heading: `planEncounter` assumes the ship holds the planned heading. Shrinking the drift
 * amplitudes would turn the heading back toward -Z and move the path sideways, eating into the
 * clearance. Instead the autopilot slows the ship's drift clock to a stop over the end of the
 * cruise, plans the encounter along the now still heading, holds it through APPROACH and FLYBY, and
 * restarts the clock gradually in DEPARTURE. The heading continues from where it stopped, so it
 * never jumps, and the ship flies the planned straight line past the planet.
 *
 * Kinds (docs/PLAN.md section 6, Nebulae): each encounter is a planet or a nebula, chosen from its
 * appearance seed `hash(baseSeed, index)` (`encounterKind`). Both are planned with `planEncounter`
 * and held the same way; a nebula uses its own `D`, side offset and speed and fade profile
 * (`AutopilotParams.nebula`), and its encounter radius is its core radius (see config.ts, Nebulae).
 */
import {
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_MIN_SPEED_FLOOR,
  ENCOUNTER_NEBULA_SHARE,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  NEBULA_DESPAWN_DISTANCE,
  NEBULA_ENCOUNTER_DISTANCE,
  NEBULA_FADE_IN_DISTANCE,
  NEBULA_FADE_OUT_DISTANCE,
  NEBULA_MIN_SPEED,
  NEBULA_MIN_SPEED_DISTANCE,
  NEBULA_RANGES,
  NEBULA_SIDE_OFFSET_FACTOR,
  NEBULA_SLOWDOWN_DISTANCE,
  NEBULA_SPEEDUP_DISTANCE,
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
import { clampDt, createShipState, updateShip, type ShipParams, type ShipState } from './Ship';

export type TravelState = 'CRUISE' | 'APPROACH' | 'FLYBY' | 'DEPARTURE';

/** What an encounter meets. */
export type EncounterKind = 'planet' | 'nebula';

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

/**
 * The nebula met in an encounter. Only the core radius here (the encounter radius, see config.ts,
 * Nebulae); `nebulaParams` in Nebula.ts extends it and plugs in through `AutopilotParams.nebulaFor`.
 */
export interface NebulaSpec {
  /** Core radius in world units. */
  radius: number;
}

/** Placeholder nebula choice: every nebula has the middle of the configured core radius range. */
export function defaultNebula(_seed: number): NebulaSpec {
  return { radius: (NEBULA_RANGES.radius[0] + NEBULA_RANGES.radius[1]) / 2 };
}

interface ActiveEncounterBase {
  /** Encounter index, counted from 0 since load. */
  index: number;
  /** Appearance seed: `hash(baseSeed, index)`. */
  seed: number;
  /** Planned path and object position (`plan.radius` is the planet's or the nebula's radius). */
  plan: Encounter;
}

export interface PlanetEncounter extends ActiveEncounterBase {
  kind: 'planet';
  /** The planet chosen for this seed. */
  planet: PlanetSpec;
}

export interface NebulaEncounter extends ActiveEncounterBase {
  kind: 'nebula';
  /** The nebula chosen for this seed. */
  nebula: NebulaSpec;
}

export type ActiveEncounter = PlanetEncounter | NebulaEncounter;

/** How a kind of encounter is planned and flown. */
export interface EncounterKindParams {
  /** `D`: how far ahead the object is placed, which is also the spawn distance. */
  encounterDistance: number;
  /** `k`: the closest approach to the object's centre is `radius × k`. */
  sideOffsetFactor: number;
  /** Speed and fade profile; its despawn distance also ends DEPARTURE. */
  profile: Readonly<EncounterProfile>;
}

/** The nebula speed and fade profile, tuned for the default cruise speed. */
export const NEBULA_ENCOUNTER_PROFILE: Readonly<EncounterProfile> = {
  minSpeed: NEBULA_MIN_SPEED,
  slowdownDistance: NEBULA_SLOWDOWN_DISTANCE,
  minSpeedDistance: NEBULA_MIN_SPEED_DISTANCE,
  speedupDistance: NEBULA_SPEEDUP_DISTANCE,
  fadeInDistance: NEBULA_FADE_IN_DISTANCE,
  spawnScale: 1,
  fadeOutDistance: NEBULA_FADE_OUT_DISTANCE,
  despawnDistance: NEBULA_DESPAWN_DISTANCE,
};

export interface AutopilotParams {
  /** Speed outside encounters, in world units per second; the encounter speed profile scales from it. */
  cruiseSpeed: number;
  /** Seconds of cruise before each encounter starts (the encounter interval). */
  interval: number;
  /** Seconds at the end of the cruise over which the heading drift eases to a stop. */
  driftSettleTime: number;
  /** Remaining distance at which APPROACH becomes FLYBY. */
  flybyDistance: number;
  /** `D` for planets: how far ahead the planet is placed, which is also the spawn distance. */
  encounterDistance: number;
  /** `k` for planets: the closest approach to the planet centre is `radius × k`. */
  sideOffsetFactor: number;
  /** Planet speed and fade profile; its despawn distance also ends DEPARTURE. */
  profile: Readonly<EncounterProfile>;
  /** Base seed for encounter appearance seeds. */
  baseSeed: number;
  /** Chooses the planet for an encounter seed. Called once when each planet encounter starts. */
  planetFor: (seed: number) => PlanetSpec;
  /** Share of encounters that are nebulae, in [0, 1] (0: planets only, 1: nebulae only). */
  nebulaShare: number;
  /** How nebula encounters are planned and flown. */
  nebula: Readonly<EncounterKindParams>;
  /** Chooses the nebula for an encounter seed. Called once when each nebula encounter starts. */
  nebulaFor: (seed: number) => NebulaSpec;
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
  nebulaShare: ENCOUNTER_NEBULA_SHARE,
  nebula: {
    encounterDistance: NEBULA_ENCOUNTER_DISTANCE,
    sideOffsetFactor: NEBULA_SIDE_OFFSET_FACTOR,
    profile: NEBULA_ENCOUNTER_PROFILE,
  },
  nebulaFor: defaultNebula,
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

/** Salt for the kind hash, independent of the side angle and of the seeded appearance. */
const KIND_SALT = 0x6b1d;

/**
 * The kind of the encounter with appearance seed `seed` (`hash(baseSeed, index)`): a nebula with
 * probability `nebulaShare`, otherwise a planet. Pure and deterministic.
 */
export function encounterKind(seed: number, nebulaShare: number): EncounterKind {
  return hashUnit(seed, KIND_SALT) < nebulaShare ? 'nebula' : 'planet';
}

/** The speed and fade profile in use for an encounter of `kind`. */
export function encounterProfile(params: Readonly<AutopilotParams>, kind: EncounterKind): Readonly<EncounterProfile> {
  return kind === 'nebula' ? params.nebula.profile : params.profile;
}

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
 *   distance), so transition lateness does not add up over encounters. A small O(dt) difference per
 *   encounter remains, because the target speed is updated only once per frame.
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
  let travel = state.state;
  let cruiseTime = state.cruiseTime;
  let encounterCount = state.encounterCount;
  let encounter = state.encounter;

  if (travel === 'CRUISE') {
    cruiseTime += dt;
    if (cruiseTime >= params.interval) {
      const index = encounterCount;
      const seed = hash(params.baseSeed, index);
      const sideAngle = 2 * Math.PI * hashUnit(seed, SIDE_ANGLE_SALT);
      if (encounterKind(seed, params.nebulaShare) === 'nebula') {
        const nebula = params.nebulaFor(seed);
        const { encounterDistance, sideOffsetFactor } = params.nebula;
        const plan = planEncounter(ship.position, ship.heading, nebula.radius, encounterDistance, sideOffsetFactor, sideAngle);
        encounter = { kind: 'nebula', index, seed, nebula, plan };
      } else {
        const planet = params.planetFor(seed);
        const { encounterDistance, sideOffsetFactor } = params;
        const plan = planEncounter(ship.position, ship.heading, planet.radius, encounterDistance, sideOffsetFactor, sideAngle);
        encounter = { kind: 'planet', index, seed, planet, plan };
      }
      encounterCount = index + 1;
      // How late this encounter starts. The plan stays at the ship's actual position; the next CRUISE
      // is shortened by this instead.
      cruiseTime = Math.min(cruiseTime - params.interval, dt);
      travel = 'APPROACH';
    }
  }

  let remaining = Number.POSITIVE_INFINITY;
  if (encounter !== null) {
    const profile = encounterProfile(params, encounter.kind);
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
    const profile = encounterProfile(params, encounter.kind);
    out.fade = encounterOpacity(encounter.plan, remaining, profile);
    out.targetSpeed = encounterTargetSpeed(remaining, params.cruiseSpeed, profile);
    out.driftRate = travel === 'DEPARTURE' ? smoothstep(0, -profile.despawnDistance, remaining) : 0;
  }
  return out;
}

/**
 * Sets the cruise speed (the user's speed setting) without overriding the encounter speed profile:
 * the profile is tuned for `base.cruiseSpeed`, and every speed in it is multiplied by
 * `cruiseSpeed / base.cruiseSpeed`, so an encounter slows down by the same proportion at every speed
 * level. Distances are untouched, so the fades, the transitions and the planned path are unchanged
 * and a change in the middle of an encounter never makes it skip a state. Allocates the new profile.
 *
 * The scaled minimum speed is floored at ENCOUNTER_MIN_SPEED_FLOOR, so the slowest levels (the
 * reduced-motion start) slow down proportionally less instead of crawling through the flyby; it is
 * also capped at the cruise speed, so an encounter never speeds the ship up. Planet and nebula
 * profiles are both scaled this way.
 */
export function setCruiseSpeed(
  params: AutopilotParams,
  cruiseSpeed: number,
  base: Readonly<AutopilotParams> = DEFAULT_AUTOPILOT_PARAMS,
): void {
  const factor = base.cruiseSpeed > 0 ? cruiseSpeed / base.cruiseSpeed : 1;
  const scaled = (profile: Readonly<EncounterProfile>): EncounterProfile => ({
    ...profile,
    minSpeed: Math.min(cruiseSpeed, Math.max(profile.minSpeed * factor, ENCOUNTER_MIN_SPEED_FLOOR)),
  });
  params.cruiseSpeed = cruiseSpeed;
  params.profile = scaled(base.profile);
  params.nebula = { ...params.nebula, profile: scaled(base.nebula.profile) };
}

/** Everything the simulation step advances: the ship, the autopilot and the params they feed each other. */
export interface Travel {
  ship: ShipState;
  shipParams: ShipParams;
  autopilot: AutopilotState;
  autopilotParams: AutopilotParams;
}

/**
 * Creates a travel simulation at rest, in CRUISE, with the ship params taken from the autopilot so
 * the first step already follows it. `shipParams` supplies the drift settings (and the speed time
 * constant); its target speed and drift rate are replaced.
 */
export function createTravel(autopilotParams: AutopilotParams, shipParams: Readonly<ShipParams>): Travel {
  const autopilot = createAutopilotState(autopilotParams);
  const params: ShipParams = { ...shipParams, targetSpeed: autopilot.targetSpeed, driftRate: autopilot.driftRate };
  return { ship: createShipState({}, params), shipParams: params, autopilot, autopilotParams };
}

/**
 * The simulation step (docs/PLAN.md section 6, Time and speed): advances the ship by `dt` seconds,
 * then the autopilot from the new ship state, and feeds the autopilot's target speed and drift rate
 * into the ship params for the next step. Updates `travel` in place and allocates nothing except the
 * plan made when an encounter starts. A zero `dt` (the first frame after a resume) changes nothing
 * but the ship params, which then follow any speed change made meanwhile.
 */
export function stepTravel(travel: Travel, dt: number): void {
  const { ship, shipParams, autopilot, autopilotParams } = travel;
  updateShip(ship, dt, shipParams, ship);
  updateAutopilot(autopilot, ship, dt, autopilotParams, autopilot);
  shipParams.targetSpeed = autopilot.targetSpeed;
  shipParams.driftRate = autopilot.driftRate;
}
