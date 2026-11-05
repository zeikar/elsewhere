import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ASTEROID_DESPAWN_DISTANCE,
  ASTEROID_ENCOUNTER_DISTANCE,
  ASTEROID_SIDE_OFFSET_FACTOR,
  CAMERA_FOV_DEG,
  COMET_DESPAWN_DISTANCE,
  COMET_ENCOUNTER_DISTANCE,
  COMET_SIDE_OFFSET_FACTOR,
  DT_CAP_SECONDS,
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_ASTEROID_SHARE,
  ENCOUNTER_ASTEROID_SHARE_BOUNDS,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_COMET_SHARE,
  ENCOUNTER_COMET_SHARE_BOUNDS,
  ENCOUNTER_DESPAWN_DISTANCE,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_JITTER,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_MAX_SAME_KIND_RUN,
  ENCOUNTER_MIN_SPEED_FLOOR,
  ENCOUNTER_NEBULA_SHARE,
  ENCOUNTER_NEBULA_SHARE_BOUNDS,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_ELEVATION_RANGE,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  ENCOUNTER_WARP_ENTRY_MAX_RATE,
  ENCOUNTER_WARP_ENTRY_SECONDS,
  ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
  ENCOUNTER_WARP_EXIT_SECONDS,
  NEBULA_DESPAWN_DISTANCE,
  NEBULA_ENCOUNTER_DISTANCE,
  NEBULA_MIN_SPEED,
  NEBULA_MIN_SPEED_FLOOR,
  NEBULA_RANGES,
  NEBULA_SIDE_OFFSET_FACTOR,
  PLANET_GAS_RANGES,
  PLANET_PASS_FACTOR_RANGE,
  PLANET_RING_RANGES,
  PLANET_ROCKY_RANGES,
  REDUCED_MOTION_SPEED_LEVEL,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_MAX_TURN_RATE_RAD_PER_S,
  SHIP_SPEED_LEVELS,
  SHIP_SPEED_TAU_SECONDS,
  VIEW_WIDEST_ASPECT,
} from '../config';
import { Asteroid, asteroidParams, type AsteroidParams } from './Asteroid';
import {
  ASTEROID_ENCOUNTER_PROFILE,
  COMET_ENCOUNTER_PROFILE,
  DEFAULT_AUTOPILOT_PARAMS,
  NEBULA_ENCOUNTER_PROFILE,
  PLANET_VIEW_RADIUS_FACTOR,
  asteroidFraction,
  bodyKind,
  cappedNebulaShare,
  cometFraction,
  cometPassFactor,
  createAutopilotState,
  cruiseInterval,
  cruiseTargetSpeed,
  cruiseIntervalFor,
  defaultAsteroid,
  defaultComet,
  defaultNebula,
  createTravel,
  defaultPlanet,
  encounterCruiseSpeed,
  encounterKind,
  encounterKindAt,
  encounterProfile,
  encounterSchedule,
  encounterSide,
  encounterViewMargin,
  kindDrawShare,
  mixHasPlanets,
  nebulaViewExtent,
  nextEncounterKind,
  runClass,
  setCruiseSpeed,
  stepTravel,
  updateAutopilot,
  warpEntryDuration,
  type ActiveEncounter,
  type AutopilotParams,
  type AutopilotState,
  type CometEncounter,
  type EncounterKind,
  type Travel,
  type TravelState,
} from './Autopilot';
import {
  encounterOffset,
  encounterRemaining,
  encounterTargetSpeed,
  planEncounter,
  sphereViewMargin,
  viewConeHalfAngle,
  type Encounter,
} from './encounter';
import { cometGlowGeometry, cometParams, type CometParams } from './Comet';
import { Nebula, nebulaParams, type NebulaParams } from './Nebula';
import { Planet, planetParams, type PlanetParams } from './Planet';
import { cameraFovDeg } from './renderSize';
import { hash, mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS, createShipState, updateShip, type ShipParams, type ShipState, type Vec3 } from './Ship';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (len(a) * len(b)))));
}

/** Distance from the origin to the segment from `a` to `b`. */
function originToSegment(a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, -dot(a, ab) / l2)) : 0;
  return Math.hypot(a.x + ab.x * t, a.y + ab.y * t, a.z + ab.z * t);
}

interface Frame {
  prev: Readonly<ShipState>;
  ship: Readonly<ShipState>;
  prevAutopilot: Readonly<AutopilotState>;
  autopilot: Readonly<AutopilotState>;
}

interface Transition {
  from: TravelState;
  to: TravelState;
  time: number;
  encounterIndex: number;
}

/**
 * Simulates travel from load, as the engine will run it: the ship steps with the autopilot's last
 * target speed and drift rate, then the autopilot reads the new ship state.
 */
function simulate(
  dt: number,
  options: {
    params?: Partial<AutopilotParams>;
    until: (autopilot: Readonly<AutopilotState>, transitions: readonly Transition[], time: number) => boolean;
    maxSeconds?: number;
    onFrame?: (frame: Frame) => void;
  },
): { transitions: Transition[]; ship: ShipState; autopilot: AutopilotState } {
  const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, ...options.params };
  let autopilot = createAutopilotState(params);
  const shipParams: ShipParams = {
    ...DEFAULT_SHIP_PARAMS,
    targetSpeed: autopilot.targetSpeed,
    driftRate: autopilot.driftRate,
  };
  let ship = createShipState({}, shipParams);
  const transitions: Transition[] = [];
  const maxSteps = Math.ceil((options.maxSeconds ?? 2000) / dt);
  for (let i = 0; i < maxSteps; i++) {
    const prev = ship;
    const prevAutopilot = autopilot;
    ship = updateShip(prev, dt, shipParams);
    autopilot = updateAutopilot(prevAutopilot, ship, dt, params);
    shipParams.targetSpeed = autopilot.targetSpeed;
    shipParams.driftRate = autopilot.driftRate;
    if (autopilot.state !== prevAutopilot.state) {
      transitions.push({
        from: prevAutopilot.state,
        to: autopilot.state,
        time: ship.time,
        encounterIndex: (autopilot.encounter ?? prevAutopilot.encounter)?.index ?? -1,
      });
    }
    options.onFrame?.({ prev, ship, prevAutopilot, autopilot });
    if (options.until(autopilot, transitions, ship.time)) return { transitions, ship, autopilot };
  }
  throw new Error(`simulation did not finish within ${options.maxSeconds ?? 2000} s`);
}

/**
 * Stated tolerance, in seconds, between the transition times of two runs at steps `dt1` and `dt2`
 * over `n` encounters: 2 × |dt1 - dt2| per encounter (about 1.5 × the drift measured below), plus a
 * frame of each.
 *
 * Each transition fires on the first frame past its threshold, so it lands up to one frame after the
 * exact time. The autopilot carries that overshoot into the next phase, so the lateness does not add
 * up across encounters. A small O(dt) difference per encounter remains, because the target speed is
 * updated only once per frame: through the slowdown the ship's position drifts by about 0.1 units
 * between dt = 1/60 and 1/120, which is about 0.016 s at the planet's closest approach (6 units per
 * second). The encounter ends a few units after it (out of view), still at about that speed, so the
 * offset carries into the next cruise: about 0.011 s per encounter between 1/60 and 1/120 (measured:
 * 0.17 s after 15 encounters, with the frame rounding), about 1.3 × |dt1 - dt2|. Before Phase 4 the
 * encounter ran on to the despawn distance at the encounter speed, where the same offset was about
 * a tenth of that in time.
 */
function timelineTolerance(n: number, dt1: number, dt2: number): number {
  return 2 * Math.abs(dt1 - dt2) * n + dt1 + dt2;
}

/** Stops once `n` encounters have finished (returned to CRUISE). */
const afterEncounters = (n: number) => (_a: Readonly<AutopilotState>, transitions: readonly Transition[]) =>
  transitions.filter((t) => t.to === 'CRUISE').length >= n;

/**
 * The planned direction is the heading at the start renormalized, so the acos of their dot product
 * can be off by one rounding step (acos(1 - 2^-52) is about 2.1e-8 rad); the hold itself is exact.
 */
const HELD_ANGLE_TOLERANCE = 1e-7;

/** Whether both frames hold the heading (APPROACH or FLYBY), so it must not change between them. */
const holdsHeading = (a: Readonly<AutopilotState>, b: Readonly<AutopilotState>): boolean =>
  (a.state === 'APPROACH' || a.state === 'FLYBY') && (b.state === 'APPROACH' || b.state === 'FLYBY');

const CYCLE: TravelState[] = ['APPROACH', 'FLYBY', 'DEPARTURE', 'CRUISE'];

/** The shares that make every encounter `kind` (as the engine's `encounterKind` option sets them). */
function onlyKind(kind: EncounterKind): Pick<AutopilotParams, 'nebulaShare' | 'asteroidShare' | 'cometShare'> {
  return { nebulaShare: kind === 'nebula' ? 1 : 0, asteroidShare: kind === 'asteroid' ? 1 : 0, cometShare: kind === 'comet' ? 1 : 0 };
}

/** The default params with every encounter a planet. */
const PLANETS_ONLY: Readonly<AutopilotParams> = { ...DEFAULT_AUTOPILOT_PARAMS, ...onlyKind('planet') };

/**
 * Whether the step to `autopilot` ended the encounter of `prevAutopilot` with its object out of view
 * (`encounterViewMargin` > 0 for the ship at the end of the step). Such an object is removed at
 * whatever fade it has, which no one sees; one that ran to its despawn distance has faded to 0.
 */
function endedOutOfView(
  prevAutopilot: Readonly<AutopilotState>,
  autopilot: Readonly<AutopilotState>,
  ship: Readonly<ShipState>,
  params: Readonly<AutopilotParams> = DEFAULT_AUTOPILOT_PARAMS,
): boolean {
  const encounter = prevAutopilot.encounter;
  if (encounter === null || autopilot.encounter !== null) return false;
  return encounterViewMargin(encounter, ship, params.viewHalfAngle) > 0;
}

describe('autopilot config', () => {
  it('the thresholds are consistent', () => {
    expect(ENCOUNTER_INTERVAL_SECONDS).toBeGreaterThan(0);
    expect(ENCOUNTER_DRIFT_SETTLE_SECONDS).toBeGreaterThan(0);
    expect(ENCOUNTER_DRIFT_SETTLE_SECONDS).toBeLessThanOrEqual(ENCOUNTER_INTERVAL_SECONDS);
    // The jitter keeps every cruise long enough for the drift to settle, and the first encounter
    // inside the 30–60 s after load that docs/PLAN.md section 9 (Phase 2) asks for (it fades in from
    // the frame after it starts; the 60 s bound leaves well over a second for that).
    expect(ENCOUNTER_INTERVAL_JITTER).toBeGreaterThanOrEqual(0);
    expect(ENCOUNTER_INTERVAL_JITTER).toBeLessThan(1);
    expect(ENCOUNTER_INTERVAL_SECONDS * (1 - ENCOUNTER_INTERVAL_JITTER)).toBeGreaterThanOrEqual(30);
    expect(ENCOUNTER_INTERVAL_SECONDS * (1 - ENCOUNTER_INTERVAL_JITTER)).toBeGreaterThanOrEqual(ENCOUNTER_DRIFT_SETTLE_SECONDS);
    expect(ENCOUNTER_INTERVAL_SECONDS * (1 + ENCOUNTER_INTERVAL_JITTER)).toBeLessThan(59);
    expect(Number.isInteger(ENCOUNTER_MAX_SAME_KIND_RUN)).toBe(true);
    expect(ENCOUNTER_MAX_SAME_KIND_RUN).toBeGreaterThanOrEqual(1);
    const [low, high] = ENCOUNTER_SIDE_ELEVATION_RANGE;
    expect(low).toBeLessThanOrEqual(high);
    // Never straight above or below the path, so "left" and "right" stay meaningful.
    expect(Math.max(Math.abs(low), Math.abs(high))).toBeLessThan(Math.PI / 2);
    expect(ENCOUNTER_FLYBY_DISTANCE).toBeGreaterThan(0);
    expect(ENCOUNTER_FLYBY_DISTANCE).toBeLessThan(ENCOUNTER_DISTANCE);
    expect(ENCOUNTER_PLANET_RADIUS).toBeGreaterThan(0);
    // The planet is planned past the slowdown, so the encounter starts at cruise speed.
    expect(ENCOUNTER_DISTANCE).toBeGreaterThanOrEqual(ENCOUNTER_SLOWDOWN_DISTANCE);
    // Dropping out of warp: the arrival speed is the default level's cruise speed, so the faster
    // levels fly the default level's encounters and the slower ones keep their own.
    expect(ENCOUNTER_ARRIVAL_SPEED).toBe(SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL]);
    expect(ENCOUNTER_WARP_EXIT_SECONDS).toBeGreaterThan(0);
    expect(ENCOUNTER_WARP_ENTRY_SECONDS).toBeGreaterThan(0);
    // The lead leaves the ship's speed lag (time constant tau) at least one tau to settle.
    expect(ENCOUNTER_WARP_EXIT_LEAD_SECONDS).toBeGreaterThanOrEqual(SHIP_SPEED_TAU_SECONDS);
    // Even the shortest jittered cruise has room to return to warp and drop out of it again.
    expect(ENCOUNTER_INTERVAL_SECONDS * (1 - ENCOUNTER_INTERVAL_JITTER)).toBeGreaterThan(
      ENCOUNTER_WARP_ENTRY_SECONDS + ENCOUNTER_WARP_EXIT_SECONDS + ENCOUNTER_WARP_EXIT_LEAD_SECONDS,
    );
  });

  it('defaults to the config values', () => {
    expect(DEFAULT_AUTOPILOT_PARAMS.interval).toBe(ENCOUNTER_INTERVAL_SECONDS);
    expect(DEFAULT_AUTOPILOT_PARAMS.arrivalSpeed).toBe(ENCOUNTER_ARRIVAL_SPEED);
    expect(DEFAULT_AUTOPILOT_PARAMS.warpExitTime).toBe(ENCOUNTER_WARP_EXIT_SECONDS);
    expect(DEFAULT_AUTOPILOT_PARAMS.warpExitLead).toBe(ENCOUNTER_WARP_EXIT_LEAD_SECONDS);
    expect(DEFAULT_AUTOPILOT_PARAMS.warpEntryTime).toBe(ENCOUNTER_WARP_ENTRY_SECONDS);
    expect(DEFAULT_AUTOPILOT_PARAMS.encounterDistance).toBe(ENCOUNTER_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.sideOffsetFactor).toBe(ENCOUNTER_SIDE_OFFSET_FACTOR);
    expect(DEFAULT_AUTOPILOT_PARAMS.profile.despawnDistance).toBe(ENCOUNTER_DESPAWN_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.baseSeed).toBe(ENCOUNTER_BASE_SEED);
    expect(defaultPlanet(123).radius).toBe(ENCOUNTER_PLANET_RADIUS);
    expect(DEFAULT_AUTOPILOT_PARAMS.nebulaShare).toBe(ENCOUNTER_NEBULA_SHARE);
    expect(DEFAULT_AUTOPILOT_PARAMS.intervalJitter).toBe(ENCOUNTER_INTERVAL_JITTER);
    expect(DEFAULT_AUTOPILOT_PARAMS.maxSameKindRun).toBe(ENCOUNTER_MAX_SAME_KIND_RUN);
    expect(DEFAULT_AUTOPILOT_PARAMS.sideElevation).toBe(ENCOUNTER_SIDE_ELEVATION_RANGE);
    expect(DEFAULT_AUTOPILOT_PARAMS.nebula.encounterDistance).toBe(NEBULA_ENCOUNTER_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.nebula.sideOffsetFactor).toBe(NEBULA_SIDE_OFFSET_FACTOR);
    expect(DEFAULT_AUTOPILOT_PARAMS.nebula.profile).toBe(NEBULA_ENCOUNTER_PROFILE);
    expect(NEBULA_ENCOUNTER_PROFILE.despawnDistance).toBe(NEBULA_DESPAWN_DISTANCE);
    expect(NEBULA_ENCOUNTER_PROFILE.spawnScale).toBe(1);
    expect(defaultNebula(123).radius).toBeGreaterThan(0);
    const [low, high] = ENCOUNTER_NEBULA_SHARE_BOUNDS;
    expect(ENCOUNTER_NEBULA_SHARE).toBeGreaterThan(low);
    expect(ENCOUNTER_NEBULA_SHARE).toBeLessThan(high);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
    expect(DEFAULT_AUTOPILOT_PARAMS.asteroidShare).toBe(ENCOUNTER_ASTEROID_SHARE);
    expect(DEFAULT_AUTOPILOT_PARAMS.asteroid.encounterDistance).toBe(ASTEROID_ENCOUNTER_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.asteroid.sideOffsetFactor).toBe(ASTEROID_SIDE_OFFSET_FACTOR);
    expect(DEFAULT_AUTOPILOT_PARAMS.asteroid.profile).toBe(ASTEROID_ENCOUNTER_PROFILE);
    expect(ASTEROID_ENCOUNTER_PROFILE.despawnDistance).toBe(ASTEROID_DESPAWN_DISTANCE);
    expect(ASTEROID_ENCOUNTER_PROFILE.spawnScale).toBe(1);
    expect(defaultAsteroid(123).radius).toBeGreaterThan(0);
    const [aLow, aHigh] = ENCOUNTER_ASTEROID_SHARE_BOUNDS;
    expect(ENCOUNTER_ASTEROID_SHARE).toBeGreaterThan(aLow);
    expect(ENCOUNTER_ASTEROID_SHARE).toBeLessThan(aHigh);
    expect(aLow).toBeGreaterThan(0);
    expect(DEFAULT_AUTOPILOT_PARAMS.cometShare).toBe(ENCOUNTER_COMET_SHARE);
    expect(DEFAULT_AUTOPILOT_PARAMS.comet.encounterDistance).toBe(COMET_ENCOUNTER_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.comet.sideOffsetFactor).toBe(COMET_SIDE_OFFSET_FACTOR);
    expect(DEFAULT_AUTOPILOT_PARAMS.comet.profile).toBe(COMET_ENCOUNTER_PROFILE);
    expect(COMET_ENCOUNTER_PROFILE.despawnDistance).toBe(COMET_DESPAWN_DISTANCE);
    expect(COMET_ENCOUNTER_PROFILE.spawnScale).toBe(1);
    // The comet is planned past its slowdown, so its encounter starts at the arrival speed.
    expect(COMET_ENCOUNTER_DISTANCE).toBeGreaterThan(COMET_ENCOUNTER_PROFILE.slowdownDistance);
    expect(defaultComet(123).radius).toBeGreaterThan(0);
    const [cLow, cHigh] = ENCOUNTER_COMET_SHARE_BOUNDS;
    expect(ENCOUNTER_COMET_SHARE).toBeGreaterThan(cLow);
    expect(ENCOUNTER_COMET_SHARE).toBeLessThan(cHigh);
    expect(cLow).toBeGreaterThan(0);
    // The asteroids and comets come out of the planets' share, which stays the largest; comets are
    // the rarest kind, rarer than planets (docs/PLAN.md section 9, Phase 4).
    const planetShare = 1 - ENCOUNTER_NEBULA_SHARE - ENCOUNTER_ASTEROID_SHARE - ENCOUNTER_COMET_SHARE;
    expect(planetShare).toBeGreaterThan(ENCOUNTER_NEBULA_SHARE);
    expect(ENCOUNTER_COMET_SHARE).toBeLessThan(ENCOUNTER_ASTEROID_SHARE);
    expect(ENCOUNTER_COMET_SHARE).toBeLessThan(planetShare);
  });
});

