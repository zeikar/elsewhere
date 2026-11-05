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
 * appearance seed `hash(baseSeed, index)` (`nextEncounterKind`). Both are planned with
 * `planEncounter` and held the same way; a nebula uses its own `D`, side offset and speed and fade
 * profile (`AutopilotParams.nebula`), and its encounter radius is its core radius (see config.ts,
 * Nebulae).
 *
 * Variety (docs/PLAN.md section 9, Phase 3), all drawn from the appearance seed by pure functions:
 * the cruise before each encounter is the interval with a seeded jitter (`cruiseInterval`, whose
 * mean is the configured interval), no more than `maxSameKindRun` encounters of one kind come in a
 * row (`nextEncounterKind`), and the object sits to the left or right of the path at a seeded
 * elevation (`encounterSide`). `encounterSchedule` lists what the autopilot will meet.
 */
import {
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_JITTER,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_MAX_SAME_KIND_RUN,
  ENCOUNTER_NEBULA_SHARE,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_ELEVATION_RANGE,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  NEBULA_DESPAWN_DISTANCE,
  NEBULA_ENCOUNTER_DISTANCE,
  NEBULA_FADE_IN_DISTANCE,
  NEBULA_FADE_OUT_DISTANCE,
  NEBULA_MIN_SPEED,
  NEBULA_MIN_SPEED_DISTANCE,
  NEBULA_MIN_SPEED_FLOOR,
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

/** Which side of the planned path the encounter object sits on, seen along the path. */
export type EncounterSide = 'left' | 'right';

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
  /** Side of the path the object sits on (`encounterSide`). */
  side: EncounterSide;
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
  minSpeedFloor: NEBULA_MIN_SPEED_FLOOR,
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
  /** Mean seconds of cruise before each encounter starts (the encounter interval). */
  interval: number;
  /** Seeded jitter on each cruise, as a fraction of `interval`, in [0, 1] (see `cruiseInterval`). */
  intervalJitter: number;
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
  /** Most encounters of one kind in a row (an integer ≥ 1; `Infinity` for no limit). */
  maxSameKindRun: number;
  /** Range of the object's elevation above or below the path, in radians (see `encounterSide`). */
  sideElevation: readonly [number, number];
  /** How nebula encounters are planned and flown. */
  nebula: Readonly<EncounterKindParams>;
  /** Chooses the nebula for an encounter seed. Called once when each nebula encounter starts. */
  nebulaFor: (seed: number) => NebulaSpec;
}

export const DEFAULT_AUTOPILOT_PARAMS: Readonly<AutopilotParams> = {
  cruiseSpeed: SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL],
  interval: ENCOUNTER_INTERVAL_SECONDS,
  intervalJitter: ENCOUNTER_INTERVAL_JITTER,
  driftSettleTime: ENCOUNTER_DRIFT_SETTLE_SECONDS,
  flybyDistance: ENCOUNTER_FLYBY_DISTANCE,
  encounterDistance: ENCOUNTER_DISTANCE,
  sideOffsetFactor: ENCOUNTER_SIDE_OFFSET_FACTOR,
  profile: DEFAULT_ENCOUNTER_PROFILE,
  baseSeed: ENCOUNTER_BASE_SEED,
  planetFor: defaultPlanet,
  nebulaShare: ENCOUNTER_NEBULA_SHARE,
  maxSameKindRun: ENCOUNTER_MAX_SAME_KIND_RUN,
  sideElevation: ENCOUNTER_SIDE_ELEVATION_RANGE,
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
  /** Kind of the latest encounter started, or `null` before the first. */
  lastKind: EncounterKind | null;
  /** How many encounters of `lastKind` in a row ended with the latest one (0 before the first). */
  kindRun: number;
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

/** Salts for values drawn from the appearance seed, independent of each other and of the appearance. */
const ELEVATION_SALT = 0x51de;
const KIND_SALT = 0x6b1d;
const SIDE_SALT = 0x5e1d;
const INTERVAL_SALT = 0x1e7a;

/**
 * The seeded kind draw for appearance seed `seed` (`hash(baseSeed, index)`): a nebula with
 * probability `nebulaShare`, otherwise a planet. Pure and deterministic. The autopilot draws with
 * the share `kindDrawShare` gives and caps same-kind runs (`nextEncounterKind`).
 */
export function encounterKind(seed: number, nebulaShare: number): EncounterKind {
  return hashUnit(seed, KIND_SALT) < nebulaShare ? 'nebula' : 'planet';
}

/** Whether `maxRun` caps runs at all (a finite count of at least 1). */
function capsRuns(maxRun: number): boolean {
  return Number.isFinite(maxRun) && maxRun >= 1;
}

/**
 * Long-run share of nebulae when each encounter is drawn a nebula with probability `drawShare` and
 * runs of one kind are cut at `maxRun` (the next encounter is the other kind). A run of a kind that
 * repeats with probability `s` has mean length `(1 - s^maxRun) / (1 - s)`, and runs alternate.
 */
