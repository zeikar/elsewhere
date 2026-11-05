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
 * Warp (docs/PLAN.md section 1): cruise is the warp, and an encounter is flown at the arrival speed.
 * Every encounter is flown as if the cruise speed were `encounterCruiseSpeed` (min(cruise speed,
 * arrival speed)). Above the arrival speed the ship drops out of warp at the end of the cruise,
 * before the object spawns, and eases back into warp at the start of the next one
 * (`cruiseTargetSpeed`), so the encounter itself is the same at every speed level at or above the
 * arrival speed. Both eases are cruise time and count toward the encounter interval.
 *
 * Speed driven by visibility (docs/PLAN.md section 9, Phase 4; config.ts, VIEW_WIDEST_ASPECT): after
 * the closest approach, DEPARTURE ends as soon as the object is out of view at the widest supported
 * aspect ratio (`encounterViewMargin`; wider screens narrow the vertical field of view, so it holds on
 * every screen), or at the profile's despawn distance if that comes first. The
 * next cruise eases the target speed up from where the encounter left it, and the heading drift
 * likewise, so neither jumps. Until the object is out of view nothing changes: the target speed is
 * the distance-based profile throughout the encounter.
 *
 * Heading: `planEncounter` assumes the ship holds the planned heading. Shrinking the drift
 * amplitudes would turn the heading back toward -Z and move the path sideways, eating into the
 * clearance. Instead the autopilot slows the ship's drift clock to a stop over the end of the
 * cruise, plans the encounter along the now still heading, holds it through APPROACH and FLYBY, and
 * restarts the clock gradually in DEPARTURE. The heading continues from where it stopped, so it
 * never jumps, and the ship flies the planned straight line past the planet.
 *
 * Kinds (docs/PLAN.md section 6, Nebulae): each encounter is a planet or a nebula, chosen from its
 * appearance seed `hash(baseSeed, index)` (`encounterKindAt`), except that the first encounter of
 * every trip is a planet (docs/PLAN.md section 9, Phase 2: within about 30–60 s a planet appears),
 * whatever the base seed (the trip seed, random on each load in production). Both are planned with
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
  CAMERA_FOV_DEG,
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
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
  ENCOUNTER_WARP_ENTRY_MAX_RATE,
  ENCOUNTER_WARP_ENTRY_SECONDS,
  ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  ENCOUNTER_WARP_EXIT_SECONDS,
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
  VIEW_WIDEST_ASPECT,
} from '../config';
import {
  DEFAULT_ENCOUNTER_PROFILE,
  angleBetween,
  encounterOffset,
  encounterOpacity,
  encounterRemaining,
  encounterTargetSpeed,
  planEncounter,
  smoothstep,
  sphereViewMargin,
  viewConeHalfAngle,
  type Encounter,
  type EncounterProfile,
} from './encounter';
import { hash, hashUnit } from './seed';
import { clampDt, createShipState, updateShip, type ShipParams, type ShipState, type Vec3 } from './Ship';

export type TravelState = 'CRUISE' | 'APPROACH' | 'FLYBY' | 'DEPARTURE';

/** What an encounter meets. */
export type EncounterKind = 'planet' | 'nebula';

/** Which side of the planned path the encounter object sits on, seen along the path. */
export type EncounterSide = 'left' | 'right';

/**
 * The planet met in an encounter: what the plan needs of it. Seeded planet parameters (type,
 * palette, …, `planetParams` in Planet.ts) extend this and replace `defaultPlanet` through
 * `AutopilotParams.planetFor`.
 */