describe('encounterKind', () => {
  it('is a deterministic seeded draw: a share of 0 gives only planets and 1 only nebulae', () => {
    for (let i = 0; i < 200; i++) {
      const seed = hash(ENCOUNTER_BASE_SEED, i);
      expect(encounterKind(seed, 0.5)).toBe(encounterKind(seed, 0.5));
      expect(encounterKind(seed, 0)).toBe('planet');
      expect(encounterKind(seed, 1)).toBe('nebula');
    }
  });
});

/** Longest run of equal consecutive values. */
function longestRun<T>(values: readonly T[]): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run = i > 0 && values[i] === values[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

describe('encounter schedule', () => {
  const BASE_SEEDS = [ENCOUNTER_BASE_SEED, 1, 0xdeadbeef, 0x12345678, 2024];

  it('kindDrawShare inverts cappedNebulaShare, and is the share itself without a cap', () => {
    for (const share of [0.35, 0.5, 0.6]) {
      for (const run of [2, 3, 5]) {
        expect(cappedNebulaShare(kindDrawShare(share, run), run)).toBeCloseTo(share, 9);
      }
      expect(kindDrawShare(share, Number.POSITIVE_INFINITY)).toBe(share);
      expect(cappedNebulaShare(share, Number.POSITIVE_INFINITY)).toBe(share);
    }
    // With runs capped at n, the share can only lie in [1 / (n + 1), n / (n + 1)]; a share outside
    // gets as close as it can.
    expect(cappedNebulaShare(kindDrawShare(0.1, 2), 2)).toBeCloseTo(1 / 3, 6);
    expect(cappedNebulaShare(kindDrawShare(0.9, 2), 2)).toBeCloseTo(2 / 3, 6);
    const n = ENCOUNTER_MAX_SAME_KIND_RUN;
    expect(ENCOUNTER_NEBULA_SHARE).toBeGreaterThan(1 / (n + 1));
    expect(ENCOUNTER_NEBULA_SHARE).toBeLessThan(n / (n + 1));
    // A cap at 1 alternates the kinds whatever the draw (so no draw share can give another share).
    expect(cappedNebulaShare(0.2, 1)).toBeCloseTo(0.5, 12);
    expect(cappedNebulaShare(0.9, 1)).toBeCloseTo(0.5, 12);
    expect(kindDrawShare(0, 3)).toBe(0);
    expect(kindDrawShare(1, 3)).toBe(1);
  });

  it('over 1,000 encounters per base seed: every kind at shares within bounds, no run of any kind longer than the cap', () => {
    const [low, high] = ENCOUNTER_NEBULA_SHARE_BOUNDS;
    const [aLow, aHigh] = ENCOUNTER_ASTEROID_SHARE_BOUNDS;
    const [cLow, cHigh] = ENCOUNTER_COMET_SHARE_BOUNDS;
    for (const baseSeed of BASE_SEEDS) {
      const label = `base seed ${baseSeed}`;
      const schedule = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 1000);
      const kinds = schedule.map((e) => e.kind);
      expect(encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 1000)).toEqual(schedule);
      const share = (kind: EncounterKind) => kinds.filter((k) => k === kind).length / kinds.length;
      expect(share('nebula'), label).toBeGreaterThanOrEqual(low);
      expect(share('nebula'), label).toBeLessThanOrEqual(high);
      expect(share('asteroid'), label).toBeGreaterThanOrEqual(aLow);
      expect(share('asteroid'), label).toBeLessThanOrEqual(aHigh);
      expect(share('comet'), label).toBeGreaterThanOrEqual(cLow);
      expect(share('comet'), label).toBeLessThanOrEqual(cHigh);
      // Planets stay the most common kind (0.40 against 0.35 nebulae; measured at least 0.36 against
      // at most 0.354 for these trips), and comets the rarest.
      expect(share('planet'), label).toBeGreaterThan(share('nebula'));
      expect(share('planet'), label).toBeGreaterThan(share('asteroid'));
      expect(share('asteroid'), label).toBeGreaterThan(share('comet'));
      // No kind runs longer than the cap, and nor do planets, asteroids and comets together (the run class).
      expect(longestRun(kinds), label).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
      const classes = kinds.map(runClass);
      expect(longestRun(classes), label).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
      // The cap is in effect: runs reach it (they would run longer without it), and the solid bodies
      // mix within their runs.
      expect(longestRun(classes), label).toBe(ENCOUNTER_MAX_SAME_KIND_RUN);
      expect(longestRun(kinds.filter((k) => k !== 'nebula')), label).toBeGreaterThan(1);
      const uncapped = schedule.map((e) => encounterKind(e.seed, ENCOUNTER_NEBULA_SHARE));
      expect(longestRun(uncapped), `${label}: uncapped`).toBeGreaterThan(ENCOUNTER_MAX_SAME_KIND_RUN);
    }
  });

  it('over 50,000 encounters the nebula, asteroid and comet shares are the configured shares, within 0.01', () => {
    // The standard error of the share over 50,000 encounters is about 0.002, so the 0.01 tolerance
    // is about 5 standard errors: an uncompensated draw (a nebula share of about 0.415) fails it.
    for (const baseSeed of [ENCOUNTER_BASE_SEED, 0xdeadbeef]) {
      const kinds = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 50_000).map((e) => e.kind);
      const share = (kind: EncounterKind) => kinds.filter((k) => k === kind).length / kinds.length;
      const label = `base seed ${baseSeed}: ${share('planet')} / ${share('nebula')} / ${share('asteroid')} / ${share('comet')}`;
      expect(Math.abs(share('nebula') - ENCOUNTER_NEBULA_SHARE), label).toBeLessThan(0.01);
      expect(Math.abs(share('asteroid') - ENCOUNTER_ASTEROID_SHARE), label).toBeLessThan(0.01);
      expect(Math.abs(share('comet') - ENCOUNTER_COMET_SHARE), label).toBeLessThan(0.01);
      // The planets keep the rest: 0.4, from 0.5 before comets and 0.65 before asteroids.
      const planets = 1 - ENCOUNTER_NEBULA_SHARE - ENCOUNTER_ASTEROID_SHARE - ENCOUNTER_COMET_SHARE;
      expect(Math.abs(share('planet') - planets), label).toBeLessThan(0.01);
      expect(longestRun(kinds), label).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
      expect(longestRun(kinds.map(runClass)), label).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
    }
  });

  it('asteroids only turn planets into asteroids: every nebula stays where it was without them, for any base seed', () => {
    const random = mulberry32(0xa57e_5eed);
    const baseSeeds = [ENCOUNTER_BASE_SEED, ...Array.from({ length: 49 }, () => Math.floor(random() * 2 ** 32))];
    let asteroids = 0;
    for (const baseSeed of baseSeeds) {
      // Without asteroids, and without comets either (which would otherwise take a larger share of the
      // planets).
      const withAsteroids = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed, cometShare: 0 }, 500);
      const without = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed, asteroidShare: 0, cometShare: 0 }, 500);
      for (let i = 0; i < 500; i++) {
        const a = withAsteroids[i]!;
        const b = without[i]!;
        const label = `base seed ${baseSeed}, encounter ${i}`;
        // The same seed, side and cruise, and a nebula exactly where there was one.
        expect({ ...a, kind: runClass(a.kind) }, label).toEqual(b);
        // An asteroid where the second draw makes one of a planet (never the first encounter).
        if (b.kind === 'planet') {
          expect(a.kind, label).toBe(i === 0 ? 'planet' : bodyKind(a.seed, asteroidFraction(DEFAULT_AUTOPILOT_PARAMS)));
        }
        if (a.kind === 'asteroid') asteroids++;
      }
    }
    expect(asteroids).toBeGreaterThan(0.1 * 50 * 500);
    expect(asteroidFraction(DEFAULT_AUTOPILOT_PARAMS)).toBeCloseTo(ENCOUNTER_ASTEROID_SHARE / (1 - ENCOUNTER_NEBULA_SHARE), 12);
  });

  it('comets only turn planets into comets: every nebula and every asteroid stays where it was without them, for any base seed', () => {
    const random = mulberry32(0xc0e7_5eed);
    const baseSeeds = [ENCOUNTER_BASE_SEED, ...Array.from({ length: 49 }, () => Math.floor(random() * 2 ** 32))];
    let comets = 0;
    const fraction = cometFraction(DEFAULT_AUTOPILOT_PARAMS);
    for (const baseSeed of baseSeeds) {
      const withComets = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 500);
      const without = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed, cometShare: 0 }, 500);
      for (let i = 0; i < 500; i++) {
        const a = withComets[i]!;
        const b = without[i]!;
        const label = `base seed ${baseSeed}, encounter ${i}`;
        // The same seed, side and cruise, and a nebula or an asteroid exactly where there was one.
        expect({ ...a, kind: a.kind === 'comet' ? 'planet' : a.kind }, label).toEqual(b);
        // A comet where the third draw makes one of a planet (never the first encounter).
        if (b.kind === 'planet') {
          expect(a.kind, label).toBe(i === 0 ? 'planet' : bodyKind(a.seed, asteroidFraction(DEFAULT_AUTOPILOT_PARAMS), fraction));
        }
        if (a.kind === 'comet') comets++;
      }
    }
    expect(comets).toBeGreaterThan(0.07 * 50 * 500);
    // The fraction of the bodies left after the asteroids that are comets gives the comet share.
    expect(fraction).toBeCloseTo(ENCOUNTER_COMET_SHARE / (1 - ENCOUNTER_NEBULA_SHARE - ENCOUNTER_ASTEROID_SHARE), 12);
  });

  it('the default opening: the first default encounter is a planet, within 30–60 s of load, then a nebula at index 1 or 2', () => {
    // The default base seed is the test default trip seed (ENCOUNTER_BASE_SEED); production draws a
    // random one on each load (the simulation test below checks the autopilot meets the schedule in
    // order, and the tests below check the planet first for any base seed).
    const [first, second, third] = encounterSchedule(DEFAULT_AUTOPILOT_PARAMS, 3);
    expect(first!.kind).toBe('planet');
    expect(first!.interval).toBeGreaterThanOrEqual(30);
    expect(first!.interval).toBeLessThanOrEqual(60);
    expect([second!.kind, third!.kind]).toContain('nebula');
  });

  it('the default test seed: its opening (planet, nebula, planet, nebula) is kept, an asteroid comes fifth and a comet sixth, and its first 50 encounters hold several of each', () => {
    // docs/PLAN.md section 9, Phase 4: with the documented default test seed, the first 50
    // encounters include at least one asteroid and one comet (and a ringed planet and an icy dwarf,
    // Planet.test.ts).
    const kinds = encounterSchedule(DEFAULT_AUTOPILOT_PARAMS, 50).map((e) => e.kind);
    expect(kinds.slice(0, 6)).toEqual(['planet', 'nebula', 'planet', 'nebula', 'asteroid', 'comet']);
    const count = (kind: EncounterKind) => kinds.filter((k) => k === kind).length;
    // Measured: 22 planets, 17 nebulae, 7 asteroids and 4 comets (at 5, 8, 14 and 22).
    expect(count('asteroid')).toBeGreaterThanOrEqual(5);
    expect(count('comet')).toBeGreaterThanOrEqual(3);
    expect(count('planet') + count('nebula') + count('asteroid') + count('comet')).toBe(50);
    // Without comets the same trip is the same, with those planets in their place; without asteroids
    // and comets alike, every solid body is a planet and every nebula where it was.
    const withoutComets = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, cometShare: 0 }, 50).map((e) => e.kind);
    expect(kinds.map((k) => (k === 'comet' ? 'planet' : k))).toEqual(withoutComets);
    const without = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, asteroidShare: 0, cometShare: 0 }, 50).map((e) => e.kind);
    expect(kinds.map(runClass)).toEqual(without);
  });

  it('for any base seed, encounter 0 is a planet whose cruise from load lasts 30–60 s (10,000 base seeds)', () => {
    // The base seed is the trip seed, random on each load in production (src/tripSeed.ts).
    const random = mulberry32(0x0f1a_e7ed);
    const baseSeeds = [0, 1, ENCOUNTER_BASE_SEED, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff];
    while (baseSeeds.length < 10_000) baseSeeds.push(Math.floor(random() * 2 ** 32));
    let drawnNebulae = 0;
    for (const baseSeed of baseSeeds) {
      const params = { ...DEFAULT_AUTOPILOT_PARAMS, baseSeed };
      const [first] = encounterSchedule(params, 1);
      const label = `base seed ${baseSeed}`;
      expect(first!.kind, label).toBe('planet');
      expect(first!.interval, label).toBeGreaterThanOrEqual(30);
      expect(first!.interval, label).toBeLessThanOrEqual(60);
      if (nextEncounterKind(first!.seed, params, null, 0) === 'nebula') drawnNebulae++;
    }
    // The rule is in effect: the plain draw would open with a nebula for about a third of the seeds.
    expect(drawnNebulae).toBeGreaterThan(2000);
  });

  it('for any base seed, the autopilot meets a planet first, visible within 30–60 s of load at the default level', () => {
    const random = mulberry32(0x0f1a_5eed);
    for (let i = 0; i < 100; i++) {
      const baseSeed = Math.floor(random() * 2 ** 32);
      const label = `base seed ${baseSeed}`;
      let firstVisible = Number.NaN;
      const { autopilot, transitions } = simulate(1 / 60, {
        params: { baseSeed, planetFor: planetParams, nebulaFor: nebulaParams },
        until: (a) => a.fade > 0,
        maxSeconds: 70,
        onFrame: ({ ship, autopilot: a }) => {
          if (Number.isNaN(firstVisible) && a.fade > 0) firstVisible = ship.time;
        },
      });
      expect(transitions.map((t) => t.to), label).toEqual(['APPROACH']);
      expect(autopilot.encounter!.index, label).toBe(0);
      expect(autopilot.encounter!.kind, label).toBe('planet');
      expect(firstVisible, label).toBeGreaterThanOrEqual(30);
      expect(firstVisible, label).toBeLessThanOrEqual(60);
    }
  });

  it('encounterKindAt: a planet at index 0 unless the mix has no planets, nextEncounterKind after that', () => {
    const params = { nebulaShare: ENCOUNTER_NEBULA_SHARE, asteroidShare: ENCOUNTER_ASTEROID_SHARE, cometShare: ENCOUNTER_COMET_SHARE, maxSameKindRun: 3 };
    let asteroidsAfterFirst = 0;
    let cometsAfterFirst = 0;
    // The guard is the mix having planets at all: a nebula share below 1 and solid bodies not all
    // asteroids or comets.
    expect(mixHasPlanets(params)).toBe(true);
    expect(mixHasPlanets({ ...params, nebulaShare: 1 })).toBe(false);
    expect(mixHasPlanets({ ...params, nebulaShare: 0.5, asteroidShare: 0.5, cometShare: 0 })).toBe(false);
    expect(mixHasPlanets({ ...params, nebulaShare: 0.5, asteroidShare: 0.2, cometShare: 0.3 })).toBe(false);
    expect(mixHasPlanets({ ...params, nebulaShare: 0.5, asteroidShare: 0.2, cometShare: 0.29 })).toBe(true);
    for (let i = 0; i < 300; i++) {
      const seed = hash(ENCOUNTER_BASE_SEED, i);
      expect(encounterKindAt(0, seed, params, null, 0)).toBe('planet');
      expect(encounterKindAt(0, seed, { ...params, nebulaShare: 0 }, null, 0)).toBe('planet');
      expect(encounterKindAt(0, seed, { ...params, nebulaShare: 1 }, null, 0)).toBe('nebula');
      // Forced kinds, as the engine's `encounterKind` option sets them.
      for (const kind of ['planet', 'nebula', 'asteroid', 'comet'] as const) {
        const forced = { ...params, ...onlyKind(kind) };
        expect(encounterKindAt(0, seed, forced, null, 0)).toBe(kind);
        expect(encounterKindAt(i + 1, seed, forced, kind, 50)).toBe(kind);
      }
      // A mix of nebulae and asteroids only has no planet to open with: it draws its first encounter.
      const noPlanets = { ...params, nebulaShare: 0.5, asteroidShare: 0.5, cometShare: 0 };
      expect(encounterKindAt(0, seed, noPlanets, null, 0)).toBe(nextEncounterKind(seed, noPlanets, null, 0));
      expect(encounterKindAt(0, seed, noPlanets, null, 0)).not.toBe('planet');
      const next = encounterKindAt(i + 1, seed, params, 'nebula', 1);
      if (next === 'asteroid') asteroidsAfterFirst++;
      if (next === 'comet') cometsAfterFirst++;
      for (const [lastKind, run] of [['planet', 1], ['nebula', 2], ['planet', 3], ['asteroid', 3], ['comet', 3]] as const) {
        expect(encounterKindAt(i + 1, seed, params, lastKind, run)).toBe(nextEncounterKind(seed, params, lastKind, run));
      }
    }
    // The planet first is the only rule: later encounters are asteroids and comets at their shares.
    expect(asteroidsAfterFirst).toBeGreaterThan(20);
    expect(cometsAfterFirst).toBeGreaterThan(10);
  });

  it('nextEncounterKind: planets, asteroids and comets share one run, so a body after three bodies is a nebula, whichever they were', () => {
    const params = { nebulaShare: ENCOUNTER_NEBULA_SHARE, asteroidShare: ENCOUNTER_ASTEROID_SHARE, cometShare: ENCOUNTER_COMET_SHARE, maxSameKindRun: 3 };
    const draw = kindDrawShare(ENCOUNTER_NEBULA_SHARE, 3);
    const fraction = asteroidFraction(params);
    const comet = cometFraction(params);
    let asteroids = 0;
    let comets = 0;
    for (let i = 0; i < 1000; i++) {
      const seed = hash(0xb0d1e5, i);
      const body = bodyKind(seed, fraction, comet);
      if (encounterKind(seed, draw) === 'nebula') {
        expect(nextEncounterKind(seed, params, 'planet', 1)).toBe('nebula');
        // A nebula drawn after three nebulae is a body instead: a planet or an asteroid by the second draw.
        expect(nextEncounterKind(seed, params, 'nebula', 3)).toBe(body);
        continue;
      }
      if (body === 'asteroid') asteroids++;
      if (body === 'comet') comets++;
      // Comets never take an asteroid's place.
      if (bodyKind(seed, fraction) === 'asteroid') expect(body).toBe('asteroid');
      expect(nextEncounterKind(seed, params, null, 0)).toBe(body);
      expect(nextEncounterKind(seed, params, 'nebula', 3)).toBe(body);
      for (const last of ['planet', 'asteroid', 'comet'] as const) {
        expect(nextEncounterKind(seed, params, last, 2)).toBe(body);
        expect(nextEncounterKind(seed, params, last, 3)).toBe('nebula');
      }
    }
    expect(asteroids).toBeGreaterThan(100);
    expect(comets).toBeGreaterThan(50);
    // The run class: planets, asteroids and comets are bodies.
    expect([runClass('planet'), runClass('asteroid'), runClass('comet'), runClass('nebula'), runClass(null)]).toEqual(['planet', 'planet', 'planet', 'nebula', null]);
    // The fraction of the bodies that are asteroids gives the asteroid share of all encounters.
    expect(asteroidFraction({ nebulaShare: 0.35, asteroidShare: 0.15 })).toBeCloseTo(0.15 / 0.65, 12);
    expect(asteroidFraction({ nebulaShare: 0, asteroidShare: 1 })).toBe(1);
    expect(asteroidFraction({ nebulaShare: 0.5, asteroidShare: 0.9 })).toBe(1);
    expect(asteroidFraction({ nebulaShare: 1, asteroidShare: 0.5 })).toBe(0);
    expect(asteroidFraction({ nebulaShare: 0.35 })).toBe(0);
    // The fraction of the bodies left after the asteroids that are comets gives the comet share.
    expect(cometFraction({ nebulaShare: 0.35, asteroidShare: 0.15, cometShare: 0.1 })).toBeCloseTo(0.1 / 0.5, 12);
    expect(cometFraction({ nebulaShare: 0, asteroidShare: 0, cometShare: 1 })).toBe(1);
    expect(cometFraction({ nebulaShare: 0.5, asteroidShare: 0.3, cometShare: 0.5 })).toBe(1);
    expect(cometFraction({ nebulaShare: 0, asteroidShare: 1, cometShare: 0.5 })).toBe(0);
    expect(cometFraction({ nebulaShare: 1, cometShare: 0.5 })).toBe(0);
    expect(cometFraction({ nebulaShare: 0.35, asteroidShare: 0.15 })).toBe(0);
  });

  it('nextEncounterKind keeps the draw until the run reaches the cap, then switches kind', () => {
    const params = { nebulaShare: ENCOUNTER_NEBULA_SHARE, maxSameKindRun: 3 };
    const draw = kindDrawShare(ENCOUNTER_NEBULA_SHARE, 3);
    for (let i = 0; i < 300; i++) {
      const seed = hash(ENCOUNTER_BASE_SEED, i);
      const drawn = encounterKind(seed, draw);
      const other = drawn === 'planet' ? 'nebula' : 'planet';
      expect(nextEncounterKind(seed, params, null, 0)).toBe(drawn);
      expect(nextEncounterKind(seed, params, drawn, 2)).toBe(drawn);
      expect(nextEncounterKind(seed, params, other, 3)).toBe(drawn);
      expect(nextEncounterKind(seed, params, drawn, 3)).toBe(other);
      // Forced kinds ignore the cap.
      expect(nextEncounterKind(seed, { ...params, nebulaShare: 0 }, 'planet', 50)).toBe('planet');
      expect(nextEncounterKind(seed, { ...params, nebulaShare: 1 }, 'nebula', 50)).toBe('nebula');
      // No cap: the plain draw.
      expect(nextEncounterKind(seed, { ...params, maxSameKindRun: Number.POSITIVE_INFINITY }, drawn, 50)).toBe(
        encounterKind(seed, ENCOUNTER_NEBULA_SHARE),
      );
    }
  });

  it('every cruise interval lies within the configured jitter, and their mean is the configured interval', () => {
    const lowest = ENCOUNTER_INTERVAL_SECONDS * (1 - ENCOUNTER_INTERVAL_JITTER);
    const highest = ENCOUNTER_INTERVAL_SECONDS * (1 + ENCOUNTER_INTERVAL_JITTER);
    for (const baseSeed of BASE_SEEDS) {
      const intervals = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 1000).map((e) => e.interval);
      for (const interval of intervals) {
        expect(interval).toBeGreaterThanOrEqual(lowest);
        expect(interval).toBeLessThanOrEqual(highest);
      }
      expect(new Set(intervals).size).toBeGreaterThan(900);
      // Stated tolerance: 1% of the interval (the standard error of the mean of 1,000 draws is about
      // 0.3%).
      const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
      expect(Math.abs(mean - ENCOUNTER_INTERVAL_SECONDS)).toBeLessThan(0.01 * ENCOUNTER_INTERVAL_SECONDS);
    }
    // No jitter gives the interval itself; the jitter is clamped to [0, 1].
    expect(cruiseIntervalFor(123, 40, 0)).toBe(40);
    expect(cruiseIntervalFor(123, 40, 5)).toBe(cruiseIntervalFor(123, 40, 1));
    expect(cruiseIntervalFor(123, 40, 1)).toBeGreaterThanOrEqual(0);
    expect(cruiseIntervalFor(123, 0, 0.2)).toBe(0);
  });

  it('over 1,000 seeds both sides occur, at elevations within the configured range', () => {
    const counts = { left: 0, right: 0 };
    const [low, high] = ENCOUNTER_SIDE_ELEVATION_RANGE;
    for (let i = 0; i < 1000; i++) {
      const seed = hash(ENCOUNTER_BASE_SEED, i);
      const { side, elevation, sideAngle } = encounterSide(seed);
      expect(encounterSide(seed)).toEqual({ side, elevation, sideAngle });
      counts[side]++;
      expect(elevation).toBeGreaterThanOrEqual(low);
      expect(elevation).toBeLessThanOrEqual(high);
      // Planned along -Z (right is +X, up is +Y), the object is on that side at that elevation.
      const plan = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 100, 1600, 2, sideAngle);
      expect(Math.sign(plan.side.x)).toBe(side === 'right' ? 1 : -1);
      expect(plan.side.y).toBeCloseTo(Math.sin(elevation), 12);
    }
    expect(counts.left).toBeGreaterThan(400);
    expect(counts.right).toBeGreaterThan(400);
  });
});