export function cappedNebulaShare(drawShare: number, maxRun: number): number {
  if (!(drawShare > 0)) return 0;
  if (!(drawShare < 1)) return 1;
  if (!capsRuns(maxRun)) return drawShare;
  const n = Math.floor(maxRun);
  const nebulaRun = (1 - drawShare ** n) / (1 - drawShare);
  const planetRun = (1 - (1 - drawShare) ** n) / drawShare;
  return nebulaRun / (nebulaRun + planetRun);
}

/**
 * The draw share that, with runs capped at `maxRun`, gives a long-run nebula share of `nebulaShare`
 * (the inverse of `cappedNebulaShare`, which increases with the draw share; found by bisection).
 * With runs capped at `n` the long-run share can only lie in [1 / (n + 1), n / (n + 1)]; a share
 * outside that gets the nearest end. Pure and allocation-free.
 */
export function kindDrawShare(nebulaShare: number, maxRun: number): number {
  if (!(nebulaShare > 0)) return 0;
  if (!(nebulaShare < 1)) return 1;
  if (!capsRuns(maxRun)) return nebulaShare;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    if (cappedNebulaShare(mid, maxRun) < nebulaShare) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * The kind of the encounter with appearance seed `seed`, given the kind of the latest encounter and
 * how many of that kind came in a row (`run`). The seeded draw (`encounterKind` with
 * `kindDrawShare`), except that it is the other kind when the draw would make the run longer than
 * `params.maxSameKindRun`. A share of 0 or 1 forces one kind and ignores the cap.
 */
export function nextEncounterKind(
  seed: number,
  params: Pick<AutopilotParams, 'nebulaShare' | 'maxSameKindRun'>,
  lastKind: EncounterKind | null,
  run: number,
): EncounterKind {
  const { nebulaShare, maxSameKindRun } = params;
  if (!(nebulaShare > 0)) return 'planet';
  if (!(nebulaShare < 1)) return 'nebula';
  const kind = encounterKind(seed, kindDrawShare(nebulaShare, maxSameKindRun));
  if (kind === lastKind && capsRuns(maxSameKindRun) && run >= Math.floor(maxSameKindRun)) {
    return kind === 'nebula' ? 'planet' : 'nebula';
  }
  return kind;
}

/**
 * Seconds of cruise before the encounter with appearance seed `seed`: `interval × (1 + jitter × u)`,
 * with `u` uniform in [-1, 1) from the seed, so the mean is `interval`. The jitter is clamped to
 * [0, 1], so the result is never negative.
 */
export function cruiseIntervalFor(seed: number, interval: number, jitter: number): number {
  const j = Math.min(1, Math.max(0, jitter));
  return interval * (1 + j * (2 * hashUnit(seed, INTERVAL_SALT) - 1));
}

/** Seconds of cruise before encounter `index` starts (`cruiseIntervalFor` its appearance seed). */
export function cruiseInterval(
  params: Pick<AutopilotParams, 'baseSeed' | 'interval' | 'intervalJitter'>,
  index: number,
): number {
  return cruiseIntervalFor(hash(params.baseSeed, index), params.interval, params.intervalJitter);
}

/**
 * Where the encounter with appearance seed `seed` sits beside the path: the left or right side
 * (even odds), and the `sideAngle` for `planEncounter`, which rotates the right of the path toward
 * up by that angle. The elevation (drawn from `elevation`, radians, positive up) is measured from
 * level with the path on either side: `sideAngle` is the elevation on the right and π − elevation
 * on the left.
 */
export function encounterSide(
  seed: number,
  elevation: readonly [number, number] = ENCOUNTER_SIDE_ELEVATION_RANGE,
): { side: EncounterSide; elevation: number; sideAngle: number } {
  const side: EncounterSide = hashUnit(seed, SIDE_SALT) < 0.5 ? 'right' : 'left';
  const e = elevation[0] + (elevation[1] - elevation[0]) * hashUnit(seed, ELEVATION_SALT);
  return { side, elevation: e, sideAngle: side === 'right' ? e : Math.PI - e };
}

/** One planned encounter, as `encounterSchedule` lists it. */
export interface ScheduledEncounter {
  index: number;
  seed: number;
  kind: EncounterKind;
  side: EncounterSide;
  /** Seconds of cruise before it starts. */
  interval: number;
}

/**
 * The first `count` encounters the autopilot will meet with `params`, from load: what
 * `updateAutopilot` picks for each, computed without simulating travel. Pure.
 */
export function encounterSchedule(params: Readonly<AutopilotParams>, count: number): ScheduledEncounter[] {
  const out: ScheduledEncounter[] = [];
  let lastKind: EncounterKind | null = null;
  let run = 0;
  for (let index = 0; index < count; index++) {
    const seed = hash(params.baseSeed, index);
    const kind = nextEncounterKind(seed, params, lastKind, run);
    run = kind === lastKind ? run + 1 : 1;
    lastKind = kind;
    out.push({ index, seed, kind, side: encounterSide(seed, params.sideElevation).side, interval: cruiseInterval(params, index) });
  }
  return out;
}

/** The speed and fade profile in use for an encounter of `kind`. */
export function encounterProfile(params: Readonly<AutopilotParams>, kind: EncounterKind): Readonly<EncounterProfile> {
  return kind === 'nebula' ? params.nebula.profile : params.profile;
}

/**
 * Drift rate after `cruiseTime` seconds of a cruise lasting `interval`: 1, easing (smoothstep) to 0
 * over the last `driftSettleTime` seconds before the encounter starts. The settle time is capped at
 * the interval, so the rate is always 1 when a cruise begins and the drift never stalls abruptly.
 */
function cruiseDriftRate(cruiseTime: number, interval: number, params: Readonly<AutopilotParams>): number {
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
    lastKind: null,
    kindRun: 0,
    encounter: null,
    remaining: Number.POSITIVE_INFINITY,
    fade: 0,
    targetSpeed: params.cruiseSpeed,
    driftRate: cruiseDriftRate(0, cruiseInterval(params, 0), params),
  };
}