export interface PlanetSpec {
  /** Planet radius in world units. */
  radius: number;
  /**
   * `k` for this planet: the closest approach to its centre is `radius × k`. Without it the planet
   * passes at `AutopilotParams.sideOffsetFactor`. Raised where needed to clear the extent
   * (`planetPassFactor`).
   */
  passFactor?: number;
  /**
   * Everything drawn for the planet beyond its atmosphere, a ring, lies within `radius × extent` of
   * its centre. Without it (or below PLANET_VIEW_RADIUS_FACTOR) the atmosphere bounds the planet.
   */
  extent?: number;
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
  /** Speed outside encounters (the warp), in world units per second. */
  cruiseSpeed: number;
  /**
   * Highest speed an encounter is flown from, in world units per second: encounters are flown as if
   * the cruise speed were `encounterCruiseSpeed`, min(cruiseSpeed, this), and the encounter speed
   * profile scales from that (`setCruiseSpeed`). `Infinity` flies them from the cruise speed.
   */
  arrivalSpeed: number;
  /** Seconds over which the target speed eases down from the cruise speed to the arrival speed (warp exit). */
  warpExitTime: number;
  /** Seconds before the encounter starts at which the warp exit has ended. */
  warpExitLead: number;
  /**
   * Seconds at the start of each cruise over which the target speed eases back up to the cruise speed
   * (warp entry), at least; see `warpEntryMaxRate`.
   */
  warpEntryTime: number;
  /**
   * Steepest slope of the warp entry, in units per second per second: an entry from further below the
   * cruise speed (an encounter that ended out of view, near its minimum speed) is stretched beyond
   * `warpEntryTime` until no steeper than this. `Infinity` never stretches it.
   */
  warpEntryMaxRate: number;
  /**
   * Half-angle, in radians, of the cone around the camera's forward axis that holds the view at the
   * widest supported aspect ratio (`viewConeHalfAngle`). After the closest approach, an encounter ends
   * once its object is outside it (`encounterViewMargin`). π or more never ends one early: DEPARTURE
   * then lasts to the despawn distance, as it did before Phase 4.
   */
  viewHalfAngle: number;
  /**
   * Mean seconds of cruise before each encounter starts (the encounter interval). The warp entry,
   * exit and lead are part of the cruise, so they count toward it.
   */
  interval: number;
  /** Seeded jitter on each cruise, as a fraction of `interval`, in [0, 1] (see `cruiseInterval`). */
  intervalJitter: number;
  /** Seconds at the end of the cruise over which the heading drift eases to a stop. */
  driftSettleTime: number;
  /** Remaining distance at which APPROACH becomes FLYBY. */
  flybyDistance: number;
  /** `D` for planets: how far ahead the planet is placed, which is also the spawn distance. */
  encounterDistance: number;
  /**
   * `k` for planets with no pass factor of their own (`PlanetSpec.passFactor`): the closest approach
   * to the planet centre is `radius × k`.
   */
  sideOffsetFactor: number;
  /** Planet speed and fade profile; its despawn distance also ends DEPARTURE. */
  profile: Readonly<EncounterProfile>;
  /**
   * Base seed for encounter appearance seeds: the trip seed. The engine draws it at random on each
   * load (or takes it from `?seed=`); the default, ENCOUNTER_BASE_SEED, is the test default.
   */
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
  arrivalSpeed: ENCOUNTER_ARRIVAL_SPEED,
  warpExitTime: ENCOUNTER_WARP_EXIT_SECONDS,
  warpExitLead: ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  warpEntryTime: ENCOUNTER_WARP_ENTRY_SECONDS,
  warpEntryMaxRate: ENCOUNTER_WARP_ENTRY_MAX_RATE,
  viewHalfAngle: viewConeHalfAngle(CAMERA_FOV_DEG, VIEW_WIDEST_ASPECT),
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
  /**
   * How far the encounter object is out of view (`encounterViewMargin`): positive once it is, zero or
   * negative while it may be in view; `-Infinity` with no encounter.
   */
  viewMargin: number;
  /**
   * Target speed the latest encounter ended at, which the cruise after it eases up from
   * (`cruiseTargetSpeed`); `Infinity` before the first encounter.
   */
  entrySpeed: number;
  /** Drift rate the latest encounter ended at, which the cruise after it eases up from; 1 before the first. */
  entryDrift: number;
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
 * The kind of encounter `index` (appearance seed `seed`): a planet for the first encounter of the
 * trip (index 0), so a planet comes first for every base seed, and `nextEncounterKind` after that.
 * Only a nebula share of 1 (every encounter a nebula) overrides the planet first.
 */
export function encounterKindAt(
  index: number,
  seed: number,
  params: Pick<AutopilotParams, 'nebulaShare' | 'maxSameKindRun'>,
  lastKind: EncounterKind | null,
  run: number,
): EncounterKind {
  if (index === 0 && params.nebulaShare < 1) return 'planet';
  return nextEncounterKind(seed, params, lastKind, run);
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
    const kind = encounterKindAt(index, seed, params, lastKind, run);
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
 * Drift rate after `cruiseTime` seconds of a cruise lasting `interval`, starting from `entryDrift`
 * (the rate the encounter before it ended at; 1 for the first cruise and after an encounter that ran
 * to its despawn distance): easing (smoothstep) up from `entryDrift` to 1 over the first
 * `driftSettleTime` seconds, and down to 0 over the last `driftSettleTime` seconds before the
 * encounter starts, whichever is lower. The settle time is capped at the interval, so with an entry
 * rate of 1 the rate is 1 when a cruise begins and the drift never stalls or restarts abruptly.
 */
function cruiseDriftRate(cruiseTime: number, interval: number, params: Readonly<AutopilotParams>, entryDrift = 1): number {
  const settle = Math.min(params.driftSettleTime, interval);
  if (!(settle > 0)) return cruiseTime >= interval ? 0 : 1;
  const resume = entryDrift < 1 ? entryDrift + (1 - entryDrift) * smoothstep(0, settle, cruiseTime) : 1;
  return Math.min(resume, smoothstep(interval, interval - settle, cruiseTime));
}

/**
 * The speed an encounter is flown from, in world units per second: the cruise speed, or the arrival
 * speed when the cruise is faster (dropping out of warp). The encounter speed profile is scaled for
 * it (`setCruiseSpeed`) and returns to it after the closest approach.
 */
export function encounterCruiseSpeed(params: Readonly<Pick<AutopilotParams, 'cruiseSpeed' | 'arrivalSpeed'>>): number {
  return Math.min(params.cruiseSpeed, params.arrivalSpeed);
}

/**
 * Seconds the warp entry takes from `entrySpeed` up to the cruise speed: `warpEntryTime`, stretched
 * until the smoothstep's steepest slope (1.5 × the rise / the time) is at most `warpEntryMaxRate`.
 */
export function warpEntryDuration(
  params: Readonly<Pick<AutopilotParams, 'cruiseSpeed' | 'warpEntryTime' | 'warpEntryMaxRate'>>,
  entrySpeed: number,
): number {
  const rise = params.cruiseSpeed - entrySpeed;
  const stretched = rise > 0 && params.warpEntryMaxRate > 0 ? (1.5 * rise) / params.warpEntryMaxRate : 0;
  return Math.max(params.warpEntryTime, stretched);
}

/**
 * Target speed after `cruiseTime` seconds of a cruise lasting `interval`; `afterEncounter` tells
 * whether the cruise follows an encounter (every cruise but the first, from load), and `entrySpeed`
 * is the target speed that encounter ended at (by default `encounterCruiseSpeed`, where an encounter
 * that runs to its despawn distance ends).
 *
 * After an encounter, the target starts at the entry speed (capped at the cruise speed) and eases
 * (smoothstep) up to the cruise speed over `warpEntryDuration` (back into warp); the first cruise has
 * no encounter to return from (the ship accelerates from rest at load), so it starts at the cruise
 * speed. Above the arrival speed, from `warpExitLead + warpExitTime` before the encounter starts, it
 * then eases back down to the arrival speed, which it reaches `warpExitLead` before the encounter
 * starts (out of warp). Where the two eases overlap (a short cruise) the lower one applies, so the
 * target is continuous and never jumps, it never reaches the cruise speed, and it is still at the
 * arrival speed from `warpExitLead` before the encounter starts (throughout, for a cruise no longer
 * than that). An entry from below the arrival speed (an encounter that ended out of view) is cut
 * short to end by then too, so the next encounter still starts at the arrival speed; only a cruise
 * no longer than the lead (shorter than any configured interval) starts it at the arrival speed at
 * once.
 *
 * Continuous with the encounter's target speed at both ends: an encounter starts at
 * `encounterCruiseSpeed` (see `encounterTargetSpeed`) and ends at the entry speed.
 */
export function cruiseTargetSpeed(
  cruiseTime: number,
  interval: number,
  params: Readonly<AutopilotParams>,
  afterEncounter: boolean,
  entrySpeed: number = encounterCruiseSpeed(params),
): number {
  const cruise = params.cruiseSpeed;
  const arrival = encounterCruiseSpeed(params);
  const exitEnd = interval - params.warpExitLead;
  let target = cruise;
  const from = afterEncounter ? Math.min(entrySpeed, cruise) : cruise;
  if (from < cruise) {
    let entryTime = warpEntryDuration(params, from);
    if (from < arrival) entryTime = Math.min(entryTime, Math.max(0, exitEnd));
    target = entryTime > 0 ? from + (cruise - from) * smoothstep(0, entryTime, cruiseTime) : cruise;
  }
  if (cruise > arrival) {
    const exitTime = params.warpExitTime;
    const exit = exitTime > 0 ? smoothstep(exitEnd, exitEnd - exitTime, cruiseTime) : cruiseTime >= exitEnd ? 0 : 1;
    target = Math.min(target, arrival + (cruise - arrival) * exit);
  }
  return target;
}

/**
 * Everything drawn for a planet with no extent of its own (no ring) lies within this many radii of its
 * centre (config.ts, Planets).
 */
export const PLANET_VIEW_RADIUS_FACTOR = 1 + ENCOUNTER_CLEARANCE_MARGIN;

/**
 * Everything drawn for `planet` lies within this many radii of its centre: its extent (a ring's outer
 * radius) or PLANET_VIEW_RADIUS_FACTOR (the atmosphere), whichever is larger. The out-of-view test
 * uses this sphere, so a ring leaves the view with its planet.
 */
export function planetViewRadiusFactor(planet: Readonly<PlanetSpec>): number {
  return Math.max(PLANET_VIEW_RADIUS_FACTOR, planet.extent ?? 0);
}

/**
 * The `k` an encounter with `planet` is planned with: the planet's own pass factor, or
 * `sideOffsetFactor` without one, raised to at least `extent × (1 + ENCOUNTER_CLEARANCE_MARGIN)`. The
 * path then never comes within `radius × extent × (1 + margin)` of the centre, so it never meets a
 * ring, whatever the ring's tilt (docs/PLAN.md section 6, Variety: the camera never passes through a
 * ring).
 */
export function planetPassFactor(planet: Readonly<PlanetSpec>, sideOffsetFactor: number): number {
  return Math.max(planet.passFactor ?? sideOffsetFactor, (planet.extent ?? 0) * (1 + ENCOUNTER_CLEARANCE_MARGIN));
}

/**
 * Bounds on where a nebula's layers reach, in world units, for a nebula of core radius `radius`
 * planned `closestDistance` from the path (`radius × k`), from NEBULA_RANGES (so they hold for every
 * seed): `depth`, how far past the nebula centre along the path any point of any layer lies (the
 * layers' depth spread plus a tilted square's reach along the path), and `lateral`, how far from the
 * path line any point lies (the path's offset plus the layers' offset from the nebula axis plus a
 * square's half-diagonal).
 */
export function nebulaViewExtent(radius: number, closestDistance: number): { depth: number; lateral: number } {
  const { depthSpread, layerSize, layerOffset, tilt } = NEBULA_RANGES;
  const halfDiagonal = Math.SQRT2 * layerSize[1];
  // A layer's normal leans at most acos(cos²(tilt)) off the path (two tilts of up to `tilt`), so a
  // point of the square reaches at most its half-diagonal × sin(lean) along the path.
  const lean = Math.acos(Math.cos(tilt[1]) ** 2);
  return {
    depth: radius * (depthSpread[1] + halfDiagonal * Math.sin(lean)),
    lateral: closestDistance + radius * (layerOffset[1] + halfDiagonal),
  };
}

const viewScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * How far the encounter's object is out of view (config.ts, VIEW_WIDEST_ASPECT) with the ship at
 * `ship` (its position and heading, the camera's forward axis) and the view inside the cone of
 * half-angle `halfAngle`: positive once it is out of view, zero or negative while it may be in view.
 * `remaining` is the ship's remaining distance (`encounterRemaining`). Pure and allocation-free.
 *
 * - Planet: `sphereViewMargin` of the sphere of `radius × planetViewRadiusFactor(planet)` (the
 *   atmosphere, or the ring), in radians.
 * - Nebula: in world units, how far the ship is past every layer (`-(remaining + depth)`, from
 *   `nebulaViewExtent`), and only once the heading has not turned so far from the planned direction
 *   that the cone could reach a layer: every point of a layer is then at least
 *   π/2 + atan(past / lateral) from the planned direction, so at least that minus the heading's turn
 *   from the forward axis, which must exceed `halfAngle`.
 */
export function encounterViewMargin(
  encounter: Readonly<ActiveEncounter>,
  ship: Readonly<ShipState>,
  halfAngle: number,
  remaining: number = encounterRemaining(encounter.plan, ship.position),
): number {
  const { plan } = encounter;
  if (encounter.kind === 'planet') {
    const offset = encounterOffset(plan, ship.position, viewScratch);
    return sphereViewMargin(offset, ship.heading, plan.radius * planetViewRadiusFactor(encounter.planet), halfAngle);
  }
  const { depth, lateral } = nebulaViewExtent(plan.radius, plan.closestDistance);
  const past = -(remaining + depth);
  if (!(past > 0)) return past;
  const nearest = Math.PI / 2 + Math.atan(past / lateral);
  return nearest - angleBetween(ship.heading, plan.direction) > halfAngle ? past : 0;
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
    viewMargin: Number.NEGATIVE_INFINITY,
    entrySpeed: Number.POSITIVE_INFINITY,
    entryDrift: 1,
    fade: 0,
    targetSpeed: cruiseTargetSpeed(0, cruiseInterval(params, 0), params, false),
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
 *   the kind `encounterKindAt` picks and on the side `encounterSide` picks, and moves to APPROACH.
 * - A transition fires on the first step past its threshold, up to one step late. That overshoot is
 *   carried into the next CRUISE (the time past the interval, plus the time since passing the despawn
 *   distance), so transition lateness does not add up over encounters. A small O(dt) difference per
 *   encounter remains, because the target speed is updated only once per frame.
 * - APPROACH becomes FLYBY once the remaining distance is at most `flybyDistance`, FLYBY becomes
 *   DEPARTURE once the closest approach is passed (remaining ≤ 0), and DEPARTURE returns to CRUISE
 *   as soon as the object is out of view (`encounterViewMargin` > 0), or once the ship is the
 *   profile's despawn distance past it, where the fade has reached 0, whichever comes first, but
 *   never on the step that reached DEPARTURE: every encounter spends at least one step in it (a
 *   planet passed far off can be out of view at its closest approach already). An object out of view
 *   is removed whatever its fade, which no one sees.
 * - The lateness carried from the end of DEPARTURE is the time since the first of those held: since
 *   the despawn distance was passed, or since both the closest approach was passed and the view
 *   margin turned positive (interpolated between the last two steps), up to two steps.
 * - The target speed follows the encounter speed profile from `encounterCruiseSpeed`, and is
 *   `cruiseTargetSpeed` in CRUISE: after an encounter, the return to warp from the target speed the
 *   encounter ended at, and the drop out of warp at the end of the cruise when the cruise speed is
 *   above the arrival speed.
 * - The drift rate eases to 0 at the end of CRUISE, stays 0 through APPROACH and FLYBY, and eases
 *   back toward 1 over DEPARTURE as the ship recedes (reaching 1 at the despawn distance), then on
 *   to 1 at the start of CRUISE from wherever DEPARTURE left it.
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
  let entrySpeed = state.entrySpeed;
  let entryDrift = state.entryDrift;
  let viewMargin = Number.NEGATIVE_INFINITY;

  if (travel === 'CRUISE') {
    cruiseTime += dt;
    const interval = cruiseInterval(params, encounterCount);
    if (cruiseTime >= interval) {
      const index = encounterCount;
      const seed = hash(params.baseSeed, index);
      const kind = encounterKindAt(index, seed, params, lastKind, kindRun);
      const { side, sideAngle } = encounterSide(seed, params.sideElevation);
      if (kind === 'nebula') {
        const nebula = params.nebulaFor(seed);
        const { encounterDistance, sideOffsetFactor } = params.nebula;
        const plan = planEncounter(ship.position, ship.heading, nebula.radius, encounterDistance, sideOffsetFactor, sideAngle);
        encounter = { kind: 'nebula', index, seed, side, nebula, plan };
      } else {
        const planet = params.planetFor(seed);
        const k = planetPassFactor(planet, params.sideOffsetFactor);
        const plan = planEncounter(ship.position, ship.heading, planet.radius, params.encounterDistance, k, sideAngle);
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
    // Only the step that started the encounter has no margin of its own from the step before.
    const prevMargin = state.encounter === encounter ? state.viewMargin : Number.NEGATIVE_INFINITY;
    viewMargin = encounterViewMargin(encounter, ship, params.viewHalfAngle, remaining);
    // DEPARTURE lasts at least one step: a planet passed far off (a large k) can already be out of
    // view at its closest approach, and the step that reaches DEPARTURE keeps it, so every encounter
    // shows the whole cycle. That step's time is carried with the rest of the lateness below.
    if (travel === 'DEPARTURE' && state.state === 'DEPARTURE' && state.encounter === encounter) {
      // How long ago DEPARTURE could have ended, by each rule; -Infinity where it cannot yet. At most
      // two steps: the one before may have been the one held.
      const cap = 2 * dt;
      let late = Number.NEGATIVE_INFINITY;
      if (remaining <= -profile.despawnDistance) {
        // Time since the ship passed the despawn distance.
        const past = ship.speed > 0 ? (-profile.despawnDistance - remaining) / ship.speed : 0;
        late = Math.min(past, cap);
      }
      if (viewMargin > 0) {
        // Out of view after the closest approach: since the later of passing it and leaving the view
        // (before the step before this one when it was already out of view then: the step held).
        const sincePass = ship.speed > 0 ? -remaining / ship.speed : 0;
        const sinceView = prevMargin > 0 ? cap : (dt * viewMargin) / (viewMargin - prevMargin);
        late = Math.max(late, Math.min(sincePass, sinceView, cap));
      }
      if (late > Number.NEGATIVE_INFINITY) {
        // Carried with the encounter's late start. The next cruise eases up from where this ends.
        cruiseTime += late;
        entrySpeed = encounterTargetSpeed(remaining, encounterCruiseSpeed(params), profile);
        entryDrift = smoothstep(0, -profile.despawnDistance, remaining);
        travel = 'CRUISE';
        encounter = null;
        remaining = Number.POSITIVE_INFINITY;
        viewMargin = Number.NEGATIVE_INFINITY;
      }
    }
  }

  out.state = travel;
  out.cruiseTime = cruiseTime;
  out.encounterCount = encounterCount;
  out.lastKind = lastKind;
  out.kindRun = kindRun;
  out.encounter = encounter;
  out.remaining = remaining;
  out.viewMargin = viewMargin;
  out.entrySpeed = entrySpeed;
  out.entryDrift = entryDrift;
  if (encounter === null) {
    const interval = cruiseInterval(params, encounterCount);
    out.fade = 0;
    out.targetSpeed = cruiseTargetSpeed(cruiseTime, interval, params, encounterCount > 0, entrySpeed);
    out.driftRate = cruiseDriftRate(cruiseTime, interval, params, encounterCount > 0 ? entryDrift : 1);
  } else {
    const profile = encounterProfile(params, encounter.kind);
    out.fade = encounterOpacity(encounter.plan, remaining, profile);
    out.targetSpeed = encounterTargetSpeed(remaining, encounterCruiseSpeed(params), profile);
    out.driftRate = travel === 'DEPARTURE' ? smoothstep(0, -profile.despawnDistance, remaining) : 0;
  }
  return out;
}

/**
 * Sets the cruise speed (the user's speed setting) without overriding the encounter speed profile:
 * the profile is tuned for `base.cruiseSpeed`, and every speed in it is multiplied by
 * `encounterSpeed / base.cruiseSpeed`, where `encounterSpeed` is the speed encounters are flown from
 * at the new cruise speed (`encounterCruiseSpeed`: min(cruise speed, `params.arrivalSpeed`)). Below
 * the arrival speed an encounter slows down by the same proportion at every speed level; at or above
 * it, the ship drops out of warp first and every level flies the profile scaled for the arrival
 * speed (the base profile itself when the arrival speed is the base cruise speed, as by default).
 * Distances are untouched, so the fades, the transitions and the planned path are unchanged and a
 * change in the middle of an encounter never makes it skip a state. Allocates the new profile.
 *
 * The scaled minimum speed is floored at the profile's `minSpeedFloor` (ENCOUNTER_MIN_SPEED_FLOOR
 * for planets, NEBULA_MIN_SPEED_FLOOR for nebulae), so the slowest levels (the reduced-motion start)
 * slow down proportionally less instead of crawling through the flyby; it is also capped at the
 * encounter speed, so an encounter never speeds the ship up. Planet and nebula profiles are both
 * scaled this way.
 */
export function setCruiseSpeed(
  params: AutopilotParams,
  cruiseSpeed: number,
  base: Readonly<AutopilotParams> = DEFAULT_AUTOPILOT_PARAMS,
): void {
  const encounterSpeed = encounterCruiseSpeed({ cruiseSpeed, arrivalSpeed: params.arrivalSpeed });
  const factor = base.cruiseSpeed > 0 ? encounterSpeed / base.cruiseSpeed : 1;
  const scaled = (profile: Readonly<EncounterProfile>): EncounterProfile => ({
    ...profile,
    minSpeed: Math.min(encounterSpeed, Math.max(profile.minSpeed * factor, profile.minSpeedFloor)),
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