describe('createAutopilotState', () => {
  it('starts in CRUISE at cruise speed with full drift and no encounter', () => {
    const s = createAutopilotState();
    expect(s).toEqual({
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
      targetSpeed: DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed,
      driftRate: 1,
    });
  });
});

describe('updateAutopilot', () => {
  it('is pure: the input state is not modified, and writing into the input gives the same result', () => {
    const ship = createShipState({ time: 10, speed: 60 });
    const state = { ...createAutopilotState(), cruiseTime: cruiseInterval(DEFAULT_AUTOPILOT_PARAMS, 0) - 0.01 };
    const snapshot = structuredClone(state);
    const fresh = updateAutopilot(state, ship, 1 / 60);
    expect(state).toEqual(snapshot);
    expect(fresh.state).toBe('APPROACH');
    const inPlace = updateAutopilot(state, ship, 1 / 60, DEFAULT_AUTOPILOT_PARAMS, state);
    expect(inPlace).toBe(state);
    expect(inPlace).toEqual(fresh);
  });

  it('a zero, negative or NaN dt changes nothing in CRUISE, and dt is capped like the ship', () => {
    const ship = createShipState();
    const start = createAutopilotState();
    for (const dt of [0, -1, Number.NaN]) expect(updateAutopilot(start, ship, dt)).toEqual(start);
    expect(updateAutopilot(start, ship, 5).cruiseTime).toBe(DT_CAP_SECONDS);
  });

  it('plans the encounter along the ship heading with the next index and seed', () => {
    const ship = createShipState({ time: 77, speed: 60, position: { x: 1e6, y: -3e5, z: 2e7 } });
    const state = { ...createAutopilotState(), cruiseTime: cruiseInterval(PLANETS_ONLY, 4), encounterCount: 4 };
    const next = updateAutopilot(state, ship, 1 / 60, PLANETS_ONLY);
    expect(next.state).toBe('APPROACH');
    expect(next.encounterCount).toBe(5);
    // The encounter starts one frame late; that lateness is kept for the next cruise.
    expect(next.cruiseTime).toBeCloseTo(1 / 60, 12);
    const encounter = next.encounter!;
    expect(encounter.index).toBe(4);
    expect(encounter.seed).toBe(hash(ENCOUNTER_BASE_SEED, 4));
    expect(encounter.kind).toBe('planet');
    expect(next.lastKind).toBe('planet');
    expect(next.kindRun).toBe(1);
    // On its seeded side of the path.
    const { side, sideAngle } = encounterSide(encounter.seed);
    expect(encounter.side).toBe(side);
    expect(encounter.plan).toEqual(planEncounter(ship.position, ship.heading, ENCOUNTER_PLANET_RADIUS, ENCOUNTER_DISTANCE, ENCOUNTER_SIDE_OFFSET_FACTOR, sideAngle));
    expect(encounter.kind === 'planet' && encounter.planet.radius).toBe(ENCOUNTER_PLANET_RADIUS);
    expect(encounter.plan.radius).toBe(ENCOUNTER_PLANET_RADIUS);
    expect(encounter.plan.origin).toEqual(ship.position);
    expect(angleBetween(encounter.plan.direction, ship.heading)).toBeLessThan(1e-12);
    expect(next.remaining).toBeCloseTo(ENCOUNTER_DISTANCE, 6);
    // It appears at opacity 0, at cruise speed, with the drift held.
    expect(next.fade).toBe(0);
    expect(next.targetSpeed).toBe(DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed);
    expect(next.driftRate).toBe(0);
  });

  it('uses the planet chosen for the seed (hook for seeded planets)', () => {
    const seen: number[] = [];
    const params: AutopilotParams = {
      ...PLANETS_ONLY,
      planetFor: (seed) => {
        seen.push(seed);
        return { radius: 333 };
      },
    };
    const state = { ...createAutopilotState(params), cruiseTime: cruiseInterval(params, 0) };
    const next = updateAutopilot(state, createShipState(), 1 / 60, params);
    expect(seen).toEqual([hash(ENCOUNTER_BASE_SEED, 0)]);
    expect(next.encounter!.plan.radius).toBe(333);
    expect(next.encounter!.plan.closestDistance).toBe(333 * ENCOUNTER_SIDE_OFFSET_FACTOR);
  });
});