/**
 * Advances the autopilot by `dt` seconds (clamped with `clampDt`, like the ship) given the ship
 * state at the end of that step, and returns the new state.
 *
 * `state` is never modified. The result is written into `out` (a fresh state by default), which may
 * be `state` itself; the only allocation is the plan made when an encounter starts.
 *
 * - CRUISE counts cruise time. Once it reaches the cruise's interval (`cruiseInterval` for the next
 *   index), it plans an encounter along the ship's current heading with the next index and seed, of
 *   the kind `nextEncounterKind` picks and on the side `encounterSide` picks, and moves to APPROACH.
 * - A transition fires on the first step past its threshold, up to one step late. That overshoot is
 *   carried into the next CRUISE (the time past the interval, plus the time since passing the despawn
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
  let lastKind = state.lastKind;
  let kindRun = state.kindRun;
  let encounter = state.encounter;

  if (travel === 'CRUISE') {
    cruiseTime += dt;
    const interval = cruiseInterval(params, encounterCount);
    if (cruiseTime >= interval) {
      const index = encounterCount;
      const seed = hash(params.baseSeed, index);
      const kind = nextEncounterKind(seed, params, lastKind, kindRun);
      const { side, sideAngle } = encounterSide(seed, params.sideElevation);
      if (kind === 'nebula') {
        const nebula = params.nebulaFor(seed);
        const { encounterDistance, sideOffsetFactor } = params.nebula;
        const plan = planEncounter(ship.position, ship.heading, nebula.radius, encounterDistance, sideOffsetFactor, sideAngle);
        encounter = { kind: 'nebula', index, seed, side, nebula, plan };
      } else {
        const planet = params.planetFor(seed);
        const { encounterDistance, sideOffsetFactor } = params;
        const plan = planEncounter(ship.position, ship.heading, planet.radius, encounterDistance, sideOffsetFactor, sideAngle);
        encounter = { kind: 'planet', index, seed, side, planet, plan };
      }
      encounterCount = index + 1;
      kindRun = kind === lastKind ? kindRun + 1 : 1;
      lastKind = kind;
      // How late this encounter starts. The plan stays at the ship's actual position; the next CRUISE
      // is shortened by this instead.
      cruiseTime = Math.min(cruiseTime - interval, dt);
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
  out.lastKind = lastKind;
  out.kindRun = kindRun;
  out.encounter = encounter;
  out.remaining = remaining;
  if (encounter === null) {
    out.fade = 0;
    out.targetSpeed = params.cruiseSpeed;
    out.driftRate = cruiseDriftRate(cruiseTime, cruiseInterval(params, encounterCount), params);
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
 * The scaled minimum speed is floored at the profile's `minSpeedFloor` (ENCOUNTER_MIN_SPEED_FLOOR
 * for planets, NEBULA_MIN_SPEED_FLOOR for nebulae), so the slowest levels (the reduced-motion start)
 * slow down proportionally less instead of crawling through the flyby; it is also capped at the
 * cruise speed, so an encounter never speeds the ship up. Planet and nebula profiles are both scaled
 * this way.
 */
export function setCruiseSpeed(
  params: AutopilotParams,
  cruiseSpeed: number,
  base: Readonly<AutopilotParams> = DEFAULT_AUTOPILOT_PARAMS,
): void {
  const factor = base.cruiseSpeed > 0 ? cruiseSpeed / base.cruiseSpeed : 1;
  const scaled = (profile: Readonly<EncounterProfile>): EncounterProfile => ({
    ...profile,
    minSpeed: Math.min(cruiseSpeed, Math.max(profile.minSpeed * factor, profile.minSpeedFloor)),
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
