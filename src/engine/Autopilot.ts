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
 * Speed driven by visibility (docs/PLAN.md section 9, Phase 4; config.ts, VIEW_WIDEST_ASPECT): as
 * soon as the object is wholly off the live camera view (`AutopilotParams.view`, which the engine
 * replaces on every resize; `encounterViewMargin`), before or after the closest approach, the
 * encounter moves on through the rest of its cycle, one state per step, and ends; otherwise DEPARTURE
 * ends at the profile's despawn distance. The next cruise returns to warp from the speed and
 * acceleration the ship had then (the quick entry, `viewEntryDuration`), and the heading drift eases
 * up from where the encounter left it, so neither jumps. Until the object is off screen nothing
 * changes: the target speed is the distance-based profile throughout the encounter. Encounter timing
 * therefore depends on the screen's shape; the schedule (kinds, sides, cruise lengths) does not.
 *
 * The far stretch (config.ts, ENCOUNTER_FAR_SPEED): planets, asteroids and comets spawn far out, and
 * the first part of their approach, while the object is still small, is flown faster
 * (`farStretchTargetSpeed`); the ship is back at the encounter's cruise speed, with no acceleration
 * left, by the time the object's angular diameter reaches the threshold or the slowdown starts,
 * after which the speed profile is exactly what it was. Its length (`farStretchRoom`) and the ship's
 * speed at the spawn (`farStart`) are fixed when the encounter starts. Above the arrival speed the
 * cruise before it drops out of warp only to the speed the far stretch can fall from
 * (`farHandoverSpeed`), so it needs to know the next object before it is planned: the cruise chooses
 * it once (`chooseEncounter`, kept in `AutopilotState.next`), and the encounter starts with that
 * choice.
 *
 * Heading: `planEncounter` assumes the ship holds the planned heading. Shrinking the drift
 * amplitudes would turn the heading back toward -Z and move the path sideways, eating into the
 * clearance. Instead the autopilot slows the ship's drift clock to a stop over the end of the
 * cruise, plans the encounter along the now still heading, holds it through APPROACH and FLYBY, and
 * restarts the clock gradually in DEPARTURE. The heading continues from where it stopped, so it
 * never jumps, and the ship flies the planned straight line past the planet.
 *
 * Kinds (docs/PLAN.md section 6, Nebulae and Variety): each encounter is a planet, a nebula, an
 * asteroid or a comet, chosen from its appearance seed `hash(baseSeed, index)` (`encounterKindAt`),
 * except that the first encounter of every trip is a planet (docs/PLAN.md section 9, Phase 2: within
 * about 30–60 s a planet appears), whatever the base seed (the trip seed, random on each load in
 * production). The planet-or-nebula draw comes first; a second draw, from a stream of its own, then
 * makes some of the planets asteroids, and a third, from another, some of the rest comets
 * (`bodyKind`), so the nebulae are where they were before asteroids and the asteroids where they
 * were before comets. All are planned with `planEncounter` and held the same way; a nebula uses its
 * own `D`, side offset and speed and fade profile (`AutopilotParams.nebula`), and its encounter
 * radius is its core radius (see config.ts, Nebulae); an asteroid likewise (`AutopilotParams.asteroid`),
 * with the bounding radius of its field (config.ts, Asteroids), and a comet
 * (`AutopilotParams.comet`) with its coma's radius (config.ts, Comets).
 *
 * Variety (docs/PLAN.md section 9, Phase 3), all drawn from the appearance seed by pure functions:
 * the cruise before each encounter is the interval with a seeded jitter (`cruiseInterval`, whose
 * mean is the configured interval), no more than `maxSameKindRun` encounters of one kind come in a
 * row (`nextEncounterKind`), and the object sits to the left or right of the path at a seeded
 * elevation (`encounterSide`). `encounterSchedule` lists what the autopilot will meet.
 *
 * Planet variety (docs/PLAN.md section 9, Phase 4): each planet may bring its own pass factor `k`
 * and an extent (a ring's outer radius; `PlanetSpec`). The plan uses `planetPassFactor`, which keeps
 * the path clear of the extent, and the out-of-view test uses a sphere that holds it
 * (`planetViewRadiusFactor`), so a ring is never crossed and leaves the view with its planet.
 */
import {
  ASTEROID_DESPAWN_DISTANCE,
  ASTEROID_ENCOUNTER_DISTANCE,
  ASTEROID_FADE_OUT_DISTANCE,
  ASTEROID_MIN_SPEED,
  ASTEROID_MIN_SPEED_DISTANCE,
  ASTEROID_MIN_SPEED_FLOOR,
  ASTEROID_SIDE_OFFSET_FACTOR,
  ASTEROID_SLOWDOWN_DISTANCE,
  ASTEROID_SPEEDUP_DISTANCE,
  CAMERA_FOV_DEG,
  COMET_DESPAWN_DISTANCE,
  COMET_ENCOUNTER_DISTANCE,
  COMET_FADE_OUT_DISTANCE,
  COMET_MIN_SPEED,
  COMET_MIN_SPEED_DISTANCE,
  COMET_MIN_SPEED_FLOOR,
  COMET_SIDE_OFFSET_FACTOR,
  COMET_SLOWDOWN_DISTANCE,
  COMET_SPEEDUP_DISTANCE,
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_ASTEROID_SHARE,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_COMET_SHARE,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FADE_IN_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_JITTER,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_MAX_SAME_KIND_RUN,
  ENCOUNTER_NEBULA_SHARE,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_ELEVATION_RANGE,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_VIEW_ENTRY_MAX_RATE,
  ENCOUNTER_VIEW_ENTRY_SECONDS,
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
  SHIP_SPEED_TAU_SECONDS,
  VIEW_DEFAULT_ASPECT,
  VIEW_WIDEST_ASPECT,
} from '../config';
import {
  DEFAULT_ENCOUNTER_PROFILE,
  angleBetween,
  encounterOffset,
  encounterOpacity,
  encounterRemaining,
  encounterTargetSpeed,
  farHandoverSpeed,
  farStretchRoom,
  farStretchTargetSpeed,
  frustumConeHalfAngle,
  frustumSphereMargin,
  planEncounter,
  smoothstep,
  type Encounter,
  type EncounterProfile,
} from './encounter';
import { cameraFrustum, type ViewFrustum } from './renderSize';
import { hash, hashUnit } from './seed';
import { clampDt, createShipState, updateShip, type ShipParams, type ShipState, type Vec3 } from './Ship';

export type TravelState = 'CRUISE' | 'APPROACH' | 'FLYBY' | 'DEPARTURE';

/** What an encounter meets. */
export type EncounterKind = 'planet' | 'nebula' | 'asteroid' | 'comet';

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

/**
 * The asteroid met in an encounter: one rock or a small field of them (docs/PLAN.md section 9,
 * Phase 4). `asteroidParams` in Asteroid.ts extends it and plugs in through
 * `AutopilotParams.asteroidFor`.
 */
export interface AsteroidSpec {
  /** Bounding radius of the whole field, about its centre, in world units: every rock lies within it. */
  radius: number;
  /**
   * `k` for this asteroid: the closest approach to the field centre is `radius × k`. Without it the
   * asteroid passes at `AutopilotParams.asteroid.sideOffsetFactor`. Raised where needed to keep the
   * path out of the field's sphere (`asteroidPassFactor`).
   */
  passFactor?: number;
}

/** Placeholder asteroid choice: one rock of radius 10, passed at the default `k`. */
export function defaultAsteroid(_seed: number): AsteroidSpec {
  return { radius: 10 };
}

/**
 * A sphere holding part of what is drawn for a comet (its coma, or a stretch of a tail), for the
 * out-of-view test: its centre relative to the nucleus in the encounter's frame (along the planned
 * path, toward the side the comet sits on, and up: `side × direction`, as for asteroid rocks), and
 * its radius, in world units.
 */
export interface CometBound {
  offset: readonly [number, number, number];
  radius: number;
}

/**
 * The comet met in an encounter (docs/PLAN.md section 9, Phase 4). `cometParams` in Comet.ts extends
 * it and plugs in through `AutopilotParams.cometFor`.
 */
export interface CometSpec {
  /** Coma radius in world units (the encounter radius): the nucleus and the coma lie within it. */
  radius: number;
  /**
   * `k` for this comet: the closest approach to the nucleus is `radius × k`. Without it the comet
   * passes at `AutopilotParams.comet.sideOffsetFactor`; raised to keep the path out of the coma
   * (`cometPassFactor`).
   */
  passFactor?: number;
  /**
   * Spheres that together hold everything drawn for the comet, the coma and both tails
   * (`encounterViewMargin`). Without them the coma's sphere (`radius`) bounds the comet, and the view
   * draws it without tails (`encounterCometParams` in EncounterView.ts).
   */
  bounds?: readonly CometBound[];
}

/** Placeholder comet choice: a coma of radius 30, passed at the default `k`, and no tails. */
export function defaultComet(_seed: number): CometSpec {
  return { radius: 30 };
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
  /**
   * The far stretch's length, in world units travelled from the spawn (`farStretchRoom`); without it
   * (or 0) there is none.
   */
  farRoom?: number;
  /** The ship's speed at the spawn, where the far stretch starts (the encounter's cruise speed without it). */
  farStart?: number;
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

export interface AsteroidEncounter extends ActiveEncounterBase {
  kind: 'asteroid';
  /** The asteroid (one rock or a field) chosen for this seed. */
  asteroid: AsteroidSpec;
}

export interface CometEncounter extends ActiveEncounterBase {
  kind: 'comet';
  /** The comet chosen for this seed. */
  comet: CometSpec;
}

export type ActiveEncounter = PlanetEncounter | NebulaEncounter | AsteroidEncounter | CometEncounter;

/**
 * An encounter's object, chosen for its index before it is planned (`chooseEncounter`): its kind, the
 * spec its chooser gave (`AutopilotParams.planetFor` and the others), and its far stretch's length
 * (`encounterChoiceRoom`), which depends only on the object and the distances of the params.
 */
export type EncounterChoice = { index: number; seed: number; farRoom: number } & (
  | { kind: 'planet'; planet: PlanetSpec }
  | { kind: 'nebula'; nebula: NebulaSpec }
  | { kind: 'asteroid'; asteroid: AsteroidSpec }
  | { kind: 'comet'; comet: CometSpec }
);

/** How a kind of encounter is planned and flown. */
export interface EncounterKindParams {
  /** `D`: how far ahead the object is placed, which is also the spawn distance. */
  encounterDistance: number;
  /** `k`: the closest approach to the object's centre is `radius × k`. */
  sideOffsetFactor: number;
  /** Speed and fade profile; its despawn distance also ends DEPARTURE. */
  profile: Readonly<EncounterProfile>;
}

/**
 * The nebula speed and fade profile, tuned for the default cruise speed. A nebula keeps its own
 * approach: it fades in over a distance, and has no far stretch (config.ts, NEBULA_ENCOUNTER_DISTANCE).
 */
export const NEBULA_ENCOUNTER_PROFILE: Readonly<EncounterProfile> = {
  minSpeed: NEBULA_MIN_SPEED,
  minSpeedFloor: NEBULA_MIN_SPEED_FLOOR,
  slowdownDistance: NEBULA_SLOWDOWN_DISTANCE,
  minSpeedDistance: NEBULA_MIN_SPEED_DISTANCE,
  speedupDistance: NEBULA_SPEEDUP_DISTANCE,
  fadeInDistance: NEBULA_FADE_IN_DISTANCE,
  fadeInTime: 0,
  spawnScale: 1,
  fadeOutDistance: NEBULA_FADE_OUT_DISTANCE,
  despawnDistance: NEBULA_DESPAWN_DISTANCE,
  farSpeed: 0,
  farAccel: 0,
  farMaxAngle: 0,
};

/** The asteroid speed and fade profile, tuned for the default cruise speed. */
export const ASTEROID_ENCOUNTER_PROFILE: Readonly<EncounterProfile> = {
  minSpeed: ASTEROID_MIN_SPEED,
  minSpeedFloor: ASTEROID_MIN_SPEED_FLOOR,
  slowdownDistance: ASTEROID_SLOWDOWN_DISTANCE,
  minSpeedDistance: ASTEROID_MIN_SPEED_DISTANCE,
  speedupDistance: ASTEROID_SPEEDUP_DISTANCE,
  fadeInDistance: 0,
  fadeInTime: ENCOUNTER_FADE_IN_SECONDS,
  spawnScale: 1,
  fadeOutDistance: ASTEROID_FADE_OUT_DISTANCE,
  despawnDistance: ASTEROID_DESPAWN_DISTANCE,
  farSpeed: DEFAULT_ENCOUNTER_PROFILE.farSpeed,
  farAccel: DEFAULT_ENCOUNTER_PROFILE.farAccel,
  farMaxAngle: DEFAULT_ENCOUNTER_PROFILE.farMaxAngle,
};

/** The comet speed and fade profile, tuned for the default cruise speed. */
export const COMET_ENCOUNTER_PROFILE: Readonly<EncounterProfile> = {
  minSpeed: COMET_MIN_SPEED,
  minSpeedFloor: COMET_MIN_SPEED_FLOOR,
  slowdownDistance: COMET_SLOWDOWN_DISTANCE,
  minSpeedDistance: COMET_MIN_SPEED_DISTANCE,
  speedupDistance: COMET_SPEEDUP_DISTANCE,
  fadeInDistance: 0,
  fadeInTime: ENCOUNTER_FADE_IN_SECONDS,
  spawnScale: 1,
  fadeOutDistance: COMET_FADE_OUT_DISTANCE,
  despawnDistance: COMET_DESPAWN_DISTANCE,
  farSpeed: DEFAULT_ENCOUNTER_PROFILE.farSpeed,
  farAccel: DEFAULT_ENCOUNTER_PROFILE.farAccel,
  farMaxAngle: DEFAULT_ENCOUNTER_PROFILE.farMaxAngle,
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
   * (the gentle warp entry, after an encounter that ran to its despawn distance), at least; see
   * `warpEntryMaxRate`. After one that ended off screen the quick entry applies (`viewEntryTime`).
   */
  warpEntryTime: number;
  /**
   * Steepest slope of the gentle warp entry, in units per second per second: an entry from further
   * below the cruise speed is stretched beyond `warpEntryTime` until no steeper than this. `Infinity`
   * never stretches it.
   */
  warpEntryMaxRate: number;
  /**
   * Seconds the quick warp entry takes at least: the return to the cruise speed after an encounter
   * that ended out of view (`viewEntryDuration`), stretched by `viewEntryMaxRate`.
   */
  viewEntryTime: number;
  /**
   * Steepest acceleration of the ship in the quick warp entry, in units per second per second: an
   * entry with more to rise is stretched beyond `viewEntryTime` until no steeper than this.
   */
  viewEntryMaxRate: number;
  /**
   * The ship's speed time constant (`ShipParams.speedTau`), in seconds. The quick warp entry leads
   * the ship's lag by it, so the ship's speed itself follows the ease (`cruiseTargetSpeed`).
   */
  shipSpeedTau: number;
  /**
   * The live camera view (the screen's aspect ratio and the camera's vertical field of view; see
   * `cameraFrustum`). An encounter's slow phase ends as soon as its object is wholly outside it
   * (`encounterViewMargin`), before or after the closest approach. The engine replaces it on every
   * resize, so encounter timing depends on the screen: a shared trip seed replays the same objects in
   * the same order, but not frame-identical timing. The default is a 16:9 screen
   * (VIEW_DEFAULT_ASPECT), so tests are deterministic. `null` never ends an encounter early: DEPARTURE
   * then lasts to the despawn distance, as it did before Phase 4.
   */
  view: Readonly<ViewFrustum> | null;
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
  /** Share of encounters that are nebulae, in [0, 1] (0: solid bodies only, 1: nebulae only). */
  nebulaShare: number;
  /**
   * Share of all encounters that are asteroids, in [0, 1]: drawn among the encounters that are not
   * nebulae, which become asteroids with probability `asteroidShare / (1 - nebulaShare)` (capped at 1;
   * `asteroidFraction`). 0 gives no asteroids; with `nebulaShare` 0, 1 gives asteroids only.
   */
  asteroidShare: number;
  /**
   * Share of all encounters that are comets, in [0, 1]: drawn among the encounters that are neither
   * nebulae nor asteroids, which become comets with probability `cometShare / (1 - nebulaShare -
   * asteroidShare)` (capped at 1; `cometFraction`). 0 gives no comets; with the other shares 0, 1
   * gives comets only.
   */
  cometShare: number;
  /**
   * Most encounters of one kind in a row (an integer ≥ 1; `Infinity` for no limit). Planets,
   * asteroids and comets, the solid bodies, count as one run (`runClass`).
   */
  maxSameKindRun: number;
  /** Range of the object's elevation above or below the path, in radians (see `encounterSide`). */
  sideElevation: readonly [number, number];
  /** How nebula encounters are planned and flown. */
  nebula: Readonly<EncounterKindParams>;
  /** Chooses the nebula for an encounter seed. Called once when each nebula encounter starts. */
  nebulaFor: (seed: number) => NebulaSpec;
  /** How asteroid encounters are planned and flown (`sideOffsetFactor` for asteroids with no pass factor). */
  asteroid: Readonly<EncounterKindParams>;
  /** Chooses the asteroid for an encounter seed. Called once when each asteroid encounter starts. */
  asteroidFor: (seed: number) => AsteroidSpec;
  /** How comet encounters are planned and flown (`sideOffsetFactor` for comets with no pass factor). */
  comet: Readonly<EncounterKindParams>;
  /** Chooses the comet for an encounter seed. Called once when each comet encounter starts. */
  cometFor: (seed: number) => CometSpec;
}

export const DEFAULT_AUTOPILOT_PARAMS: Readonly<AutopilotParams> = {
  cruiseSpeed: SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL],
  arrivalSpeed: ENCOUNTER_ARRIVAL_SPEED,
  warpExitTime: ENCOUNTER_WARP_EXIT_SECONDS,
  warpExitLead: ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  warpEntryTime: ENCOUNTER_WARP_ENTRY_SECONDS,
  warpEntryMaxRate: ENCOUNTER_WARP_ENTRY_MAX_RATE,
  viewEntryTime: ENCOUNTER_VIEW_ENTRY_SECONDS,
  viewEntryMaxRate: ENCOUNTER_VIEW_ENTRY_MAX_RATE,
  shipSpeedTau: SHIP_SPEED_TAU_SECONDS,
  view: cameraFrustum(CAMERA_FOV_DEG, VIEW_DEFAULT_ASPECT, VIEW_WIDEST_ASPECT),
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
  asteroidShare: ENCOUNTER_ASTEROID_SHARE,
  cometShare: ENCOUNTER_COMET_SHARE,
  maxSameKindRun: ENCOUNTER_MAX_SAME_KIND_RUN,
  sideElevation: ENCOUNTER_SIDE_ELEVATION_RANGE,
  nebula: {
    encounterDistance: NEBULA_ENCOUNTER_DISTANCE,
    sideOffsetFactor: NEBULA_SIDE_OFFSET_FACTOR,
    profile: NEBULA_ENCOUNTER_PROFILE,
  },
  nebulaFor: defaultNebula,
  asteroid: {
    encounterDistance: ASTEROID_ENCOUNTER_DISTANCE,
    sideOffsetFactor: ASTEROID_SIDE_OFFSET_FACTOR,
    profile: ASTEROID_ENCOUNTER_PROFILE,
  },
  asteroidFor: defaultAsteroid,
  comet: {
    encounterDistance: COMET_ENCOUNTER_DISTANCE,
    sideOffsetFactor: COMET_SIDE_OFFSET_FACTOR,
    profile: COMET_ENCOUNTER_PROFILE,
  },
  cometFor: defaultComet,
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
  /**
   * How many encounters of `lastKind`'s run class (`runClass`: planets, asteroids and comets are one)
   * in a row ended with the latest one (0 before the first).
   */
  kindRun: number;
  /** The encounter in progress, or `null` in CRUISE. */
  encounter: ActiveEncounter | null;
  /**
   * Seconds since the encounter in progress started (0 on the step that plans it, where the object
   * appears at opacity 0), which its fade-in follows; 0 in CRUISE.
   */
  encounterTime: number;
  /**
   * The next encounter's object, once the cruise before it has chosen it (`chooseEncounter`): above
   * the arrival speed the cruise needs its far stretch to know how far to drop out of warp. The
   * encounter starts with it when it is still the one for that index. `null` until then.
   */
  next: EncounterChoice | null;
  /** Remaining distance to the closest approach (see encounter.ts); `Infinity` with no encounter. */
  remaining: number;
  /**
   * How far the encounter object is out of view (`encounterViewMargin`): positive once it is, zero or
   * negative while it may be in view; `-Infinity` with no encounter.
   */
  viewMargin: number;
  /**
   * Seconds since the encounter object went out of view (interpolated within the step it did), or
   * `-Infinity` while it may be in view and with no encounter.
   */
  outOfViewTime: number;
  /**
   * Target speed the latest encounter ended at, which the cruise after it eases up from
   * (`cruiseTargetSpeed`); `Infinity` before the first encounter.
   */
  entrySpeed: number;
  /** Drift rate the latest encounter ended at, which the cruise after it eases up from; 1 before the first. */
  entryDrift: number;
  /**
   * Whether the latest encounter ended out of view, so the cruise after it returns to warp with the
   * quick entry (`viewEntryDuration`) rather than the gentle one (`warpEntryDuration`).
   */
  entryQuick: boolean;
  /**
   * Where the quick entry starts (see `cruiseTargetSpeed`): the cruise time at which the latest
   * encounter ended (the lateness carried into the cruise), and the ship's speed and acceleration
   * then. 0 before the first encounter.
   */
  entryAt: number;
  entryShipSpeed: number;
  entryShipAccel: number;
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
 * Salt of the asteroid draw (`bodyKind`), a stream of its own, so the planet-or-nebula draw is
 * exactly what it was before asteroids. Among the salts tried it is one that leaves the test default
 * trip's opening as it was (config.ts, ENCOUNTER_BASE_SEED) and still meets an asteroid early on.
 */
const ASTEROID_KIND_SALT = 0xa577;
/**
 * Salt of the comet draw (`bodyKind`), a stream of its own, so the nebulae and the asteroids are
 * exactly where they were before comets. Among the salts tried it is one that leaves the test default
 * trip's opening and its fifth encounter, the asteroid, as they were, keeps its ringed planets and its
 * icy dwarf among the first 50 encounters (config.ts, ENCOUNTER_BASE_SEED), and meets a comet sixth.
 */
const COMET_KIND_SALT = 0x0c0e;

/** Kinds as the run cap counts them: a solid body (`'planet'`: planets, asteroids and comets) or a nebula. */
export type RunClass = 'planet' | 'nebula';

/**
 * The run class of `kind` (`'planet'` for planets, asteroids and comets alike), or `null` for `null`.
 * The same-kind cap (`AutopilotParams.maxSameKindRun`) counts runs of these.
 */
export function runClass(kind: EncounterKind | null): RunClass | null {
  return kind === null ? null : kind === 'nebula' ? 'nebula' : 'planet';
}

/**
 * The seeded first-stage draw for appearance seed `seed` (`hash(baseSeed, index)`): a nebula with
 * probability `nebulaShare`, otherwise a solid body (`'planet'`, which the asteroid and comet draws,
 * `bodyKind`, may turn into an asteroid or a comet). Pure and deterministic. The autopilot draws with the share
 * `kindDrawShare` gives and caps same-class runs (`nextEncounterKind`).
 */
export function encounterKind(seed: number, nebulaShare: number): RunClass {
  return hashUnit(seed, KIND_SALT) < nebulaShare ? 'nebula' : 'planet';
}

/**
 * Probability that an encounter which is not a nebula is an asteroid: `asteroidShare / (1 -
 * nebulaShare)`, in [0, 1], so `asteroidShare` of all encounters are asteroids (0 when every
 * encounter is a nebula or the share is 0 or missing, as it may be in `Pick`s of the params).
 */
export function asteroidFraction(params: Readonly<Pick<AutopilotParams, 'nebulaShare'> & Partial<Pick<AutopilotParams, 'asteroidShare'>>>): number {
  const share = params.asteroidShare ?? 0;
  if (!(share > 0) || !(params.nebulaShare < 1)) return 0;
  return Math.min(1, share / (1 - Math.max(0, params.nebulaShare)));
}

/**
 * Probability that an encounter which is neither a nebula nor an asteroid is a comet: `cometShare /
 * (1 - nebulaShare - asteroidShare)`, in [0, 1], so `cometShare` of all encounters are comets (0 when
 * nothing is left for them, as when every encounter is a nebula or an asteroid, or when the share is
 * 0 or missing).
 */
export function cometFraction(
  params: Readonly<Pick<AutopilotParams, 'nebulaShare'> & Partial<Pick<AutopilotParams, 'asteroidShare' | 'cometShare'>>>,
): number {
  const share = params.cometShare ?? 0;
  if (!(share > 0) || asteroidFraction(params) >= 1 || !(params.nebulaShare < 1)) return 0;
  const rest = 1 - Math.max(0, params.nebulaShare) - Math.max(0, params.asteroidShare ?? 0);
  return rest > 0 ? Math.min(1, share / rest) : 0;
}

/**
 * The later draws for a solid body with appearance seed `seed`: an asteroid with probability
 * `asteroid` (`asteroidFraction`); otherwise a comet with probability `comet` (`cometFraction`);
 * otherwise a planet. Each from its own salted stream, so neither changes which encounters are
 * nebulae, and comets never change which are asteroids.
 */
export function bodyKind(seed: number, asteroid: number, comet = 0): 'planet' | 'asteroid' | 'comet' {
  if (hashUnit(seed, ASTEROID_KIND_SALT) < asteroid) return 'asteroid';
  return hashUnit(seed, COMET_KIND_SALT) < comet ? 'comet' : 'planet';
}

/**
 * Whether `params`' mix has any planets: some encounters are not nebulae, and of those not all are
 * asteroids or comets. Only then does a trip open with a planet (`encounterKindAt`).
 */
export function mixHasPlanets(params: KindParams): boolean {
  return params.nebulaShare < 1 && asteroidFraction(params) < 1 && cometFraction(params) < 1;
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

/** What the kind draw needs of the params; a missing `asteroidShare` or `cometShare` means none of that kind. */
export type KindParams = Pick<AutopilotParams, 'nebulaShare' | 'maxSameKindRun'> &
  Partial<Pick<AutopilotParams, 'asteroidShare' | 'cometShare'>>;

/**
 * The kind of the encounter with appearance seed `seed`, given the kind of the latest encounter and
 * how many of its run class came in a row (`run`; `runClass`). First the planet-or-nebula draw
 * (`encounterKind` with `kindDrawShare`), except that it is the other class when the draw would make
 * the run longer than `params.maxSameKindRun`; a nebula share of 0 or 1 forces one class and ignores
 * the cap. Then a solid body is an asteroid or a comet by the later draws (`bodyKind` with
 * `asteroidFraction` and `cometFraction`), a planet otherwise. Planets, asteroids and comets share
 * one run, so no kind ever runs longer than the cap.
 */
export function nextEncounterKind(seed: number, params: KindParams, lastKind: EncounterKind | null, run: number): EncounterKind {
  const { nebulaShare, maxSameKindRun } = params;
  if (nebulaShare > 0) {
    if (!(nebulaShare < 1)) return 'nebula';
    const drawn = encounterKind(seed, kindDrawShare(nebulaShare, maxSameKindRun));
    const capped = drawn === runClass(lastKind) && capsRuns(maxSameKindRun) && run >= Math.floor(maxSameKindRun);
    if ((drawn === 'nebula') !== capped) return 'nebula';
  }
  return bodyKind(seed, asteroidFraction(params), cometFraction(params));
}

/**
 * The kind of encounter `index` (appearance seed `seed`): a planet for the first encounter of the
 * trip (index 0), so a planet comes first for every base seed, and `nextEncounterKind` after that.
 * Only a mix with no planets at all (`mixHasPlanets` false: a nebula share of 1, or every solid body
 * an asteroid or a comet, as a forced kind is) draws the first encounter like any other, since a
 * planet there would be one the mix never otherwise has.
 */
export function encounterKindAt(index: number, seed: number, params: KindParams, lastKind: EncounterKind | null, run: number): EncounterKind {
  if (index === 0 && mixHasPlanets(params)) return 'planet';
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
    run = runClass(kind) === runClass(lastKind) ? run + 1 : 1;
    lastKind = kind;
    out.push({ index, seed, kind, side: encounterSide(seed, params.sideElevation).side, interval: cruiseInterval(params, index) });
  }
  return out;
}

/** The speed and fade profile in use for an encounter of `kind`. */
export function encounterProfile(params: Readonly<AutopilotParams>, kind: EncounterKind): Readonly<EncounterProfile> {
  if (kind === 'nebula') return params.nebula.profile;
  if (kind === 'asteroid') return params.asteroid.profile;
  return kind === 'comet' ? params.comet.profile : params.profile;
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
 * Seconds the quick warp entry (after an encounter that ended out of view) takes from the ship's
 * `entrySpeed` and `entryAccel` up to the cruise speed (`cruiseTargetSpeed`): `viewEntryTime`,
 * stretched until the ship's steepest acceleration in it is at most `viewEntryMaxRate`. That is at
 * most 1.875 × the rise / the time (the steepest slope of a smootherstep) plus 0.52 × any
 * deceleration it starts with (which the curve turns around), so the stretch keeps their sum within
 * the rate (or within twice the time a start at rest would take, for a start braking harder than the
 * rate itself).
 */
export function viewEntryDuration(
  params: Readonly<Pick<AutopilotParams, 'cruiseSpeed' | 'viewEntryTime' | 'viewEntryMaxRate'>>,
  entrySpeed: number,
  entryAccel = 0,
): number {
  const rise = params.cruiseSpeed - entrySpeed;
  const rate = params.viewEntryMaxRate;
  const room = Math.max(rate / 2, rate - 0.52 * Math.max(0, -entryAccel));
  const stretched = rise > 0 && rate > 0 ? (1.875 * rise) / room : 0;
  return Math.max(params.viewEntryTime, stretched);
}

/**
 * The ship's speed in the quick warp entry, and its rate of change, `u` of the way through an entry
 * lasting `duration` seconds from `speed` and `accel` (the ship's speed and acceleration where it
 * starts) to `cruise`: the quintic Hermite curve that starts with that speed, that acceleration and no
 * jerk, and ends at the cruise speed with no acceleration and no jerk. With no acceleration at the
 * start it is a smootherstep. Writes `[speed, rate]` into `out`.
 */
function quickEntryCurve(u: number, duration: number, speed: number, accel: number, cruise: number, out: [number, number]): [number, number] {
  const u2 = u * u;
  const u3 = u2 * u;
  // 1 - smootherstep, and the basis that carries the starting slope: h1 = u - 6u³ + 8u⁴ - 3u⁵.
  const h0 = 1 - u3 * (10 + u * (6 * u - 15));
  const h1 = u - u3 * (6 - u * (8 - 3 * u));
  const w = u * (1 - u);
  const dh0 = -30 * w * w;
  const dh1 = (1 - u) * (1 - u) * (1 + u * (2 - 15 * u));
  const slope = accel * duration;
  out[0] = cruise + (speed - cruise) * h0 + slope * h1;
  out[1] = ((speed - cruise) * dh0 + slope * dh1) / duration;
  return out;
}

const curveScratch: [number, number] = [0, 0];

/**
 * Target speed after `cruiseTime` seconds of a cruise lasting `interval`; `afterEncounter` tells
 * whether the cruise follows an encounter (every cruise but the first, from load), and `entrySpeed`
 * is the target speed that encounter ended at (by default `encounterCruiseSpeed`, where an encounter
 * that runs to its despawn distance ends). `quick` tells whether that encounter ended out of view,
 * and then the quick entry starts at cruise time `quickAt` (the lateness carried from the encounter's
 * end) from the ship's speed and acceleration then, `quickSpeed` and `quickAccel`.
 *
 * After an encounter that ended out of view (`quick`), the warp entry is quick, since nothing on
 * screen is left to watch: the ship's speed itself eases from where it was, with the acceleration it
 * had, up to the cruise speed over `viewEntryDuration` (a quintic Hermite curve, a smootherstep from
 * rest; no jerk at either end), and the target leads it by the ship's lag
 * (`target = v + shipSpeedTau × v'`, which the ship's exponential approach turns back into `v`). It
 * starts where the encounter's target speed was (the ship's speed plus its lag) and ends at the
 * cruise speed, so there is no step, the ship's acceleration is continuous and its jerk bounded; in
 * between the target runs ahead of the ship's speed, and may run above the cruise speed while the ship
 * catches up (with one target per frame, the ship can end up to about half a frame's worth of its
 * starting acceleration × e^(-duration / shipSpeedTau) over the cruise speed: a few hundredths of a
 * unit per second at the capped dt).
 *
 * After any other encounter (one that ran to its despawn distance), the target starts at the entry
 * speed (capped at the cruise speed) and eases (smoothstep) up to the cruise speed over
 * `warpEntryDuration` (back into warp); the first cruise has no encounter to return from (the ship
 * accelerates from rest at load), so it starts at the cruise speed. Above the arrival speed, from
 * `warpExitLead + warpExitTime` before the encounter starts, it then eases back down to the arrival
 * speed, which it reaches `warpExitLead` before the encounter starts (out of warp). Where the eases
 * overlap (a short cruise) the lower one applies (with the quick entry's lead on top, which is 0 by
 * then), so the target is continuous and never jumps, it never reaches the cruise speed, and it is
 * still at the arrival speed from `warpExitLead` before the encounter starts (throughout, for a
 * cruise no longer than that). A gentle entry from below the arrival speed is cut short to end by
 * then too, as the quick entry always is, so the next encounter still starts at the arrival speed;
 * only a cruise no longer than the lead (shorter than any configured interval) starts it at the
 * arrival speed at once.
 *
 * `handover` is the speed the drop out of warp ends at: the arrival speed by default, or, before an
 * encounter with a far stretch, the speed that can fly on from (`farHandoverSpeed`, between the
 * arrival speed and the cruise speed). Everything said of the arrival speed above then holds for it:
 * at the top level the cruise before most planets, asteroids and comets does not drop out of warp at
 * all, and their far stretch slows the ship down instead.
 *
 * Continuous with the encounter's target speed at both ends: an encounter starts at the hand-over
 * speed (see `encounterTargetSpeed` and `farStretchTargetSpeed`) and ends at the entry speed.
 */
export function cruiseTargetSpeed(
  cruiseTime: number,
  interval: number,
  params: Readonly<AutopilotParams>,
  afterEncounter: boolean,
  entrySpeed: number = encounterCruiseSpeed(params),
  quick = false,
  quickAt = 0,
  quickSpeed: number = entrySpeed,
  quickAccel = 0,
  handover: number = encounterCruiseSpeed(params),
): number {
  const cruise = params.cruiseSpeed;
  const arrival = Math.min(cruise, Math.max(encounterCruiseSpeed(params), handover));
  const exitEnd = interval - params.warpExitLead;
  let target = cruise;
  // The quick entry's lead over the ship's lag, added on top of any drop out of warp.
  let lead = 0;
  if (afterEncounter && quick) {
    const entryTime = Math.min(viewEntryDuration(params, Math.min(quickSpeed, cruise), quickAccel), Math.max(0, exitEnd - quickAt));
    const t = cruiseTime - quickAt;
    if (entryTime > 0 && t < entryTime) {
      const [speed, rate] = quickEntryCurve(Math.max(0, t) / entryTime, entryTime, quickSpeed, quickAccel, cruise, curveScratch);
      target = speed;
      lead = params.shipSpeedTau * rate;
    }
  } else {
    const from = afterEncounter ? Math.min(entrySpeed, cruise) : cruise;
    if (from < cruise) {
      let entryTime = warpEntryDuration(params, from);
      if (from < arrival) entryTime = Math.min(entryTime, Math.max(0, exitEnd));
      target = entryTime > 0 ? from + (cruise - from) * smoothstep(0, entryTime, cruiseTime) : cruise;
    }
  }
  if (cruise > arrival) {
    const exitTime = params.warpExitTime;
    const exit = exitTime > 0 ? smoothstep(exitEnd, exitEnd - exitTime, cruiseTime) : cruiseTime >= exitEnd ? 0 : 1;
    target = Math.min(target, arrival + (cruise - arrival) * exit);
  }
  return target + lead;
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
 * The `k` an encounter with `asteroid` is planned with: the asteroid's own pass factor, or
 * `sideOffsetFactor` without one, raised to at least `1 + ENCOUNTER_CLEARANCE_MARGIN`, so the path
 * never comes within `radius × (1 + margin)` of the field centre and never enters the sphere that
 * holds every rock (docs/PLAN.md section 6, Variety: the camera never passes through an asteroid).
 */
export function asteroidPassFactor(asteroid: Readonly<AsteroidSpec>, sideOffsetFactor: number): number {
  return Math.max(asteroid.passFactor ?? sideOffsetFactor, 1 + ENCOUNTER_CLEARANCE_MARGIN);
}

/**
 * The `k` an encounter with `comet` is planned with: the comet's own pass factor, or
 * `sideOffsetFactor` without one, raised to at least `1 + ENCOUNTER_CLEARANCE_MARGIN`, so the path
 * never comes within `radius × (1 + margin)` of the nucleus and never enters the coma (docs/PLAN.md
 * section 6, Variety: the camera never passes through a comet nucleus).
 */
export function cometPassFactor(comet: Readonly<CometSpec>, sideOffsetFactor: number): number {
  return Math.max(comet.passFactor ?? sideOffsetFactor, 1 + ENCOUNTER_CLEARANCE_MARGIN);
}

/**
 * The object of encounter `index` (appearance seed `seed`, of `kind`, which `encounterKindAt` picks):
 * the spec its kind's chooser gives for the seed, and its far stretch's length. Calls that chooser
 * once.
 */
export function chooseEncounter(index: number, seed: number, kind: EncounterKind, params: Readonly<AutopilotParams>): EncounterChoice {
  const farRoom = 0;
  const choice: EncounterChoice =
    kind === 'nebula'
      ? { index, seed, farRoom, kind, nebula: params.nebulaFor(seed) }
      : kind === 'asteroid'
        ? { index, seed, farRoom, kind, asteroid: params.asteroidFor(seed) }
        : kind === 'comet'
          ? { index, seed, farRoom, kind, comet: params.cometFor(seed) }
          : { index, seed, farRoom, kind, planet: params.planetFor(seed) };
  choice.farRoom = encounterChoiceRoom(choice, params);
  return choice;
}

/**
 * How `choice` is planned: its encounter radius, `D` and `k` (each kind's pass factor rule), and the
 * radius of the sphere that holds what is drawn of it for the far stretch's threshold (config.ts,
 * ENCOUNTER_FAR_SPEED): a planet's extent (its atmosphere or its ring; PLANET_VIEW_RADIUS_FACTOR
 * without one), an asteroid field's bounding sphere, a comet's coma, a nebula's core.
 */
export function encounterChoicePlan(
  choice: Readonly<EncounterChoice>,
  params: Readonly<AutopilotParams>,
): { radius: number; distance: number; k: number; drawnRadius: number } {
  switch (choice.kind) {
    case 'nebula': {
      const { radius } = choice.nebula;
      return { radius, distance: params.nebula.encounterDistance, k: params.nebula.sideOffsetFactor, drawnRadius: radius };
    }
    case 'asteroid': {
      const { radius } = choice.asteroid;
      const k = asteroidPassFactor(choice.asteroid, params.asteroid.sideOffsetFactor);
      return { radius, distance: params.asteroid.encounterDistance, k, drawnRadius: radius };
    }
    case 'comet': {
      const { radius } = choice.comet;
      const k = cometPassFactor(choice.comet, params.comet.sideOffsetFactor);
      return { radius, distance: params.comet.encounterDistance, k, drawnRadius: radius };
    }
    case 'planet': {
      const { radius } = choice.planet;
      const k = planetPassFactor(choice.planet, params.sideOffsetFactor);
      return { radius, distance: params.encounterDistance, k, drawnRadius: radius * Math.max(1, choice.planet.extent ?? PLANET_VIEW_RADIUS_FACTOR) };
    }
  }
}

/** The far stretch's length for `choice` (`farStretchRoom` with its plan and its kind's profile). */
export function encounterChoiceRoom(choice: Readonly<EncounterChoice>, params: Readonly<AutopilotParams>): number {
  const { radius, distance, k, drawnRadius } = encounterChoicePlan(choice, params);
  return farStretchRoom(distance, radius * k, drawnRadius, encounterProfile(params, choice.kind));
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
 * How far the encounter's object is out of `view` (the live camera view, `AutopilotParams.view`) with
 * the ship at `ship` (its position and heading, the camera's forward axis, with world +Y up as the
 * engine's `lookAt` sets it): positive once no part of it is on screen, zero or negative while some
 * part may be. `null` never puts it out of view (`-Infinity`). `remaining` is the ship's remaining
 * distance (`encounterRemaining`). Pure and allocation-free. Kind-generic: each kind names the
 * spheres (or bound) that hold everything drawn for it, and the screen test is the same for all.
 *
 * - Planet: `frustumSphereMargin` of the sphere of `radius × planetViewRadiusFactor(planet)` (the
 *   atmosphere, or the ring), in world units.
 * - Asteroid: `frustumSphereMargin` of the field's bounding sphere (`radius`, which holds every rock
 *   whatever its tumble), in world units.
 * - Comet: the smallest `frustumSphereMargin` of its bounds (`CometSpec.bounds`: the coma and every
 *   stretch of both tails), in world units, or of the coma's sphere (`radius`) for a comet without
 *   them: it is out of view only once every one of those spheres is.
 * - Nebula: its layers reach across the path, so every layer is on screen until the ship is past it.
 *   In world units, how far the ship is past every layer (`-(remaining + depth)`, from
 *   `nebulaViewExtent`), and only once the heading has not turned so far from the planned direction
 *   that the view could reach a layer: every point of a layer is then at least
 *   π/2 + atan(past / lateral) from the planned direction, so at least that minus the heading's turn
 *   from the forward axis, which must exceed the view's corner half-angle (`frustumConeHalfAngle`).
 *
 * With the heading held (APPROACH and FLYBY), the margin only grows as the ship moves on, for every
 * kind (`frustumSphereMargin`; a nebula's `past` grows with the distance travelled): once out of view,
 * the object would never come back into view.
 */
export function encounterViewMargin(
  encounter: Readonly<ActiveEncounter>,
  ship: Readonly<ShipState>,
  view: Readonly<ViewFrustum> | null,
  remaining: number = encounterRemaining(encounter.plan, ship.position),
): number {
  if (view === null) return Number.NEGATIVE_INFINITY;
  const { plan } = encounter;
  if (encounter.kind === 'planet') {
    const offset = encounterOffset(plan, ship.position, viewScratch);
    return frustumSphereMargin(offset, ship.heading, plan.radius * planetViewRadiusFactor(encounter.planet), view);
  }
  if (encounter.kind === 'asteroid') {
    return frustumSphereMargin(encounterOffset(plan, ship.position, viewScratch), ship.heading, plan.radius, view);
  }
  if (encounter.kind === 'comet') return cometViewMargin(encounter, ship, view);
  if (encounter.kind === 'nebula') {
    const { depth, lateral } = nebulaViewExtent(plan.radius, plan.closestDistance);
    const past = -(remaining + depth);
    if (!(past > 0)) return past;
    const nearest = Math.PI / 2 + Math.atan(past / lateral);
    return nearest - angleBetween(ship.heading, plan.direction) > frustumConeHalfAngle(view) ? past : 0;
  }
  // Every kind is handled above: a new kind fails to compile here until it names its bounds.
  const unhandled: never = encounter;
  return unhandled;
}

const boundScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * `encounterViewMargin` for a comet: the smallest `frustumSphereMargin` of its bounds, so it is out of
 * view only once the coma and every stretch of both tails are. Allocation-free.
 */
function cometViewMargin(encounter: Readonly<CometEncounter>, ship: Readonly<ShipState>, view: Readonly<ViewFrustum>): number {
  const { plan } = encounter;
  const nucleus = encounterOffset(plan, ship.position, viewScratch);
  const bounds = encounter.comet.bounds;
  if (bounds === undefined || bounds.length === 0) return frustumSphereMargin(nucleus, ship.heading, plan.radius, view);
  const { direction: d, side: s } = plan;
  // up = side × direction, the encounter frame's third axis.
  const ux = s.y * d.z - s.z * d.y;
  const uy = s.z * d.x - s.x * d.z;
  const uz = s.x * d.y - s.y * d.x;
  let margin = Number.POSITIVE_INFINITY;
  for (const bound of bounds) {
    const [a, b, c] = bound.offset;
    boundScratch.x = nucleus.x + a * d.x + b * s.x + c * ux;
    boundScratch.y = nucleus.y + a * d.y + b * s.y + c * uy;
    boundScratch.z = nucleus.z + a * d.z + b * s.z + c * uz;
    margin = Math.min(margin, frustumSphereMargin(boundScratch, ship.heading, bound.radius, view));
  }
  return margin;
}

/**
 * The target speed during `encounter` at `remaining` distance: on its far stretch (while the distance
 * travelled from the spawn is under `farRoom`), `farStretchTargetSpeed` from the ship's speed at the
 * spawn; from there on, the speed profile from `encounterCruiseSpeed` (`encounterTargetSpeed`), the
 * same as without a far stretch. Pure and allocation-free.
 */
export function activeEncounterTargetSpeed(encounter: Readonly<ActiveEncounter>, remaining: number, params: Readonly<AutopilotParams>): number {
  const profile = encounterProfile(params, encounter.kind);
  const arrival = encounterCruiseSpeed(params);
  const room = encounter.farRoom ?? 0;
  const travelled = encounter.plan.spawnDistance - remaining;
  return room > 0 && travelled < room
    ? farStretchTargetSpeed(travelled, room, encounter.farStart ?? arrival, arrival, profile, params.shipSpeedTau)
    : encounterTargetSpeed(remaining, arrival, profile);
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
    encounterTime: 0,
    next: null,
    remaining: Number.POSITIVE_INFINITY,
    viewMargin: Number.NEGATIVE_INFINITY,
    outOfViewTime: Number.NEGATIVE_INFINITY,
    entrySpeed: Number.POSITIVE_INFINITY,
    entryDrift: 1,
    entryQuick: false,
    entryAt: 0,
    entryShipSpeed: 0,
    entryShipAccel: 0,
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
 *   once the ship is the profile's despawn distance past it, where the fade has reached 0.
 * - As soon as the object is out of the live view (`encounterViewMargin` > 0 with `params.view`),
 *   before or after the closest approach, the encounter moves on one state per step from the state it
 *   was in on the step before (APPROACH → FLYBY → DEPARTURE → CRUISE), so it ends within three steps
 *   and every encounter still shows the whole cycle. It would not come back into view: the heading
 *   is held until the closest approach (see `encounterViewMargin`). An object out of view is removed
 *   whatever its fade, which no one sees.
 * - The lateness carried from the end of DEPARTURE is the time since the first of those held: since
 *   the despawn distance was passed, or since the view margin turned positive (interpolated between
 *   the two steps either side), up to three steps.
 * - The target speed follows the encounter's far stretch and then its speed profile from
 *   `encounterCruiseSpeed` (`activeEncounterTargetSpeed`), and is `cruiseTargetSpeed` in CRUISE:
 *   after an encounter, the return to warp from the target speed the encounter ended at (quick when it
 *   ended out of view), and the drop out of warp to the hand-over speed at the end of the cruise when
 *   the cruise speed is above the arrival speed (which chooses the next object, `next`, once).
 * - The fade follows the encounter's own time (`encounterTime`) for the fade-in of a planet, an
 *   asteroid or a comet, and the remaining distance otherwise (`encounterOpacity`).
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
  let next = state.next;
  let encounterTime = travel === 'CRUISE' ? 0 : state.encounterTime + dt;
  let entrySpeed = state.entrySpeed;
  let entryDrift = state.entryDrift;
  let entryQuick = state.entryQuick;
  let entryAt = state.entryAt;
  let entryShipSpeed = state.entryShipSpeed;
  let entryShipAccel = state.entryShipAccel;
  let viewMargin = Number.NEGATIVE_INFINITY;
  let outOfViewTime = Number.NEGATIVE_INFINITY;

  if (travel === 'CRUISE') {
    cruiseTime += dt;
    const interval = cruiseInterval(params, encounterCount);
    if (cruiseTime >= interval) {
      const index = encounterCount;
      const seed = hash(params.baseSeed, index);
      const kind = encounterKindAt(index, seed, params, lastKind, kindRun);
      const { side, sideAngle } = encounterSide(seed, params.sideElevation);
      // The object the cruise chose, if it is still the one for this index; otherwise choose it now.
      const choice = next !== null && next.index === index && next.seed === seed && next.kind === kind ? next : chooseEncounter(index, seed, kind, params);
      const { radius, distance, k } = encounterChoicePlan(choice, params);
      const plan = planEncounter(ship.position, ship.heading, radius, distance, k, sideAngle);
      const base = { index, seed, side, plan, farRoom: choice.farRoom, farStart: ship.speed };
      if (choice.kind === 'nebula') encounter = { ...base, kind: 'nebula', nebula: choice.nebula };
      else if (choice.kind === 'asteroid') encounter = { ...base, kind: 'asteroid', asteroid: choice.asteroid };
      else if (choice.kind === 'comet') encounter = { ...base, kind: 'comet', comet: choice.comet };
      else encounter = { ...base, kind: 'planet', planet: choice.planet };
      next = null;
      encounterCount = index + 1;
      kindRun = runClass(kind) === runClass(lastKind) ? kindRun + 1 : 1;
      lastKind = kind;
      // How late this encounter starts. The plan stays at the ship's actual position; the next CRUISE
      // is shortened by this instead.
      cruiseTime = Math.min(cruiseTime - interval, dt);
      // The object appears at opacity 0 on this step, planned where the ship is now.
      encounterTime = 0;
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
    const continuing = state.encounter === encounter;
    const prevMargin = continuing ? state.viewMargin : Number.NEGATIVE_INFINITY;
    viewMargin = encounterViewMargin(encounter, ship, params.view, remaining);
    if (viewMargin > 0) {
      // Since it went out of view: interpolated within the step it did, then counted on.
      outOfViewTime =
        continuing && state.outOfViewTime >= 0
          ? state.outOfViewTime + dt
          : prevMargin > Number.NEGATIVE_INFINITY
            ? (dt * viewMargin) / (viewMargin - prevMargin)
            : 0;
      // Out of view: on to the next state, one per step, so every encounter shows the whole cycle
      // (and DEPARTURE lasts at least one step). That step's time is carried with the lateness below.
      if (continuing && travel === state.state) {
        if (travel === 'APPROACH') travel = 'FLYBY';
        else if (travel === 'FLYBY') travel = 'DEPARTURE';
      }
    }
    if (travel === 'DEPARTURE' && state.state === 'DEPARTURE' && continuing) {
      // How long ago DEPARTURE could have ended, by each rule; -Infinity where it cannot yet. At most
      // three steps: the ones before may have been the ones held.
      const cap = 3 * dt;
      let late = Number.NEGATIVE_INFINITY;
      if (remaining <= -profile.despawnDistance) {
        // Time since the ship passed the despawn distance.
        const past = ship.speed > 0 ? (-profile.despawnDistance - remaining) / ship.speed : 0;
        late = Math.min(past, cap);
      }
      const outOfView = viewMargin > 0;
      if (outOfView) late = Math.max(late, Math.min(outOfViewTime, cap));
      if (late > Number.NEGATIVE_INFINITY) {
        // Carried with the encounter's late start. The next cruise eases up from where this ends.
        cruiseTime += late;
        entrySpeed = encounterTargetSpeed(remaining, encounterCruiseSpeed(params), profile);
        entryDrift = smoothstep(0, -profile.despawnDistance, remaining);
        entryQuick = outOfView;
        // The ship's acceleration with the encounter's last target, so the quick entry carries it on.
        entryShipAccel = (entrySpeed - ship.speed) / params.shipSpeedTau;
        entryShipSpeed = ship.speed;
        entryAt = cruiseTime;
        travel = 'CRUISE';
        encounter = null;
        encounterTime = 0;
        remaining = Number.POSITIVE_INFINITY;
        viewMargin = Number.NEGATIVE_INFINITY;
        outOfViewTime = Number.NEGATIVE_INFINITY;
      }
    }
  }

  out.state = travel;
  out.cruiseTime = cruiseTime;
  out.encounterCount = encounterCount;
  out.lastKind = lastKind;
  out.kindRun = kindRun;
  out.encounter = encounter;
  out.encounterTime = encounterTime;
  out.remaining = remaining;
  out.viewMargin = viewMargin;
  out.outOfViewTime = outOfViewTime;
  out.entrySpeed = entrySpeed;
  out.entryDrift = entryDrift;
  out.entryQuick = entryQuick;
  out.entryAt = entryAt;
  out.entryShipSpeed = entryShipSpeed;
  out.entryShipAccel = entryShipAccel;
  if (encounter === null) {
    const interval = cruiseInterval(params, encounterCount);
    const arrival = encounterCruiseSpeed(params);
    let handover = arrival;
    if (params.cruiseSpeed > arrival) {
      // Above the arrival speed the drop out of warp ends where the next far stretch can fly on from,
      // so the cruise chooses the next object now (once: it is kept for the encounter).
      const index = encounterCount;
      const seed = hash(params.baseSeed, index);
      const kind = encounterKindAt(index, seed, params, lastKind, kindRun);
      if (next === null || next.index !== index || next.seed !== seed || next.kind !== kind) next = chooseEncounter(index, seed, kind, params);
      handover = farHandoverSpeed(next.farRoom, params.cruiseSpeed, arrival, encounterProfile(params, kind));
    }
    out.fade = 0;
    out.targetSpeed = cruiseTargetSpeed(
      cruiseTime,
      interval,
      params,
      encounterCount > 0,
      entrySpeed,
      entryQuick,
      entryAt,
      entryShipSpeed,
      entryShipAccel,
      handover,
    );
    out.driftRate = cruiseDriftRate(cruiseTime, interval, params, encounterCount > 0 ? entryDrift : 1);
  } else {
    const profile = encounterProfile(params, encounter.kind);
    out.fade = encounterOpacity(encounter.plan, remaining, profile, encounterTime);
    out.targetSpeed = activeEncounterTargetSpeed(encounter, remaining, params);
    out.driftRate = travel === 'DEPARTURE' ? smoothstep(0, -profile.despawnDistance, remaining) : 0;
  }
  out.next = next;
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
 * The far stretch's speed is scaled the same way, and its acceleration by the square of the factor,
 * since its distances are unchanged too (config.ts, ENCOUNTER_FAR_SPEED).
 *
 * The scaled minimum speed is floored at the profile's `minSpeedFloor` (ENCOUNTER_MIN_SPEED_FLOOR
 * for planets, NEBULA_MIN_SPEED_FLOOR for nebulae, ASTEROID_MIN_SPEED_FLOOR for asteroids,
 * COMET_MIN_SPEED_FLOOR for comets), so the
 * slowest levels (the reduced-motion start) slow down proportionally less instead of crawling
 * through the flyby; it is also capped at the encounter speed, so an encounter never speeds the ship
 * up. Planet, nebula, asteroid and comet profiles are all scaled this way.
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
    // The far stretch keeps its distances, so its speeds scale and its acceleration with their square.
    farSpeed: profile.farSpeed * factor,
    farAccel: profile.farAccel * factor * factor,
  });
  params.cruiseSpeed = cruiseSpeed;
  params.profile = scaled(base.profile);
  params.nebula = { ...params.nebula, profile: scaled(base.nebula.profile) };
  params.asteroid = { ...params.asteroid, profile: scaled(base.asteroid.profile) };
  params.comet = { ...params.comet, profile: scaled(base.comet.profile) };
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