describe('nebula encounters', () => {
  const NEBULAE_ONLY: Readonly<AutopilotParams> = { ...DEFAULT_AUTOPILOT_PARAMS, nebulaShare: 1 };

  it('plan a nebula with its own D and side offset, chosen for the seed', () => {
    const seen: number[] = [];
    const params: AutopilotParams = {
      ...NEBULAE_ONLY,
      planetFor: () => {
        throw new Error('planetFor called for a nebula');
      },
      nebulaFor: (seed) => {
        seen.push(seed);
        return { radius: 250 };
      },
    };
    const ship = createShipState({ speed: 60, position: { x: -4e8, y: 2e3, z: 7e9 } });
    const state = { ...createAutopilotState(params), cruiseTime: cruiseInterval(params, 2), encounterCount: 2 };
    const next = updateAutopilot(state, ship, 1 / 60, params);
    expect(next.state).toBe('APPROACH');
    const encounter = next.encounter!;
    expect(encounter.kind).toBe('nebula');
    expect(encounter.kind === 'nebula' && encounter.nebula).toEqual({ radius: 250 });
    expect(seen).toEqual([hash(ENCOUNTER_BASE_SEED, 2)]);
    expect(encounter.plan.radius).toBe(250);
    expect(encounter.plan.closestDistance).toBe(250 * NEBULA_SIDE_OFFSET_FACTOR);
    expect(encounter.plan.spawnDistance).toBe(NEBULA_ENCOUNTER_DISTANCE);
    expect(next.remaining).toBeCloseTo(NEBULA_ENCOUNTER_DISTANCE, 6);
    expect(next.fade).toBe(0);
    expect(next.targetSpeed).toBe(DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed);
  });

  it.each(SHIP_SPEED_LEVELS.flatMap((cruiseSpeed) => [1 / 60, 1 / 120].map((dt) => ({ cruiseSpeed, dt }))))(
    'go through the full state sequence and return to cruise speed (cruise $cruiseSpeed, dt $dt)',
    ({ cruiseSpeed, dt }) => {
      const params: AutopilotParams = { ...NEBULAE_ONLY };
      setCruiseSpeed(params, cruiseSpeed);
      let worstFadeStep = 0;
      let worstHeldAngle = 0;
      let slowest = Number.POSITIVE_INFINITY;
      let minClearance = Number.POSITIVE_INFINITY;
      const rel = { x: 0, y: 0, z: 0 };
      let end: {
        time: number;
        outOfView: boolean;
        targetStep: number;
        driftStep: number;
        fade: number;
        entrySpeed: number;
      } | null = null;
      let backAtCruise = Number.NaN;
      const { transitions } = simulate(dt, {
        params,
        // On until the ship is back at the cruise speed after the encounter.
        until: (a) => !Number.isNaN(backAtCruise) || (end !== null && a.state !== 'CRUISE'),
        onFrame: ({ prev, ship, prevAutopilot, autopilot }) => {
          // Removed out of view at whatever fade it has, which no one sees; gradual otherwise.
          if (!endedOutOfView(prevAutopilot, autopilot, ship, params)) {
            worstFadeStep = Math.max(worstFadeStep, Math.abs(autopilot.fade - prevAutopilot.fade));
          }
          if (end !== null && Number.isNaN(backAtCruise) && ship.speed >= 0.99 * cruiseSpeed) backAtCruise = ship.time;
          if (holdsHeading(prevAutopilot, autopilot)) expect(ship.heading).toEqual(prev.heading);
          const encounter = autopilot.encounter;
          if (encounter !== null) {
            expect(encounter.kind).toBe('nebula');
            slowest = Math.min(slowest, ship.speed);
            minClearance = Math.min(minClearance, len(encounterOffset(encounter.plan, ship.position, rel)));
            if (autopilot.state === 'APPROACH' || autopilot.state === 'FLYBY') {
              worstHeldAngle = Math.max(worstHeldAngle, angleBetween(ship.heading, encounter.plan.direction));
            }
          }
          if (autopilot.state === 'CRUISE' && prevAutopilot.state === 'DEPARTURE') {
            end = {
              time: ship.time,
              outOfView: endedOutOfView(prevAutopilot, autopilot, ship, params),
              targetStep: Math.abs(autopilot.targetSpeed - prevAutopilot.targetSpeed),
              driftStep: Math.abs(autopilot.driftRate - prevAutopilot.driftRate),
              fade: prevAutopilot.fade,
              entrySpeed: autopilot.entrySpeed,
            };
          }
        },
      });
      expect(transitions.map((t) => t.to)).toEqual(CYCLE);
      expect(transitions.map((t) => t.encounterIndex)).toEqual([0, 0, 0, 0]);
      // Flown from the encounter speed: the cruise speed, or the arrival speed above it (the ship
      // drops out of warp first). Slows for the nebula (to the scaled minimum, floored). It ends once
      // every layer is behind the camera, long before the despawn distance and so still faded in part,
      // and the next cruise eases back into warp from the target speed it ended at.
      const encounterSpeed = Math.min(cruiseSpeed, ENCOUNTER_ARRIVAL_SPEED);
      const minSpeed = Math.min(encounterSpeed, Math.max(NEBULA_MIN_SPEED * (encounterSpeed / DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed), NEBULA_MIN_SPEED_FLOOR));
      expect(slowest).toBeLessThan(minSpeed * 1.25);
      expect(end).not.toBeNull();
      expect(end!.outOfView).toBe(true);
      expect(end!.fade).toBeGreaterThan(0);
      // No step in the target speed or the drift rate as the cruise takes over.
      expect(end!.targetStep).toBeLessThan(0.01);
      expect(end!.driftStep).toBeLessThan(0.01);
      expect(end!.entrySpeed).toBeLessThanOrEqual(encounterSpeed);
      // Back at the cruise speed (99%) within the warp entry and a few time constants.
      expect(backAtCruise - end!.time).toBeLessThanOrEqual(warpEntryDuration(params, end!.entrySpeed) + 3 * SHIP_SPEED_TAU_SECONDS);
      // Heading held, fades gradual, and clear of the core.
      expect(worstHeldAngle).toBeLessThan(HELD_ANGLE_TOLERANCE);
      expect(worstFadeStep).toBeLessThan(0.02);
      const radius = defaultNebula(0).radius;
      expect(minClearance).toBeCloseTo(radius * NEBULA_SIDE_OFFSET_FACTOR, 3);
    },
  );

  it('with the default shares, planets, nebulae, asteroids and comets follow the schedule, each through the full cycle', () => {
    const kinds: string[] = [];
    const { transitions } = simulate(1 / 60, {
      until: afterEncounters(6),
      maxSeconds: 4000,
      onFrame: ({ prevAutopilot, autopilot }) => {
        if (autopilot.state === 'APPROACH' && prevAutopilot.state === 'CRUISE') kinds.push(autopilot.encounter!.kind);
      },
    });
    expect(transitions.map((t) => t.to)).toEqual(Array.from({ length: 6 }, () => CYCLE).flat());
    expect(kinds).toEqual(encounterSchedule(DEFAULT_AUTOPILOT_PARAMS, 6).map((e) => e.kind));
    // The test default trip meets an asteroid fifth and a comet sixth.
    expect(new Set(kinds)).toEqual(new Set(['planet', 'nebula', 'asteroid', 'comet']));
  });

  it('setCruiseSpeed scales the nebula profile like the planet one and keeps its distances', () => {
    for (const speed of SHIP_SPEED_LEVELS) {
      const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS };
      setCruiseSpeed(params, speed);
      // Scaled for the speed the encounter is flown from: at or above the arrival speed, the
      // default level's profile itself.
      const encounterSpeed = Math.min(speed, ENCOUNTER_ARRIVAL_SPEED);
      const factor = encounterSpeed / DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed;
      expect({ ...params.nebula.profile, minSpeed: 0 }).toEqual({ ...NEBULA_ENCOUNTER_PROFILE, minSpeed: 0 });
      expect(params.nebula.profile.minSpeed).toBeCloseTo(
        Math.min(encounterSpeed, Math.max(NEBULA_MIN_SPEED * factor, NEBULA_MIN_SPEED_FLOOR)),
        12,
      );
      if (speed >= ENCOUNTER_ARRIVAL_SPEED) expect(params.nebula.profile).toEqual(NEBULA_ENCOUNTER_PROFILE);
      expect(params.nebula.encounterDistance).toBe(NEBULA_ENCOUNTER_DISTANCE);
    }
  });
});

describe('autopilot simulation', () => {
  it.each([1 / 60, 1 / 120])(
    'from load with defaults, goes APPROACH, FLYBY, DEPARTURE, CRUISE, and the planet is visible within 30-60 s (dt = %f)',
    (dt) => {
      let firstVisible = Number.NaN;
      const { transitions } = simulate(dt, {
        until: afterEncounters(1),
        onFrame: ({ ship, autopilot }) => {
          if (Number.isNaN(firstVisible) && autopilot.fade > 0) firstVisible = ship.time;
        },
      });
      expect(transitions.map((t) => t.to)).toEqual(CYCLE);
      expect(transitions.map((t) => t.from)).toEqual(['CRUISE', 'APPROACH', 'FLYBY', 'DEPARTURE']);
      expect(firstVisible).toBeGreaterThanOrEqual(30);
      expect(firstVisible).toBeLessThanOrEqual(60);
    },
  );

  it.each([5, 20, 40, 55])('without jitter, APPROACH begins after the configured interval (%f s), every cycle', (interval) => {
    const dt = 1 / 60;
    const { transitions } = simulate(dt, { params: { interval, intervalJitter: 0 }, until: afterEncounters(2) });
    const approaches = transitions.filter((t) => t.to === 'APPROACH');
    const cruises = transitions.filter((t) => t.to === 'CRUISE');
    expect(approaches).toHaveLength(2);
    // From load, then from the end of the first encounter. Within one frame (plus rounding); the
    // second cruise is shortened by the lateness carried over from the encounter, also under a frame.
    expect(approaches[0]!.time).toBeGreaterThanOrEqual(interval - 1e-9);
    expect(approaches[0]!.time).toBeLessThanOrEqual(interval + dt + 1e-9);
    const gap = approaches[1]!.time - cruises[0]!.time;
    expect(gap).toBeGreaterThanOrEqual(interval - dt - 1e-9);
    expect(gap).toBeLessThanOrEqual(interval + dt + 1e-9);
  });

  it.each([5, 40])('with jitter, each cruise lasts its own seeded interval (mean %f s)', (interval) => {
    const dt = 1 / 60;
    const params = { ...DEFAULT_AUTOPILOT_PARAMS, interval };
    const { transitions } = simulate(dt, { params, until: afterEncounters(3), maxSeconds: 4000 });
    const approaches = transitions.filter((t) => t.to === 'APPROACH');
    const cruiseStarts = [0, ...transitions.filter((t) => t.to === 'CRUISE').map((t) => t.time)];
    for (let i = 0; i < 3; i++) {
      // Within one frame late, or up to two frames early after an encounter (the carried lateness of
      // its start and of its end).
      const gap = approaches[i]!.time - cruiseStarts[i]!;
      const expected = cruiseInterval(params, i);
      expect(gap, `encounter ${i}`).toBeGreaterThanOrEqual(expected - 2 * dt - 1e-9);
      expect(gap, `encounter ${i}`).toBeLessThanOrEqual(expected + dt + 1e-9);
    }
  });

  it('over 1,000 simulated encounters: no more same-kind encounters in a row than the cap, and the mean interval holds', () => {
    // The engine's in-place step at the capped dt keeps this quick; each transition still fires
    // within one step of its threshold. The top speed also runs every cruise through its warp entry
    // and exit, which count toward the interval measured here.
    const dt = DT_CAP_SECONDS;
    const n = 1000;
    const travel = createTravel({ ...DEFAULT_AUTOPILOT_PARAMS }, DEFAULT_SHIP_PARAMS);
    setCruiseSpeed(travel.autopilotParams, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
    const kinds: string[] = [];
    const sides = new Set<string>();
    let cruiseStart = 0;
    let total = 0;
    let state = travel.autopilot.state;
    for (let i = 0; i < 5e7 && kinds.length < n; i++) {
      stepTravel(travel, dt);
      const a = travel.autopilot;
      if (a.state !== state) {
        if (a.state === 'APPROACH') {
          kinds.push(a.encounter!.kind);
          sides.add(a.encounter!.side);
          total += travel.ship.time - cruiseStart;
        } else if (a.state === 'CRUISE') {
          cruiseStart = travel.ship.time;
        }
        state = a.state;
      }
    }
    expect(kinds).toHaveLength(n);
    expect(kinds).toEqual(encounterSchedule(DEFAULT_AUTOPILOT_PARAMS, n).map((e) => e.kind));
    expect(longestRun(kinds)).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
    expect(longestRun(kinds.map((k) => runClass(k as EncounterKind)))).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
    expect(new Set(kinds)).toEqual(new Set(['planet', 'nebula', 'asteroid', 'comet']));
    expect(sides).toEqual(new Set(['left', 'right']));
    const [low, high] = ENCOUNTER_NEBULA_SHARE_BOUNDS;
    const share = kinds.filter((k) => k === 'nebula').length / n;
    expect(share).toBeGreaterThanOrEqual(low);
    expect(share).toBeLessThanOrEqual(high);
    const [aLow, aHigh] = ENCOUNTER_ASTEROID_SHARE_BOUNDS;
    const asteroidShare = kinds.filter((k) => k === 'asteroid').length / n;
    expect(asteroidShare).toBeGreaterThanOrEqual(aLow);
    expect(asteroidShare).toBeLessThanOrEqual(aHigh);
    const [cLow, cHigh] = ENCOUNTER_COMET_SHARE_BOUNDS;
    const cometShare = kinds.filter((k) => k === 'comet').length / n;
    expect(cometShare).toBeGreaterThanOrEqual(cLow);
    expect(cometShare).toBeLessThanOrEqual(cHigh);
    // Cruise lengths, from load and from each return to CRUISE to the next APPROACH. Stated tolerance
    // for the mean: 1% of the configured interval (the jitter's standard error over 1,000 encounters
    // is about 0.3%, and each cruise is measured to within two steps).
    const mean = total / n;
    expect(Math.abs(mean - ENCOUNTER_INTERVAL_SECONDS)).toBeLessThan(0.01 * ENCOUNTER_INTERVAL_SECONDS);
  }, 60_000);

  describe('safety across 200 randomly seeded encounters of each kind', () => {
    const largestPlanet = Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1]);
    const largestNebula = NEBULA_RANGES.radius[1];
    // Larger than any seeded field's bounding radius (about 53 at most over 2,000 seeds).
    const largestAsteroid = 64;
    // Larger than any seeded coma (COMET_RANGES.comaRadius).
    const largestComet = 60;
    const random = mulberry32(0x5afe_7e57);
    const draws = Array.from({ length: 200 }, () => ({
      baseSeed: Math.floor(random() * 2 ** 32),
      level: Math.floor(random() * SHIP_SPEED_LEVELS.length),
      dt: random() < 0.5 ? 1 / 60 : 1 / 120,
    }));
    // The largest radius of each kind at every speed level, on top of the seeded radii.
    const largest = SHIP_SPEED_LEVELS.map((_, level) => ({ baseSeed: level + 1, level, dt: 1 / 60, largest: true }));
    const cases = [...draws.map((d) => ({ ...d, largest: false })), ...largest];

    it.each(['planet', 'nebula', 'asteroid', 'comet'] as const)('%s: clearance ≥ radius × (1 + margin) and no frame jumps', (kind) => {
      let checked = 0;
      let largestSeen = 0;
      for (const { baseSeed, level, dt, largest: useLargest } of cases) {
        const params: AutopilotParams = {
          ...DEFAULT_AUTOPILOT_PARAMS,
          baseSeed,
          interval: 1,
          ...onlyKind(kind),
          planetFor: useLargest ? () => ({ radius: largestPlanet }) : planetParams,
          nebulaFor: useLargest ? () => ({ radius: largestNebula }) : nebulaParams,
          asteroidFor: useLargest ? () => ({ radius: largestAsteroid }) : asteroidParams,
          cometFor: useLargest ? () => ({ radius: largestComet }) : cometParams,
        };
        setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
        let minClearance = Number.POSITIVE_INFINITY;
        let worstJump = 0;
        let radius = 0;
        const rel0 = { x: 0, y: 0, z: 0 };
        const rel1 = { x: 0, y: 0, z: 0 };
        const label = `${kind}, base seed ${baseSeed}, level ${level}, dt ${dt}`;
        simulate(dt, {
          params,
          until: afterEncounters(1),
          onFrame: ({ prev, ship, prevAutopilot, autopilot }) => {
            const speed = Math.max(prev.speed, ship.speed);
            worstJump = Math.max(worstJump, len(sub(ship.position, prev.position)) / (speed * DT_CAP_SECONDS));
            const encounter = autopilot.encounter ?? prevAutopilot.encounter;
            if (encounter === null) return;
            if (encounter.kind !== kind) throw new Error(`${label}: a ${encounter.kind} encounter`);
            radius = encounter.plan.radius;
            encounterOffset(encounter.plan, prev.position, rel0);
            encounterOffset(encounter.plan, ship.position, rel1);
            const negate = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: -v.z });
            minClearance = Math.min(minClearance, originToSegment(negate(rel0), negate(rel1)));
          },
        });
        expect(radius, label).toBeGreaterThan(0);
        expect(minClearance, label).toBeGreaterThanOrEqual(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
        expect(worstJump, label).toBeLessThanOrEqual(1 + 1e-9);
        largestSeen = Math.max(largestSeen, radius);
        checked++;
      }
      expect(checked).toBe(cases.length);
      const largestOf = { planet: largestPlanet, nebula: largestNebula, asteroid: largestAsteroid, comet: largestComet };
      expect(largestSeen).toBe(largestOf[kind]);
    }, 120_000);
  });

  describe.each([1 / 60, 1 / 120])('over a full encounter (dt = %f)', (dt) => {
    // Small, default and large planets, at every cruise speed.
    const cases = [5, ENCOUNTER_PLANET_RADIUS, 600].flatMap((radius) =>
      SHIP_SPEED_LEVELS.map((cruiseSpeed) => ({ radius, cruiseSpeed })),
    );

    it.each(cases)(
      'keeps clear of the planet, never jumps and turns smoothly (radius $radius, cruise $cruiseSpeed)',
      ({ radius, cruiseSpeed }) => {
        let minClearance = Number.POSITIVE_INFINITY;
        let worstJump = 0;
        let worstTurnRate = 0;
        let worstHeldAngle = 0;
        let worstPathDeviation = 0;
        let worstFadeStep = 0;
        const rel0 = { x: 0, y: 0, z: 0 };
        const rel1 = { x: 0, y: 0, z: 0 };
        simulate(dt, {
          params: { cruiseSpeed, nebulaShare: 0, planetFor: () => ({ radius }) },
          until: afterEncounters(1),
          onFrame: ({ prev, ship, prevAutopilot, autopilot }) => {
            // No camera jump: per-frame displacement within speed × 0.1 s (and within the exact bound).
            const step = len(sub(ship.position, prev.position));
            const speed = Math.max(prev.speed, ship.speed);
            expect(step).toBeLessThanOrEqual(speed * DT_CAP_SECONDS);
            worstJump = Math.max(worstJump, step / (speed * dt));
            worstTurnRate = Math.max(worstTurnRate, angleBetween(prev.heading, ship.heading) / dt);
            // An object out of view is removed at whatever fade it has, which no one sees.
            if (!endedOutOfView(prevAutopilot, autopilot, ship)) {
              worstFadeStep = Math.max(worstFadeStep, Math.abs(autopilot.fade - prevAutopilot.fade));
            }

            const encounter = autopilot.encounter ?? prevAutopilot.encounter;
            if (encounter === null) return;
            // Minimum centre distance over the whole frame segment, not just its end points.
            encounterOffset(encounter.plan, prev.position, rel0);
            encounterOffset(encounter.plan, ship.position, rel1);
            const negate = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: -v.z });
            minClearance = Math.min(minClearance, originToSegment(negate(rel0), negate(rel1)));

            if (holdsHeading(prevAutopilot, autopilot)) expect(ship.heading).toEqual(prev.heading);
            if (autopilot.state === 'APPROACH' || autopilot.state === 'FLYBY') {
              // The heading is held at the planned direction, so the ship stays on the planned line.
              const { origin, direction } = encounter.plan;
              worstHeldAngle = Math.max(worstHeldAngle, angleBetween(ship.heading, direction));
              const d = sub(ship.position, origin);
              const along = dot(d, direction);
              const deviation = Math.hypot(
                d.x - direction.x * along,
                d.y - direction.y * along,
                d.z - direction.z * along,
              );
              worstPathDeviation = Math.max(worstPathDeviation, deviation);
            }
          },
        });
        expect(minClearance).toBeGreaterThanOrEqual(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
        // The closest approach is the planned one: radius × k.
        expect(minClearance).toBeCloseTo(radius * ENCOUNTER_SIDE_OFFSET_FACTOR, 3);
        expect(worstJump).toBeLessThanOrEqual(1 + 1e-9);
        expect(worstTurnRate).toBeLessThanOrEqual(SHIP_MAX_TURN_RATE_RAD_PER_S);
        expect(worstHeldAngle).toBeLessThan(HELD_ANGLE_TOLERANCE);
        expect(worstPathDeviation).toBeLessThan(1e-6);
        // Fades in and out gradually while in view: no frame changes the opacity by more than 2%.
        expect(worstFadeStep).toBeLessThan(0.02);
      },
    );
  });

  it.each([1 / 60, DT_CAP_SECONDS])(
    'a planet already out of view at its closest approach still spends one step in DEPARTURE, and the next encounter starts on schedule (dt = %f)',
    (dt) => {
      // A small planet passed far off: its sphere is out of the view cone at the closest approach.
      const planet = { radius: 13, passFactor: 6 };
      const params: Partial<AutopilotParams> = { ...onlyKind('planet'), planetFor: () => planet };
      const reference = simulate(1 / 600, { params, until: afterEncounters(2) });
      const run = simulate(dt, { params, until: afterEncounters(2) });
      for (const { transitions } of [reference, run]) {
        expect(transitions.slice(0, 8).map((t) => t.to)).toEqual([...CYCLE, ...CYCLE]);
      }
      const at = (r: typeof run, to: TravelState, n: number) => r.transitions.filter((t) => t.to === to)[n]!.time;
      // Exactly one step in DEPARTURE: the planet was out of view when it began.
      expect(at(run, 'CRUISE', 0) - at(run, 'DEPARTURE', 0)).toBeCloseTo(dt, 9);
      // The held step is carried with the lateness: the next encounter starts when it would have
      // without it, within the usual O(dt) per encounter (see `timelineTolerance`).
      expect(Math.abs(at(run, 'APPROACH', 1) - at(reference, 'APPROACH', 1))).toBeLessThan(timelineTolerance(1, dt, 1 / 600));
    },
  );

  it('the heading resumes from where it was held, with no jump at any state change', () => {
    const dt = 1 / 60;
    const headingAtChange: Array<{ before: Vec3; after: Vec3; to: TravelState }> = [];
    simulate(dt, {
      until: afterEncounters(2),
      onFrame: ({ prev, ship, prevAutopilot, autopilot }) => {
        if (autopilot.state !== prevAutopilot.state) {
          headingAtChange.push({ before: { ...prev.heading }, after: { ...ship.heading }, to: autopilot.state });
        }
      },
    });
    expect(headingAtChange.map((c) => c.to)).toEqual([...CYCLE, ...CYCLE]);
    for (const { before, after } of headingAtChange) {
      expect(angleBetween(before, after)).toBeLessThanOrEqual(SHIP_MAX_TURN_RATE_RAD_PER_S * dt);
    }
  });

  it.each([3, 15])('the timeline matches between dt = 1/60 and dt = 1/120 over %i encounters', (n) => {
    const maxSeconds = 600 * n;
    const at60 = simulate(1 / 60, { until: afterEncounters(n), maxSeconds }).transitions;
    const at120 = simulate(1 / 120, { until: afterEncounters(n), maxSeconds }).transitions;
    expect(at60.map((t) => t.to)).toEqual(at120.map((t) => t.to));
    expect(at60).toHaveLength(4 * n);
    for (let i = 0; i < at60.length; i++) {
      expect(Math.abs(at60[i]!.time - at120[i]!.time)).toBeLessThanOrEqual(timelineTolerance(n, 1 / 60, 1 / 120));
    }
  });

  it.each([1 / 30, 1 / 60])('the timeline at dt = %f matches dt = 1/144 over 6 encounters, kinds and states included', (dt) => {
    const n = 6;
    const run = (h: number) => simulate(h, { until: afterEncounters(n), maxSeconds: 600 * n }).transitions;
    const coarse = run(dt);
    const fine = run(1 / 144);
    expect(coarse.map((t) => [t.to, t.encounterIndex])).toEqual(fine.map((t) => [t.to, t.encounterIndex]));
    expect(coarse).toHaveLength(4 * n);
    for (let i = 0; i < coarse.length; i++) {
      expect(Math.abs(coarse[i]!.time - fine[i]!.time)).toBeLessThanOrEqual(timelineTolerance(n, dt, 1 / 144));
    }
  });

  it('completes 10 consecutive encounters with distinct indices, each ending out of view and returning to cruise speed', () => {
    const cruiseSpeed = DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed;
    const ends: Array<{ outOfView: boolean; targetStep: number; driftStep: number; fade: number }> = [];
    // Highest ship speed in each cruise that follows an encounter, before the next one starts.
    const cruiseMax: number[] = [];
    const indices: number[] = [];
    const seeds = new Set<number>();
    const { transitions, autopilot } = simulate(1 / 60, {
      until: afterEncounters(10),
      maxSeconds: 4000,
      onFrame: ({ ship, prevAutopilot, autopilot: a }) => {
        if (a.state === 'APPROACH' && prevAutopilot.state === 'CRUISE') {
          indices.push(a.encounter!.index);
          seeds.add(a.encounter!.seed);
        }
        if (a.state === 'CRUISE' && prevAutopilot.state === 'DEPARTURE') {
          ends.push({
            outOfView: endedOutOfView(prevAutopilot, a, ship),
            targetStep: Math.abs(a.targetSpeed - prevAutopilot.targetSpeed),
            driftStep: Math.abs(a.driftRate - prevAutopilot.driftRate),
            fade: a.fade,
          });
          cruiseMax.push(0);
        }
        if (a.state === 'CRUISE' && cruiseMax.length > 0) cruiseMax[cruiseMax.length - 1] = Math.max(cruiseMax.at(-1)!, ship.speed);
      },
    });
    expect(transitions.map((t) => t.to)).toEqual(Array.from({ length: 10 }, () => CYCLE).flat());
    // Every cycle's transitions belong to one encounter.
    for (let i = 0; i < 10; i++) {
      expect(transitions.slice(i * 4, i * 4 + 4).map((t) => t.encounterIndex)).toEqual([i, i, i, i]);
    }
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seeds.size).toBe(10);
    expect(autopilot.encounterCount).toBe(10);
    expect(ends).toHaveLength(10);
    for (const end of ends) {
      // Ended as soon as the object was out of view (planets and nebulae alike), with no step in the
      // target speed or the drift rate.
      expect(end.outOfView).toBe(true);
      expect(end.fade).toBe(0);
      expect(end.targetStep).toBeLessThan(0.01);
      expect(end.driftStep).toBeLessThan(0.01);
    }
    // Every cruise but the last (cut short by the end of the run) gets back to the cruise speed.
    for (const max of cruiseMax.slice(0, -1)) expect(Math.abs(max - cruiseSpeed) / cruiseSpeed).toBeLessThan(0.01);
  });
});

describe('dropping out of warp', () => {
  const TOP_SPEED = SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!;
  /** The default params at cruise speed `cruiseSpeed`, through `setCruiseSpeed` as the engine sets it. */
  const atSpeed = (cruiseSpeed: number, overrides: Partial<AutopilotParams> = {}): AutopilotParams => {
    const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, ...overrides };
    setCruiseSpeed(params, cruiseSpeed);
    return params;
  };

  it('encounters are flown from min(cruise speed, arrival speed)', () => {
    for (const cruiseSpeed of SHIP_SPEED_LEVELS) {
      expect(encounterCruiseSpeed(atSpeed(cruiseSpeed))).toBe(Math.min(cruiseSpeed, ENCOUNTER_ARRIVAL_SPEED));
    }
    // An infinite arrival speed flies every encounter from the cruise speed.
    expect(encounterCruiseSpeed({ cruiseSpeed: TOP_SPEED, arrivalSpeed: Number.POSITIVE_INFINITY })).toBe(TOP_SPEED);
  });

  it('cruiseTargetSpeed is the cruise speed up to the arrival speed; above it, it eases back into warp after an encounter and out of it before the next', () => {
    // The first cruise, from load, has no encounter to return from: it starts at the cruise speed.
    for (const cruiseSpeed of SHIP_SPEED_LEVELS) {
      const params = atSpeed(cruiseSpeed);
      expect(cruiseTargetSpeed(0, ENCOUNTER_INTERVAL_SECONDS, params, false)).toBe(cruiseSpeed);
      expect(createAutopilotState(params).targetSpeed).toBe(cruiseSpeed);
      expect(cruiseTargetSpeed(ENCOUNTER_INTERVAL_SECONDS, ENCOUNTER_INTERVAL_SECONDS, params, false)).toBe(
        Math.min(cruiseSpeed, ENCOUNTER_ARRIVAL_SPEED),
      );
    }
    const interval = ENCOUNTER_INTERVAL_SECONDS;
    const h = 0.01;
    const exitStart = interval - ENCOUNTER_WARP_EXIT_LEAD_SECONDS - ENCOUNTER_WARP_EXIT_SECONDS;
    for (const cruiseSpeed of SHIP_SPEED_LEVELS) {
      const params = atSpeed(cruiseSpeed);
      const arrival = Math.min(cruiseSpeed, ENCOUNTER_ARRIVAL_SPEED);
      // A smoothstep's slope is at most 1.5 × range / width.
      const maxStep = (1.5 * (cruiseSpeed - arrival) * h) / Math.min(ENCOUNTER_WARP_ENTRY_SECONDS, ENCOUNTER_WARP_EXIT_SECONDS);
      let prev = cruiseTargetSpeed(0, interval, params, true);
      expect(prev).toBe(arrival);
      for (let i = 1; i * h <= interval + 1; i++) {
        const t = i * h;
        const v = cruiseTargetSpeed(t, interval, params, true);
        if (cruiseSpeed <= ENCOUNTER_ARRIVAL_SPEED) {
          // The default level and below: unchanged, the cruise speed throughout.
          expect(v).toBe(cruiseSpeed);
        } else {
          expect(Math.abs(v - prev)).toBeLessThanOrEqual(maxStep + 1e-9);
          expect(v).toBeGreaterThanOrEqual(arrival);
          expect(v).toBeLessThanOrEqual(cruiseSpeed);
          // Back into warp, at warp, out of warp, then held at the arrival speed for the lead.
          if (t <= ENCOUNTER_WARP_ENTRY_SECONDS) expect(v).toBeGreaterThanOrEqual(prev);
          else if (t <= exitStart) expect(v).toBe(cruiseSpeed);
          else expect(v).toBeLessThanOrEqual(prev);
          if (t >= interval - ENCOUNTER_WARP_EXIT_LEAD_SECONDS + h / 2) expect(v).toBe(arrival);
        }
        prev = v;
      }
    }
    // A cruise too short for the entry and the exit never reaches warp, and is back at the arrival
    // speed by the lead before the encounter; one no longer than the lead stays at the arrival speed.
    const top = atSpeed(TOP_SPEED);
    for (const short of [5, ENCOUNTER_WARP_ENTRY_SECONDS + ENCOUNTER_WARP_EXIT_SECONDS]) {
      let prev = cruiseTargetSpeed(0, short, top, true);
      for (let i = 0; i * h <= short; i++) {
        const t = i * h;
        const v = cruiseTargetSpeed(t, short, top, true);
        expect(v).toBeLessThan(TOP_SPEED);
        expect(Math.abs(v - prev)).toBeLessThan(0.2);
        if (t >= short - ENCOUNTER_WARP_EXIT_LEAD_SECONDS + h / 2) expect(v).toBe(ENCOUNTER_ARRIVAL_SPEED);
        prev = v;
      }
    }
    for (let t = 0; t <= 5; t += 0.05) {
      expect(cruiseTargetSpeed(t, ENCOUNTER_WARP_EXIT_LEAD_SECONDS, top, true)).toBe(ENCOUNTER_ARRIVAL_SPEED);
    }
  });

  describe.each(SHIP_SPEED_LEVELS.map((cruiseSpeed) => ({ cruiseSpeed })))('at cruise speed $cruiseSpeed', ({ cruiseSpeed }) => {
    const encounterSpeed = Math.min(cruiseSpeed, ENCOUNTER_ARRIVAL_SPEED);
    const cases = (['planet', 'nebula', 'asteroid', 'comet'] as const).flatMap((kind) => [1 / 60, 1 / 120].map((dt) => ({ kind, dt })));

    it.each(cases)(
      'the ship is out of warp when the $kind reaches opacity 0.1, and flies the profile for its encounter speed from the spawn (dt $dt)',
      ({ kind, dt }) => {
        const params = atSpeed(cruiseSpeed, onlyKind(kind));
        // At or above the arrival speed, the profile is the default level's itself.
        if (cruiseSpeed >= ENCOUNTER_ARRIVAL_SPEED) {
          expect(params.profile).toEqual(DEFAULT_AUTOPILOT_PARAMS.profile);
          expect(params.nebula.profile).toEqual(DEFAULT_AUTOPILOT_PARAMS.nebula.profile);
          expect(params.asteroid.profile).toEqual(DEFAULT_AUTOPILOT_PARAMS.asteroid.profile);
          expect(params.comet.profile).toEqual(DEFAULT_AUTOPILOT_PARAMS.comet.profile);
        }
        const profile = encounterProfile(params, kind);
        // Over three encounters, so the cruises after an encounter (the return to warp, then the drop
        // out of it) are checked as well as the first one from load.
        const encounters = 3;
        const speedsAtSpawn: number[] = [];
        const speedsAtVisible: number[] = [];
        let visible = false;
        let encounterFrames = 0;
        simulate(dt, {
          params,
          until: afterEncounters(encounters),
          maxSeconds: 4000,
          onFrame: ({ ship, prevAutopilot, autopilot }) => {
            if (autopilot.encounter === null) return;
            if (prevAutopilot.state === 'CRUISE') {
              speedsAtSpawn.push(ship.speed);
              visible = false;
            }
            if (!visible && autopilot.fade >= 0.1) {
              speedsAtVisible.push(ship.speed);
              visible = true;
            }
            // Exactly the encounter speed's profile, from the spawn to the end.
            expect(autopilot.targetSpeed).toBe(encounterTargetSpeed(autopilot.remaining, encounterSpeed, profile));
            encounterFrames++;
          },
        });
        expect(encounterFrames).toBeGreaterThan(1000 * encounters);
        expect(speedsAtSpawn).toHaveLength(encounters);
        expect(speedsAtVisible).toHaveLength(encounters);
        // From the top speed the lag is about 3 units per second at the spawn and under 0.5 by the
        // time the object is noticeably visible, in every encounter; at or below the arrival speed
        // there is none.
        expect(Math.max(...speedsAtSpawn)).toBeLessThanOrEqual(encounterSpeed + 3.5);
        expect(Math.max(...speedsAtVisible)).toBeLessThanOrEqual(encounterSpeed + 0.5);
        // At or below the arrival speed, the ship has long reached its cruise speed (from rest at
        // load, or back from the previous encounter's departure, which ends near the minimum speed).
        if (cruiseSpeed <= ENCOUNTER_ARRIVAL_SPEED) {
          for (const speed of speedsAtVisible) expect(speed).toBeCloseTo(cruiseSpeed, 4);
        }
      },
    );

    it.each(cases)(
      'the drop out of warp and the return to it are smooth around $kind encounters: no step in the target speed or the speed at any frame (dt $dt)',
      ({ kind, dt }) => {
        // Over two encounters: load, a full cruise, the drop out of warp, an encounter, the return
        // to warp, and again. Streaks are the ship velocity × the streak time, so a smooth speed
        // also means smooth streak lengths.
        let worstTargetRate = 0;
        let worstSpeedRate = 0;
        let backInWarp = Number.NaN;
        let endedAt = Number.NaN;
        let entrySpeed = Number.NaN;
        const params = atSpeed(cruiseSpeed, onlyKind(kind));
        simulate(dt, {
          params,
          until: afterEncounters(2),
          maxSeconds: 4000,
          onFrame: ({ prev, ship, prevAutopilot, autopilot }) => {
            worstTargetRate = Math.max(worstTargetRate, Math.abs(autopilot.targetSpeed - prevAutopilot.targetSpeed) / dt);
            // The speed from the first spawn on: before it the ship also accelerates from rest at load.
            if (autopilot.encounterCount > 0) worstSpeedRate = Math.max(worstSpeedRate, Math.abs(ship.speed - prev.speed) / dt);
            if (prevAutopilot.state === 'DEPARTURE' && autopilot.state === 'CRUISE' && Number.isNaN(endedAt)) {
              endedAt = ship.time;
              entrySpeed = autopilot.entrySpeed;
            }
            if (!Number.isNaN(endedAt) && Number.isNaN(backInWarp) && ship.speed >= 0.95 * cruiseSpeed) backInWarp = ship.time;
          },
        });
        // Bounded rates of change, in units per second per second. The target: the eases are
        // smoothsteps over seconds, whose slope is at most 1.5 × 90 / 8 ≈ 17 from the top speed, and
        // the encounter profile is the default level's (about 8). The return to warp from where the
        // encounter ended out of view (near its minimum speed) is a smoothstep over at least the
        // entry time, stretched until no steeper than ENCOUNTER_WARP_ENTRY_MAX_RATE: about 10 at the
        // default level (6 to 60 over 8 s), 17 at the top level. The ship lags its target, so its
        // speed changes more gently: at most about 14 in the drop from the top speed, and about 15.5
        // in the return to it from the minimum speed. Before the drop out of warp, the top-speed
        // encounter slowdown reached about 54 and 32.
        const minSpeed = encounterProfile(params, kind).minSpeed;
        const maxTargetRate = Math.max(
          8,
          (1.5 * (cruiseSpeed - encounterSpeed)) / Math.min(ENCOUNTER_WARP_ENTRY_SECONDS, ENCOUNTER_WARP_EXIT_SECONDS),
          (1.5 * (cruiseSpeed - minSpeed)) / warpEntryDuration(params, minSpeed),
        );
        expect(maxTargetRate).toBeLessThanOrEqual(ENCOUNTER_WARP_ENTRY_MAX_RATE);
        expect(worstTargetRate).toBeGreaterThan(0);
        expect(worstTargetRate).toBeLessThanOrEqual(maxTargetRate * 1.01);
        expect(worstSpeedRate).toBeLessThan(16);
        // Back in warp (95% of the cruise speed) within the entry time plus 1.5 time constants. A
        // planet encounter ends near the minimum speed; a nebula's ends once the ship is past every
        // layer, when it is back at the encounter speed. An asteroid's, like a planet's, near its
        // minimum speed.
        expect(entrySpeed).toBeLessThanOrEqual(encounterSpeed);
        if (kind !== 'nebula') expect(entrySpeed).toBeLessThan(encounterSpeed / 2);
        expect(backInWarp - endedAt).toBeLessThanOrEqual(warpEntryDuration(params, entrySpeed) + 1.5 * SHIP_SPEED_TAU_SECONDS);
      },
    );
  });

  it.each(SHIP_SPEED_LEVELS.filter((speed) => speed <= ENCOUNTER_ARRIVAL_SPEED))(
    'at cruise speed %i (at most the arrival speed) the travel is exactly what it was without an arrival speed',
    (cruiseSpeed) => {
      // An infinite arrival speed flies every encounter from the cruise speed, with no warp entry
      // or exit: the behaviour before the drop out of warp. Planets and nebulae, the default mix.
      const run = (arrivalSpeed: number) => {
        const frames: Array<{ time: number; speed: number; targetSpeed: number; fade: number; state: TravelState }> = [];
        const result = simulate(1 / 60, {
          params: atSpeed(cruiseSpeed, { arrivalSpeed }),
          until: afterEncounters(3),
          maxSeconds: 4000,
          onFrame: ({ ship, autopilot }) => {
            frames.push({ time: ship.time, speed: ship.speed, targetSpeed: autopilot.targetSpeed, fade: autopilot.fade, state: autopilot.state });
          },
        });
        return { transitions: result.transitions, ship: result.ship, frames };
      };
      const now = run(ENCOUNTER_ARRIVAL_SPEED);
      const before = run(Number.POSITIVE_INFINITY);
      expect(new Set(now.transitions.map((t) => t.to))).toEqual(new Set(CYCLE));
      expect(now.transitions).toEqual(before.transitions);
      expect(now.frames).toEqual(before.frames);
      expect(now.ship).toEqual(before.ship);
    },
  );

  it('at the top speed level the warp entry and exit count toward the interval: APPROACH begins after the configured interval, every cycle', () => {
    const dt = 1 / 60;
    const interval = ENCOUNTER_INTERVAL_SECONDS;
    const params = atSpeed(TOP_SPEED, { interval, intervalJitter: 0 });
    let topSpeedReached = false;
    const { transitions } = simulate(dt, {
      params,
      until: afterEncounters(2),
      onFrame: ({ ship }) => {
        topSpeedReached ||= ship.speed > 0.99 * TOP_SPEED;
      },
    });
    expect(topSpeedReached).toBe(true);
    const approaches = transitions.filter((t) => t.to === 'APPROACH');
    const cruises = transitions.filter((t) => t.to === 'CRUISE');
    expect(approaches).toHaveLength(2);
    expect(approaches[0]!.time).toBeGreaterThanOrEqual(interval - 1e-9);
    expect(approaches[0]!.time).toBeLessThanOrEqual(interval + dt + 1e-9);
    const gap = approaches[1]!.time - cruises[0]!.time;
    expect(gap).toBeGreaterThanOrEqual(interval - dt - 1e-9);
    expect(gap).toBeLessThanOrEqual(interval + dt + 1e-9);
  });

  // Stated tolerance: as for the default level (see `timelineTolerance`). The warp entry and exit are
  // functions of the cruise time, so they add no lateness of their own.
  it.each([3, 15])('at the top speed level the timeline, warp entry and exit included, matches between dt = 1/60 and dt = 1/120 over %i encounters', (n) => {
    const params = atSpeed(TOP_SPEED);
    const maxSeconds = 600 * n;
    const at60 = simulate(1 / 60, { params, until: afterEncounters(n), maxSeconds }).transitions;
    const at120 = simulate(1 / 120, { params, until: afterEncounters(n), maxSeconds }).transitions;
    expect(at60.map((t) => t.to)).toEqual(at120.map((t) => t.to));
    expect(at60).toHaveLength(4 * n);
    for (let i = 0; i < at60.length; i++) {
      expect(Math.abs(at60[i]!.time - at120[i]!.time)).toBeLessThanOrEqual(timelineTolerance(n, 1 / 60, 1 / 120));
    }
  });
});

/*
 * Speed driven by visibility (docs/PLAN.md section 9, Phase 4). "In view" below is the exact view
 * at the widest supported aspect ratio, 21:9: the camera looks along the ship heading with world +Y
 * up (Engine's `camera.lookAt`), with the vertical field of view CAMERA_FOV_DEG. The autopilot's own
 * test is the cone around that view, which is never smaller.
 */

const TAN_HALF_V = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
const TAN_HALF_H = TAN_HALF_V * VIEW_WIDEST_ASPECT;
const unit = (v: Vec3): Vec3 => {
  const l = len(v);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
/** Outward unit normals of the 21:9 view's four side planes, in camera coordinates (x right, y up, z forward). */
const VIEW_PLANES: Vec3[] = [
  { x: 1, y: 0, z: -TAN_HALF_H },
  { x: -1, y: 0, z: -TAN_HALF_H },
  { x: 0, y: 1, z: -TAN_HALF_V },
  { x: 0, y: -1, z: -TAN_HALF_V },
].map(unit);
/** Unit directions of the view's four corner edges, in camera coordinates. */
const VIEW_EDGES: Vec3[] = [
  { x: TAN_HALF_H, y: TAN_HALF_V, z: 1 },
  { x: -TAN_HALF_H, y: TAN_HALF_V, z: 1 },
  { x: TAN_HALF_H, y: -TAN_HALF_V, z: 1 },
  { x: -TAN_HALF_H, y: -TAN_HALF_V, z: 1 },
].map(unit);

/** Writes `p` (relative to the camera, world axes) in camera coordinates for a camera looking along `heading`. */
function toCamera(p: Vec3, heading: Vec3): Vec3 {
  const f = unit(heading);
  const r = unit(cross(f, { x: 0, y: 1, z: 0 }));
  const u = cross(r, f);
  return { x: dot(p, r), y: dot(p, u), z: dot(p, f) };
}

/** Distance from `q` (camera coordinates) to the 21:9 view: the infinite pyramid the side planes bound. */
function distanceToView(q: Vec3): number {
  const d = VIEW_PLANES.map((n) => dot(n, q));
  if (d.every((v) => v <= 0)) return 0;
  // The nearest point of a convex cone lies inside one of its faces, on an edge, or at the apex.
  let best = len(q);
  for (const e of VIEW_EDGES) {
    const t = dot(q, e);
    if (t > 0) best = Math.min(best, len(sub(q, { x: e.x * t, y: e.y * t, z: e.z * t })));
  }
  VIEW_PLANES.forEach((n, i) => {
    if (d[i]! <= 0) return;
    const onPlane = sub(q, { x: n.x * d[i]!, y: n.y * d[i]!, z: n.z * d[i]! });
    if (VIEW_PLANES.every((m, j) => j === i || dot(m, onPlane) <= 1e-9)) best = Math.min(best, d[i]!);
  });
  return best;
}

/** Whether a sphere at `centre` (relative to the camera, world axes) shows any part in the 21:9 view. */
function sphereInView(centre: Vec3, radius: number, heading: Vec3): boolean {
  return distanceToView(toCamera(centre, heading)) < radius;
}

/** Whether a convex polygon (relative to the camera, world axes) shows any part in the 21:9 view, beyond the near plane. */
function polygonInView(corners: readonly Vec3[], heading: Vec3): boolean {
  let poly = corners.map((c) => toCamera(c, heading));
  // Sutherland–Hodgman against each side plane (inside: n·p ≤ 0) and the near plane (z ≥ 0.1).
  const clip = (inside: (p: Vec3) => number) => {
    const out: Vec3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const da = inside(a);
      const db = inside(b);
      if (da <= 0) out.push(a);
      if (da <= 0 !== db <= 0) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    poly = out;
  };
  for (const n of VIEW_PLANES) clip((p) => dot(n, p));
  clip((p) => 0.1 - p.z);
  return poly.length > 0;
}

/**
 * Each layer's four corners, relative to the nebula centre in world axes, exactly as the renderer
 * places them: a `Nebula` built for the plan, its layer meshes' world matrices applied to the unit
 * plane's corners.
 */
function nebulaLayerCorners(params: Readonly<NebulaParams>, plan: Readonly<Encounter>): Vec3[][] {
  const nebula = new Nebula(params, plan);
  nebula.object.updateMatrixWorld(true);
  const layers = nebula.layers.map(({ mesh }) =>
    [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ].map(([u, v]) => {
      const p = new Vector3(u, v, 0).applyMatrix4(mesh.matrixWorld);
      return { x: p.x, y: p.y, z: p.z };
    }),
  );
  nebula.dispose();
  return layers;
}

/**
 * The outer edge of `planet`'s ring, relative to the planet centre in world axes, exactly as the
 * renderer places it: a `Planet` built for the plan, its ring mesh's world matrix applied to the ring
 * geometry's outer vertices. A convex polygon holding the whole ring.
 */
function ringOutline(planet: Readonly<PlanetParams>, plan: Readonly<Encounter>): Vec3[] {
  const built = new Planet(planet, undefined, plan);
  const ring = built.ring!;
  built.object.updateMatrixWorld(true);
  const position = ring.geometry.getAttribute('position');
  const outer: Vec3[] = [];
  for (let i = 0; i < position.count; i++) {
    const p = new Vector3().fromBufferAttribute(position, i);
    if (Math.abs(p.length() - planet.ring!.outer) > 1e-6) continue;
    p.applyMatrix4(ring.matrixWorld);
    outer.push({ x: p.x, y: p.y, z: p.z });
  }
  built.dispose();
  // The ring geometry repeats the first outer vertex at the end of the circle.
  return outer.slice(0, -1);
}

/**
 * Each rock's bounding sphere, its centre relative to the field centre in world axes, exactly as the
 * renderer places it: an `Asteroid` built for the plan, its rock meshes' world positions.
 */
function rockSpheres(params: Readonly<AsteroidParams>, plan: Readonly<Encounter>): { centre: Vec3; radius: number }[] {
  const built = new Asteroid(params, undefined, plan);
  built.object.updateMatrixWorld(true);
  const rocks = built.rocks.map((mesh, i) => {
    const p = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
    return { centre: { x: p.x, y: p.y, z: p.z }, radius: params.rocks[i]!.radius };
  });
  built.dispose();
  return rocks;
}

/**
 * Spheres holding a comet's glow mesh as the renderer places it (its coma, and each stretch of tube
 * between two neighbouring rings of either tail), centred relative to the nucleus in world axes: much
 * tighter than the out-of-view bounds the autopilot uses (`CometSpec.bounds`, one per five stretches).
 */
function cometSpheres(params: Readonly<CometParams>, plan: Readonly<Encounter>): { centre: Vec3; radius: number }[] {
  const geometry = cometGlowGeometry(params, plan);
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const spheres: { centre: Vec3; radius: number }[] = [{ centre: { x: 0, y: 0, z: 0 }, radius: params.radius * (1 + 1e-6) }];
  const sides = 16;
  let first = 0;
  while (first < position.count && uv.getY(first) === 0) first++;
  for (let start = first; start + 2 * sides <= position.count; start += sides) {
    // Skip the pair that would join the last ring of one tail to the first of the next.
    if (uv.getY(start) !== uv.getY(start + sides)) continue;
    const vertices: Vec3[] = [];
    for (let v = start; v < start + 2 * sides; v++) vertices.push({ x: position.getX(v), y: position.getY(v), z: position.getZ(v) });
    const centre = vertices.reduce((c, v) => ({ x: c.x + v.x / vertices.length, y: c.y + v.y / vertices.length, z: c.z + v.z / vertices.length }), { x: 0, y: 0, z: 0 });
    spheres.push({ centre, radius: Math.max(...vertices.map((v) => len(sub(v, centre)))) * (1 + 1e-6) });
  }
  geometry.dispose();
  return spheres;
}

/** Median radius of the seeded planets (`planetParams` over 2,001 seeds). */
const MEDIAN_PLANET_RADIUS = (() => {
  const radii = Array.from({ length: 2001 }, (_, i) => planetParams(hash(0x3ed1a7, i)).radius).sort((a, b) => a - b);
  return radii[1000]!;
})();

/**
 * Runs `params` from load twice in lockstep at step `dt`, until the first encounter of the second run
 * has ended: as now, and with the out-of-view exit off (`viewHalfAngle` π), which is the departure
 * before Phase 4, flown to the despawn distance. That reference is checked to follow the
 * distance-based target speed throughout its encounter, so it is main's speed profile.
 *
 * `inView` tells whether the encounter's object shows in the 21:9 view for a ship state. While it
 * does (in the run as now, including after its encounter has ended), the ship must be no faster than
 * the reference at the same step.
 */
function againstMain(
  params: Readonly<AutopilotParams>,
  dt: number,
  inView: (encounter: Readonly<ActiveEncounter>, ship: Readonly<ShipState>) => boolean,
) {
  const now: Travel = createTravel({ ...params }, DEFAULT_SHIP_PARAMS);
  const main: Travel = createTravel({ ...params, viewHalfAngle: Math.PI }, DEFAULT_SHIP_PARAMS);
  let encounter: ActiveEncounter | null = null;
  let endedAt = Number.NaN;
  let closestAt = Number.NaN;
  let worstExcess = Number.NEGATIVE_INFINITY;
  let inViewFrames = 0;
  let inViewAfterEnd = 0;
  let worstProfileError = 0;
  let mainEnd = Number.NaN;
  let firstBack: { since: number; turn: number; remaining: number } | null = null;
  for (let i = 0; i < 1e6; i++) {
    stepTravel(now, dt);
    stepTravel(main, dt);
    const m = main.autopilot;
    if (m.encounter !== null) {
      const profile = encounterProfile(main.autopilotParams, m.encounter.kind);
      const expected = encounterTargetSpeed(m.remaining, encounterCruiseSpeed(main.autopilotParams), profile);
      worstProfileError = Math.max(worstProfileError, Math.abs(m.targetSpeed - expected));
    }
    const a = now.autopilot;
    // Only the first encounter: the run as now may start its next one before the reference ends.
    if (encounter === null && a.encounter !== null) encounter = a.encounter;
    if (encounter !== null && Number.isNaN(closestAt) && encounterRemaining(encounter.plan, now.ship.position) <= 0) {
      closestAt = now.ship.time;
    }
    if (encounter !== null && a.encounter !== encounter && Number.isNaN(endedAt)) endedAt = now.ship.time;
    if (encounter !== null && inView(encounter, now.ship)) {
      inViewFrames++;
      if (!Number.isNaN(endedAt)) {
        inViewAfterEnd++;
        if (inViewAfterEnd === 1) firstBack = { since: now.ship.time - endedAt, turn: angleBetween(now.ship.heading, encounter.plan.direction), remaining: encounterRemaining(encounter.plan, now.ship.position) };
      }
      worstExcess = Math.max(worstExcess, now.ship.speed - main.ship.speed);
    }
    if (m.encounterCount > 0 && m.encounter === null) {
      mainEnd = encounterRemaining(encounter!.plan, main.ship.position);
      break;
    }
  }
  return { encounter: encounter!, closestAt, endedAt, worstExcess, inViewFrames, inViewAfterEnd, worstProfileError, mainEnd, firstBack };
}

/** The default params at speed level `level` (through `setCruiseSpeed`, as the engine sets it), with `overrides`. */
function atLevel(level: number, overrides: Partial<AutopilotParams> = {}): AutopilotParams {
  const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, ...overrides };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  return params;
}

/**
 * The first encounter of a trip from load at speed level `level` and dt = 1/60, of a median planet
 * (k = 2), the median nebula or the comet `comet`, with the view cone `viewHalfAngle` (π: main's departure). Seconds
 * from the closest approach until the object is out of view (`encounterViewMargin` > 0 with the
 * default cone, measured the same way in both runs), until the encounter ends, and until the next
 * cruise has the ship at 99% of the arrival speed (min(cruise speed, arrival speed)) and at 99% of
 * the cruise speed; and the ship's largest acceleration from the closest approach on (units per
 * second per second).
 */
function departureTimes(kind: 'planet' | 'nebula' | 'comet', level: number, viewHalfAngle: number, comet?: Readonly<CometParams>) {
  const params = atLevel(level, {
    ...onlyKind(kind),
    planetFor: () => ({ radius: MEDIAN_PLANET_RADIUS }),
    ...(comet === undefined ? {} : { cometFor: () => comet }),
    viewHalfAngle,
  });
  const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
  const dt = 1 / 60;
  const cruise = params.cruiseSpeed;
  const arrival = encounterCruiseSpeed(params);
  let encounter: ActiveEncounter | null = null;
  let closestAt = Number.NaN;
  let outOfView = Number.NaN;
  let ended = Number.NaN;
  let atArrival = Number.NaN;
  let atCruise = Number.NaN;
  let worstAccel = 0;
  for (let i = 0; i < 1e6 && Number.isNaN(atCruise); i++) {
    const speed = travel.ship.speed;
    stepTravel(travel, dt);
    const { ship, autopilot } = travel;
    if (encounter === null) encounter = autopilot.encounter;
    if (encounter === null) continue;
    if (Number.isNaN(closestAt)) {
      const remaining = encounterRemaining(encounter.plan, ship.position);
      if (remaining <= 0) closestAt = ship.time + remaining / ship.speed;
      else continue;
    }
    worstAccel = Math.max(worstAccel, Math.abs(ship.speed - speed) / dt);
    if (Number.isNaN(outOfView) && encounterViewMargin(encounter, ship, DEFAULT_AUTOPILOT_PARAMS.viewHalfAngle) > 0) outOfView = ship.time;
    if (Number.isNaN(ended) && autopilot.encounter === null) ended = ship.time;
    if (Number.isNaN(ended)) continue;
    if (Number.isNaN(atArrival) && ship.speed >= 0.99 * arrival) atArrival = ship.time;
    if (ship.speed >= 0.99 * cruise) atCruise = ship.time;
  }
  return {
    outOfView: outOfView - closestAt,
    ended: ended - closestAt,
    atArrival: atArrival - closestAt,
    atCruise: atCruise - closestAt,
    worstAccel,
  };
}

describe('speed driven by visibility', () => {
  const HALF_ANGLE = DEFAULT_AUTOPILOT_PARAMS.viewHalfAngle;

  it('the view cone holds the whole view at every aspect ratio (wider than 21:9 with the engine field of view), and reaches the 21:9 corners', () => {
    expect(HALF_ANGLE).toBe(viewConeHalfAngle(CAMERA_FOV_DEG, VIEW_WIDEST_ASPECT));
    expect((HALF_ANGLE * 180) / Math.PI).toBeCloseTo(55.7, 1);
    const forward = { x: 0, y: 0, z: 1 };
    for (const aspect of [32 / 9, 3, 2.4, VIEW_WIDEST_ASPECT, 16 / 9, 4 / 3, 1, 9 / 16, 9 / 21]) {
      const tanHalfV = Math.tan((cameraFovDeg(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT) * Math.PI) / 360);
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [0, 1]] as const) {
        const edge = { x: sx * tanHalfV * aspect, y: sy * tanHalfV, z: 1 };
        expect(angleBetween(edge, forward)).toBeLessThanOrEqual(HALF_ANGLE + 1e-12);
      }
    }
    expect(angleBetween(VIEW_EDGES[0]!, forward)).toBeCloseTo(HALF_ANGLE, 12);
  });

  it('sphereViewMargin is positive exactly once the whole sphere is outside the cone', () => {
    const forward = { x: 0, y: 0, z: -1 };
    expect(sphereViewMargin({ x: 0, y: 0, z: -100 }, forward, 10, HALF_ANGLE)).toBeLessThan(0);
    expect(sphereViewMargin({ x: 0, y: 0, z: 100 }, forward, 10, HALF_ANGLE)).toBeGreaterThan(0);
    expect(sphereViewMargin({ x: 0, y: 0, z: -5 }, forward, 10, HALF_ANGLE)).toBe(-Math.PI);
    // Its edge on the cone: the centre at the half-angle plus the angular radius from the axis.
    for (const [d, r] of [[100, 10], [3000, 60], [130, 120]] as const) {
      for (const offset of [-1e-6, 1e-6]) {
        const a = HALF_ANGLE + Math.asin(r / d) + offset;
        const centre = { x: d * Math.sin(a), y: 0, z: -d * Math.cos(a) };
        expect(Math.sign(sphereViewMargin(centre, forward, r, HALF_ANGLE))).toBe(Math.sign(offset));
      }
    }
  });

  it('a planet out of the cone is out of the 21:9 view, whatever the heading', () => {
    const random = mulberry32(0x0f_f5ce);
    let outside = 0;
    for (let i = 0; i < 20_000; i++) {
      const heading = unit({ x: random() * 2 - 1, y: (random() * 2 - 1) * 0.5, z: random() * 2 - 1 });
      const centre = { x: (random() * 2 - 1) * 400, y: (random() * 2 - 1) * 400, z: (random() * 2 - 1) * 400 };
      const radius = 5 + random() * 80;
      if (sphereViewMargin(centre, heading, radius, HALF_ANGLE) > 0) {
        outside++;
        expect(sphereInView(centre, radius, heading)).toBe(false);
      }
    }
    expect(outside).toBeGreaterThan(5000);
  });

  it('nebulaViewExtent bounds every layer of 500 seeded nebulae, as the renderer places them', () => {
    let worstDepth = 0;
    let worstLateral = 0;
    for (let i = 0; i < 500; i++) {
      const seed = hash(0x7eb_01a, i);
      const params = nebulaParams(seed);
      const heading = unit({ x: Math.sin(i), y: 0.3 * Math.cos(3 * i), z: -1 });
      const { sideAngle } = encounterSide(seed);
      const plan = planEncounter({ x: 0, y: 0, z: 0 }, heading, params.radius, NEBULA_ENCOUNTER_DISTANCE, NEBULA_SIDE_OFFSET_FACTOR, sideAngle);
      const { depth, lateral } = nebulaViewExtent(params.radius, plan.closestDistance);
      for (const layer of nebulaLayerCorners(params, plan)) {
        for (const c of layer) {
          worstDepth = Math.max(worstDepth, dot(c, plan.direction) / depth);
          // From the path line, which passes closestDistance from the centre, along -side.
          const fromPath = { x: c.x + plan.side.x * plan.closestDistance, y: c.y + plan.side.y * plan.closestDistance, z: c.z + plan.side.z * plan.closestDistance };
          const along = dot(fromPath, plan.direction);
          const across = len(sub(fromPath, { x: plan.direction.x * along, y: plan.direction.y * along, z: plan.direction.z * along }));
          worstLateral = Math.max(worstLateral, across / lateral);
        }
      }
    }
    // Bounds, and not loose ones.
    expect(worstDepth).toBeLessThanOrEqual(1);
    expect(worstDepth).toBeGreaterThan(0.7);
    expect(worstLateral).toBeLessThanOrEqual(1);
    expect(worstLateral).toBeGreaterThan(0.7);
  });

  it('cruiseTargetSpeed eases up from the entry speed, no steeper than the max rate, and is still at the arrival speed by the lead', () => {
    const h = 0.01;
    for (let level = 0; level < SHIP_SPEED_LEVELS.length; level++) {
      const params = atLevel(level);
      const cruise = params.cruiseSpeed;
      const arrival = encounterCruiseSpeed(params);
      for (const interval of [ENCOUNTER_INTERVAL_SECONDS * (1 - ENCOUNTER_INTERVAL_JITTER), ENCOUNTER_INTERVAL_SECONDS]) {
        for (const entry of [params.profile.minSpeed, params.nebula.profile.minSpeed, params.asteroid.profile.minSpeed, params.comet.profile.minSpeed, arrival]) {
          const duration = warpEntryDuration(params, entry);
          expect(duration).toBeGreaterThanOrEqual(ENCOUNTER_WARP_ENTRY_SECONDS);
          expect((1.5 * (cruise - entry)) / duration).toBeLessThanOrEqual(ENCOUNTER_WARP_ENTRY_MAX_RATE + 1e-9);
          const exitStart = interval - ENCOUNTER_WARP_EXIT_LEAD_SECONDS - ENCOUNTER_WARP_EXIT_SECONDS;
          // Every configured cruise has room for the whole return before the drop out of warp.
          expect(duration).toBeLessThan(exitStart);
          let prev = cruiseTargetSpeed(0, interval, params, true, entry);
          expect(prev).toBe(Math.min(entry, cruise));
          for (let i = 1; i * h <= interval; i++) {
            const t = i * h;
            const v = cruiseTargetSpeed(t, interval, params, true, entry);
            expect(Math.abs(v - prev)).toBeLessThanOrEqual(ENCOUNTER_WARP_ENTRY_MAX_RATE * h + 1e-9);
            if (t <= duration) expect(v).toBeGreaterThanOrEqual(prev);
            else if (t <= exitStart) expect(v).toBe(cruise);
            if (t >= interval - ENCOUNTER_WARP_EXIT_LEAD_SECONDS + h / 2) expect(v).toBe(arrival);
            prev = v;
          }
        }
      }
    }
    // A cruise too short for the return from the minimum speed (only in tests) still reaches the
    // arrival speed by the lead, so the next encounter starts there with no step.
    const top = atLevel(SHIP_SPEED_LEVELS.length - 1);
    for (const short of [5, 12]) {
      expect(cruiseTargetSpeed(short - ENCOUNTER_WARP_EXIT_LEAD_SECONDS, short, top, true, ENCOUNTER_MIN_SPEED_FLOOR)).toBe(ENCOUNTER_ARRIVAL_SPEED);
      expect(cruiseTargetSpeed(short, short, top, true, ENCOUNTER_MIN_SPEED_FLOOR)).toBe(ENCOUNTER_ARRIVAL_SPEED);
    }
  });

  it.each([0, 1, 2])(
    'planets at level %i, k from 1.6 to 6 and elevations from -0.6 to 0.6: while in the 21:9 view the ship is never faster than on main, and it is never in view again after the encounter ends',
    (level) => {
      const sides = new Set<string>();
      let cases = 0;
      for (const k of [1.6, 2, 3, 4.5, 6]) {
        for (const elevation of [-0.6, -0.3, 0, 0.3, 0.6]) {
          for (const radius of [MEDIAN_PLANET_RADIUS, Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1])]) {
            const label = `level ${level}, k ${k}, elevation ${elevation}, radius ${radius}`;
            const params = atLevel(level, {
              nebulaShare: 0,
              sideOffsetFactor: k,
              sideElevation: [elevation, elevation],
              baseSeed: cases,
              planetFor: () => ({ radius }),
            });
            const r = againstMain(params, 1 / 60, (encounter, ship) =>
              sphereInView(encounterOffset(encounter.plan, ship.position, { x: 0, y: 0, z: 0 }), encounter.plan.radius * PLANET_VIEW_RADIUS_FACTOR, ship.heading),
            );
            sides.add(r.encounter.side);
            // The reference is main's distance-based profile, to the despawn distance.
            expect(r.worstProfileError, label).toBe(0);
            expect(r.mainEnd, label).toBeLessThanOrEqual(-ENCOUNTER_DESPAWN_DISTANCE);
            // In view for a good while, never faster than main then, and never in view again after the end.
            expect(r.inViewFrames, label).toBeGreaterThan(1000);
            expect(r.worstExcess, label).toBeLessThanOrEqual(1e-9);
            expect(r.inViewAfterEnd, label).toBe(0);
            // It ended after the closest approach (DEPARTURE lasts at least one step), and within a
            // few seconds of it: up to about 12 s for the largest planet at the slowest level.
            expect(r.endedAt, label).toBeGreaterThan(r.closestAt);
            expect(r.endedAt - r.closestAt, label).toBeLessThan(15);
            cases++;
          }
        }
      }
      expect(sides).toEqual(new Set(['left', 'right']));
    },
    60_000,
  );

  it.each([0, 1, 2])(
    'ringed planets at level %i, the widest ring, k from its clearance to 6, tilts and elevations from -0.6 to 0.6: while the planet or its ring is in the 21:9 view the ship is never faster than on main, and neither is in view again after the encounter ends',
    (level) => {
      const largest = Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1]);
      const ringedSeed = Array.from({ length: 200 }, (_, i) => hash(0x41a6, i)).find((seed) => planetParams(seed).ring !== null)!;
      const base = planetParams(ringedSeed);
      const outer = PLANET_RING_RANGES.inner[1] + PLANET_RING_RANGES.width[1];
      const clearance = outer * (1 + ENCOUNTER_CLEARANCE_MARGIN);
      let cases = 0;
      let latest = 0;
      for (const k of [clearance, 4.5, PLANET_PASS_FACTOR_RANGE[1]]) {
        for (const elevation of [-0.6, 0, 0.6]) {
          for (const [opening, roll] of [
            [PLANET_RING_RANGES.opening[0], -PLANET_RING_RANGES.roll[1]],
            [PLANET_RING_RANGES.opening[1], PLANET_RING_RANGES.roll[0]],
          ] as const) {
            for (const radius of [MEDIAN_PLANET_RADIUS, largest]) {
              const label = `level ${level}, k ${k}, elevation ${elevation}, opening ${opening}, roll ${roll}, radius ${radius}`;
              const planet: PlanetParams = {
                ...base,
                radius,
                passFactor: k,
                extent: outer,
                ring: { ...base.ring!, inner: PLANET_RING_RANGES.inner[1], outer, opening, roll },
              };
              const params = atLevel(level, { nebulaShare: 0, sideElevation: [elevation, elevation], baseSeed: cases, planetFor: () => planet });
              let disc: Vec3[] = [];
              let discFor: ActiveEncounter | null = null;
              const r = againstMain(params, 1 / 60, (encounter, ship) => {
                if (discFor !== encounter) {
                  disc = ringOutline(planet, encounter.plan);
                  discFor = encounter;
                }
                const centre = encounterOffset(encounter.plan, ship.position, { x: 0, y: 0, z: 0 });
                return (
                  sphereInView(centre, radius * PLANET_VIEW_RADIUS_FACTOR, ship.heading) ||
                  polygonInView(disc.map((c) => ({ x: c.x + centre.x, y: c.y + centre.y, z: c.z + centre.z })), ship.heading)
                );
              });
              expect(r.encounter.plan.closestDistance, label).toBeCloseTo(radius * k, 9);
              expect(r.worstProfileError, label).toBe(0);
              expect(r.inViewFrames, label).toBeGreaterThan(1000);
              expect(r.worstExcess, label).toBeLessThanOrEqual(1e-9);
              expect(r.inViewAfterEnd, label).toBe(0);
              expect(r.endedAt, label).toBeGreaterThan(r.closestAt);
              latest = Math.max(latest, r.endedAt - r.closestAt);
              cases++;
            }
          }
        }
      }
      // The ring takes longer to leave the view than the planet, but not much: under half a minute.
      expect(latest).toBeLessThan(30);
    },
    120_000,
  );

  it.each([0, 1, 2])(
    'nebulae at level %i, elevations from -0.6 to 0.6: while any layer is in the 21:9 view the ship is never faster than on main, and none is in view again after the encounter ends',
    (level) => {
      let cases = 0;
      let smallest = Number.POSITIVE_INFINITY;
      let largest = 0;
      for (const elevation of [-0.6, -0.3, 0, 0.3, 0.6]) {
        for (let draw = 0; draw < 3; draw++) {
          const label = `level ${level}, elevation ${elevation}, draw ${draw}`;
          let corners: Vec3[][] = [];
          let cornersFor: ActiveEncounter | null = null;
          const params = atLevel(level, { nebulaShare: 1, sideElevation: [elevation, elevation], baseSeed: 0x6e0 + 7 * cases, nebulaFor: nebulaParams });
          const r = againstMain(params, 1 / 60, (encounter, ship) => {
            if (encounter.kind !== 'nebula') throw new Error(`${label}: a ${encounter.kind}`);
            if (cornersFor !== encounter) {
              corners = nebulaLayerCorners(encounter.nebula as NebulaParams, encounter.plan);
              cornersFor = encounter;
            }
            const centre = encounterOffset(encounter.plan, ship.position, { x: 0, y: 0, z: 0 });
            return corners.some((layer) => polygonInView(layer.map((c) => ({ x: c.x + centre.x, y: c.y + centre.y, z: c.z + centre.z })), ship.heading));
          });
          smallest = Math.min(smallest, r.encounter.plan.radius);
          largest = Math.max(largest, r.encounter.plan.radius);
          expect(r.worstProfileError, label).toBe(0);
          expect(r.inViewFrames, label).toBeGreaterThan(1000);
          expect(r.worstExcess, label).toBeLessThanOrEqual(1e-9);
          expect(r.inViewAfterEnd, `${label} ${JSON.stringify(r.firstBack)}`).toBe(0);
          expect(r.endedAt, label).toBeGreaterThan(r.closestAt);
          cases++;
        }
      }
      expect(largest - smallest).toBeGreaterThan(30);
    },
    60_000,
  );

  it.each([0, 1, 2])(
    'asteroids at level %i, seeded single rocks and fields, elevations from -0.6 to 0.6: while any rock is in the 21:9 view the ship is never faster than on main, and none is in view again after the encounter ends',
    (level) => {
      let cases = 0;
      let fields = 0;
      let latest = 0;
      for (const elevation of [-0.6, -0.3, 0, 0.3, 0.6]) {
        for (let draw = 0; draw < 4; draw++) {
          const baseSeed = 0xa57 + 11 * cases;
          const label = `level ${level}, elevation ${elevation}, base seed ${baseSeed}`;
          let rocks: { centre: Vec3; radius: number }[] = [];
          let rocksFor: ActiveEncounter | null = null;
          const params = atLevel(level, { ...onlyKind('asteroid'), sideElevation: [elevation, elevation], baseSeed, asteroidFor: asteroidParams });
          const r = againstMain(params, 1 / 60, (encounter, ship) => {
            if (encounter.kind !== 'asteroid') throw new Error(`${label}: a ${encounter.kind}`);
            if (rocksFor !== encounter) {
              rocks = rockSpheres(encounter.asteroid as AsteroidParams, encounter.plan);
              rocksFor = encounter;
            }
            const centre = encounterOffset(encounter.plan, ship.position, { x: 0, y: 0, z: 0 });
            return rocks.some((rock) =>
              sphereInView({ x: centre.x + rock.centre.x, y: centre.y + rock.centre.y, z: centre.z + rock.centre.z }, rock.radius, ship.heading),
            );
          });
          if (rocks.length > 1) fields++;
          expect(r.worstProfileError, label).toBe(0);
          expect(r.inViewFrames, label).toBeGreaterThan(1000);
          expect(r.worstExcess, label).toBeLessThanOrEqual(1e-9);
          expect(r.inViewAfterEnd, `${label} ${JSON.stringify(r.firstBack)}`).toBe(0);
          expect(r.endedAt, label).toBeGreaterThan(r.closestAt);
          latest = Math.max(latest, r.endedAt - r.closestAt);
          cases++;
        }
      }
      // Fields and single rocks alike, and every one out of view soon after its closest approach.
      expect(fields).toBeGreaterThanOrEqual(4);
      expect(fields).toBeLessThan(cases);
      expect(latest).toBeLessThan(30);
    },
    120_000,
  );
});

describe('speed driven by visibility: comets', () => {
  it("a comet's view margin is the smallest of its bounds' margins (the coma's sphere without them), and its pass factor keeps the path out of the coma", () => {
    const comet = cometParams(hash(ENCOUNTER_BASE_SEED, 5));
    const plan = planEncounter({ x: 3, y: -2, z: 7 }, { x: 0.2, y: 0.1, z: -1 }, comet.radius, COMET_ENCOUNTER_DISTANCE, cometPassFactor(comet, 4), 0.4);
    const encounter: CometEncounter = { kind: 'comet', index: 0, seed: comet.seed, side: 'right', comet, plan };
    const up = { x: plan.side.y * plan.direction.z - plan.side.z * plan.direction.y, y: plan.side.z * plan.direction.x - plan.side.x * plan.direction.z, z: plan.side.x * plan.direction.y - plan.side.y * plan.direction.x };
    const half = DEFAULT_AUTOPILOT_PARAMS.viewHalfAngle;
    for (const remaining of [2000, 600, 100, 0, -20, -200]) {
      const position = { x: 3 + plan.direction.x * (COMET_ENCOUNTER_DISTANCE - remaining), y: -2 + plan.direction.y * (COMET_ENCOUNTER_DISTANCE - remaining), z: 7 + plan.direction.z * (COMET_ENCOUNTER_DISTANCE - remaining) };
      const ship = { ...createShipState(), position, heading: plan.direction };
      const nucleus = encounterOffset(plan, position, { x: 0, y: 0, z: 0 });
      const expected = Math.min(
        ...comet.bounds.map((b) => {
          const [a, c, e] = b.offset;
          const centre = {
            x: nucleus.x + a * plan.direction.x + c * plan.side.x + e * up.x,
            y: nucleus.y + a * plan.direction.y + c * plan.side.y + e * up.y,
            z: nucleus.z + a * plan.direction.z + c * plan.side.z + e * up.z,
          };
          return sphereViewMargin(centre, plan.direction, b.radius, half);
        }),
      );
      expect(encounterViewMargin(encounter, ship, half)).toBeCloseTo(expected, 12);
      // A tail can only keep a comet in view longer than its coma alone would.
      const bare: CometEncounter = { ...encounter, comet: { radius: comet.radius } };
      expect(encounterViewMargin(bare, ship, half)).toBeCloseTo(sphereViewMargin(nucleus, plan.direction, comet.radius, half), 12);
      expect(encounterViewMargin(encounter, ship, half)).toBeLessThanOrEqual(encounterViewMargin(bare, ship, half) + 1e-12);
    }
    expect(cometPassFactor({ radius: 30 }, 4)).toBe(4);
    expect(cometPassFactor({ radius: 30, passFactor: 1.1 }, 4)).toBe(1 + ENCOUNTER_CLEARANCE_MARGIN);
    expect(cometPassFactor(comet, 99)).toBe(comet.passFactor);
  });

  it.each([0, 1, 2])(
    'comets at level %i, elevations from -0.6 to 0.6: while the coma or any stretch of a tail is in the 21:9 view the ship is never faster than on main, and none is in view again after the encounter ends',
    (level) => {
      let cases = 0;
      let latest = 0;
      for (const elevation of [-0.6, 0, 0.6]) {
        for (let draw = 0; draw < 3; draw++) {
          const baseSeed = 0xc0e + 13 * cases;
          const label = `level ${level}, elevation ${elevation}, base seed ${baseSeed}`;
          let spheres: { centre: Vec3; radius: number }[] = [];
          let spheresFor: ActiveEncounter | null = null;
          const params = atLevel(level, { ...onlyKind('comet'), sideElevation: [elevation, elevation], baseSeed, cometFor: cometParams });
          const r = againstMain(params, 1 / 60, (encounter, ship) => {
            if (encounter.kind !== 'comet') throw new Error(`${label}: a ${encounter.kind}`);
            if (spheresFor !== encounter) {
              spheres = cometSpheres(encounter.comet as CometParams, encounter.plan);
              spheresFor = encounter;
            }
            const centre = encounterOffset(encounter.plan, ship.position, { x: 0, y: 0, z: 0 });
            return spheres.some((sphere) =>
              sphereInView({ x: centre.x + sphere.centre.x, y: centre.y + sphere.centre.y, z: centre.z + sphere.centre.z }, sphere.radius, ship.heading),
            );
          });
          expect(spheres.length, label).toBe(1 + 2 * 40);
          expect(r.worstProfileError, label).toBe(0);
          expect(r.inViewFrames, label).toBeGreaterThan(1000);
          expect(r.worstExcess, label).toBeLessThanOrEqual(1e-9);
          expect(r.inViewAfterEnd, `${label} ${JSON.stringify(r.firstBack)}`).toBe(0);
          expect(r.endedAt, label).toBeGreaterThan(r.closestAt);
          latest = Math.max(latest, r.endedAt - r.closestAt);
          cases++;
        }
      }
      // The tails lie behind the camera after the closest approach, so a comet leaves the view with
      // its coma: measured within about 0.1 s of the closest approach at every level.
      expect(latest).toBeLessThan(2);
    },
    120_000,
  );

  it.each([0, 1, 2])('at level %i a comet encounter ends within a second of the closest approach, and the ship is back at the arrival speed soon after', (level) => {
    const comet = cometParams(hash(ENCOUNTER_BASE_SEED, 5));
    const before = departureTimes('comet', level, Math.PI, comet);
    const after = departureTimes('comet', level, DEFAULT_AUTOPILOT_PARAMS.viewHalfAngle, comet);
    const label = `comet at level ${level}: ${JSON.stringify({ before, after })}`;
    // Measured (seconds after the closest approach; before → after, before being main's departure to
    // the despawn distance): out of view 0.01–0.02 s after it at every level (the tails are behind the
    // camera, and the coma is already beside it), so the encounter ends on the step after (DEPARTURE
    // lasts at least one); back at the arrival speed 115.3 → 13.5 (level 0), 54.7 → 13.8 (level 1) and
    // 54.7 → 7.0 (level 2).
    expect(after.outOfView, label).toBe(before.outOfView);
    expect(after.outOfView, label).toBeLessThan(0.1);
    expect(after.ended - after.outOfView, label).toBeLessThanOrEqual(2 / 60 + 1e-9);
    expect(after.atArrival, label).toBeLessThan(before.atArrival);
    expect(after.atCruise, label).toBeLessThan(before.atCruise);
    // As for planets (docs/PLAN.md section 9, Phase 4): at least 50% sooner at the default and top levels.
    if (level >= SHIP_DEFAULT_SPEED_LEVEL) expect(after.atArrival, label).toBeLessThanOrEqual(0.5 * before.atArrival);
    expect(after.worstAccel, label).toBeLessThan(16);
  });
});

describe('speed driven by visibility: the departure, before and after', () => {
  // Measured with `departureTimes` (seconds after the closest approach; before → after):
  //
  //   kind    level  out of view   encounter ends   at arrival speed   at cruise speed
  //   planet  20     1.5           130.4 → 1.5      130.4 → 15.1       130.4 → 15.1
  //   planet  60     1.0            59.7 → 1.0       59.7 → 14.8        59.7 → 14.8
  //   planet  150    1.0            59.7 → 1.0       59.7 → 8.0         72.6 → 18.3
  //   nebula  20     60.3           90.0 → 60.3      90.0 → 60.3        90.0 → 60.3
  //   nebula  60     23.9           33.8 → 23.9      33.8 → 26.1        33.8 → 26.1
  //   nebula  150    23.9           33.8 → 23.9      33.8 → 24.9        46.7 → 36.9
  it.each([0, 1, 2])('at level %i the ship is back at speed sooner after the closest approach, a median planet at least 50% sooner, with gentle acceleration', (level) => {
    const cruise = SHIP_SPEED_LEVELS[level]!;
    for (const kind of ['planet', 'nebula'] as const) {
      const before = departureTimes(kind, level, Math.PI);
      const after = departureTimes(kind, level, DEFAULT_AUTOPILOT_PARAMS.viewHalfAngle);
      const label = `${kind} at level ${level}: ${JSON.stringify({ before, after })}`;
      // The same until the object is out of view, and the encounter ends right then.
      expect(after.outOfView, label).toBe(before.outOfView);
      expect(after.ended, label).toBe(after.outOfView);
      expect(after.ended, label).toBeLessThan(before.ended);
      expect(after.atArrival, label).toBeLessThan(before.atArrival);
      expect(after.atCruise, label).toBeLessThan(before.atCruise);
      if (kind === 'planet') {
        // A planet is out of view within a couple of seconds of the closest approach.
        expect(after.outOfView, label).toBeLessThan(2);
        // The acceptance bound (docs/PLAN.md section 9, Phase 4) at the default and top levels; in
        // fact at every level the time to cruise speed is at least 70% shorter.
        if (level >= SHIP_DEFAULT_SPEED_LEVEL) expect(after.atArrival, label).toBeLessThanOrEqual(0.5 * before.atArrival);
        expect(after.atCruise, label).toBeLessThanOrEqual(0.3 * before.atCruise);
      }
      // Acceleration stays gentle: at the reduced-motion level, no more than the return from the
      // floored minimum speed (4 to 20 over the entry time: a slope of at most 3); at the top level,
      // under 16, as for the drop out of warp.
      if (level === REDUCED_MOTION_SPEED_LEVEL) {
        expect(after.worstAccel, label).toBeLessThanOrEqual((1.5 * (cruise - ENCOUNTER_MIN_SPEED_FLOOR)) / ENCOUNTER_WARP_ENTRY_SECONDS);
      }
      expect(after.worstAccel, label).toBeLessThan(16);
    }
  });
});
