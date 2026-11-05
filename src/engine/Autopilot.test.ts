import { describe, expect, it } from 'vitest';
import {
  CAMERA_FOV_DEG,
  DT_CAP_SECONDS,
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DESPAWN_DISTANCE,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_JITTER,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_MAX_SAME_KIND_RUN,
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
  PLANET_ROCKY_RANGES,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_MAX_TURN_RATE_RAD_PER_S,
  SHIP_SPEED_LEVELS,
  SHIP_SPEED_TAU_SECONDS,
  VIEW_WIDEST_ASPECT,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  NEBULA_ENCOUNTER_PROFILE,
  PLANET_VIEW_RADIUS_FACTOR,
  cappedNebulaShare,
  createAutopilotState,
  cruiseInterval,
  cruiseTargetSpeed,
  cruiseIntervalFor,
  defaultNebula,
  createTravel,
  defaultPlanet,
  encounterCruiseSpeed,
  encounterKind,
  encounterKindAt,
  encounterSchedule,
  encounterSide,
  encounterViewMargin,
  kindDrawShare,
  nebulaViewExtent,
  nextEncounterKind,
  setCruiseSpeed,
  stepTravel,
  updateAutopilot,
  warpEntryDuration,
  type ActiveEncounter,
  type AutopilotParams,
  type AutopilotState,
  type TravelState,
} from './Autopilot';
import {
  encounterOffset,
  encounterRemaining,
  encounterTargetSpeed,
  planEncounter,
  sphereViewMargin,
  viewConeHalfAngle,
} from './encounter';
import { DEFAULT_NEBULA_FRAME, nebulaLayerLayout, nebulaParams } from './Nebula';
import { planetParams } from './Planet';
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

/** The default params with every encounter a planet. */
const PLANETS_ONLY: Readonly<AutopilotParams> = { ...DEFAULT_AUTOPILOT_PARAMS, nebulaShare: 0 };

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

  it('over 1,000 encounters per base seed: both kinds at shares within bounds, no run longer than the cap', () => {
    const [low, high] = ENCOUNTER_NEBULA_SHARE_BOUNDS;
    for (const baseSeed of BASE_SEEDS) {
      const schedule = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 1000);
      const kinds = schedule.map((e) => e.kind);
      expect(encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 1000)).toEqual(schedule);
      const share = kinds.filter((k) => k === 'nebula').length / kinds.length;
      expect(share, `base seed ${baseSeed}`).toBeGreaterThanOrEqual(low);
      expect(share, `base seed ${baseSeed}`).toBeLessThanOrEqual(high);
      expect(longestRun(kinds), `base seed ${baseSeed}`).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
      // The cap is in effect: runs reach it (they would run longer without it).
      expect(longestRun(kinds), `base seed ${baseSeed}`).toBe(ENCOUNTER_MAX_SAME_KIND_RUN);
      const uncapped = schedule.map((e) => encounterKind(e.seed, ENCOUNTER_NEBULA_SHARE));
      expect(longestRun(uncapped), `base seed ${baseSeed}: uncapped`).toBeGreaterThan(ENCOUNTER_MAX_SAME_KIND_RUN);
    }
  });

  it('over 50,000 encounters the nebula share is the configured share, within 0.01', () => {
    // The standard error of the share over 50,000 encounters is about 0.002, so the 0.01 tolerance
    // is about 5 standard errors: an uncompensated draw (a share of about 0.415) fails it.
    for (const baseSeed of [ENCOUNTER_BASE_SEED, 0xdeadbeef]) {
      const kinds = encounterSchedule({ ...DEFAULT_AUTOPILOT_PARAMS, baseSeed }, 50_000).map((e) => e.kind);
      const share = kinds.filter((k) => k === 'nebula').length / kinds.length;
      expect(Math.abs(share - ENCOUNTER_NEBULA_SHARE), `base seed ${baseSeed}: share ${share}`).toBeLessThan(0.01);
      expect(longestRun(kinds), `base seed ${baseSeed}`).toBeLessThanOrEqual(ENCOUNTER_MAX_SAME_KIND_RUN);
    }
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

  it('encounterKindAt: a planet at index 0 unless every encounter is a nebula, nextEncounterKind after that', () => {
    const params = { nebulaShare: ENCOUNTER_NEBULA_SHARE, maxSameKindRun: 3 };
    for (let i = 0; i < 300; i++) {
      const seed = hash(ENCOUNTER_BASE_SEED, i);
      expect(encounterKindAt(0, seed, params, null, 0)).toBe('planet');
      expect(encounterKindAt(0, seed, { ...params, nebulaShare: 0 }, null, 0)).toBe('planet');
      expect(encounterKindAt(0, seed, { ...params, nebulaShare: 1 }, null, 0)).toBe('nebula');
      for (const [lastKind, run] of [['planet', 1], ['nebula', 2], ['planet', 3]] as const) {
        expect(encounterKindAt(i + 1, seed, params, lastKind, run)).toBe(nextEncounterKind(seed, params, lastKind, run));
      }
    }
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

  it('with the default share, planets and nebulae follow the schedule, each through the full cycle', () => {
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
    expect(new Set(kinds)).toEqual(new Set(['planet', 'nebula']));
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
    expect(new Set(kinds)).toEqual(new Set(['planet', 'nebula']));
    expect(sides).toEqual(new Set(['left', 'right']));
    const [low, high] = ENCOUNTER_NEBULA_SHARE_BOUNDS;
    const share = kinds.filter((k) => k === 'nebula').length / n;
    expect(share).toBeGreaterThanOrEqual(low);
    expect(share).toBeLessThanOrEqual(high);
    // Cruise lengths, from load and from each return to CRUISE to the next APPROACH. Stated tolerance
    // for the mean: 1% of the configured interval (the jitter's standard error over 1,000 encounters
    // is about 0.3%, and each cruise is measured to within two steps).
    const mean = total / n;
    expect(Math.abs(mean - ENCOUNTER_INTERVAL_SECONDS)).toBeLessThan(0.01 * ENCOUNTER_INTERVAL_SECONDS);
  }, 60_000);

  describe('safety across 200 randomly seeded encounters of each kind', () => {
    const largestPlanet = Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1]);
    const largestNebula = NEBULA_RANGES.radius[1];
    const random = mulberry32(0x5afe_7e57);
    const draws = Array.from({ length: 200 }, () => ({
      baseSeed: Math.floor(random() * 2 ** 32),
      level: Math.floor(random() * SHIP_SPEED_LEVELS.length),
      dt: random() < 0.5 ? 1 / 60 : 1 / 120,
    }));
    // The largest radius of each kind at every speed level, on top of the seeded radii.
    const largest = SHIP_SPEED_LEVELS.map((_, level) => ({ baseSeed: level + 1, level, dt: 1 / 60, largest: true }));
    const cases = [...draws.map((d) => ({ ...d, largest: false })), ...largest];

    it.each(['planet', 'nebula'] as const)('%s: clearance ≥ radius × (1 + margin) and no frame jumps', (kind) => {
      let checked = 0;
      let largestSeen = 0;
      for (const { baseSeed, level, dt, largest: useLargest } of cases) {
        const params: AutopilotParams = {
          ...DEFAULT_AUTOPILOT_PARAMS,
          baseSeed,
          interval: 1,
          nebulaShare: kind === 'nebula' ? 1 : 0,
          planetFor: useLargest ? () => ({ radius: largestPlanet }) : planetParams,
          nebulaFor: useLargest ? () => ({ radius: largestNebula }) : nebulaParams,
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
      expect(largestSeen).toBe(kind === 'planet' ? largestPlanet : largestNebula);
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
    const cases = (['planet', 'nebula'] as const).flatMap((kind) => [1 / 60, 1 / 120].map((dt) => ({ kind, dt })));

    it.each(cases)(
      'the ship is out of warp when the $kind reaches opacity 0.1, and flies the profile for its encounter speed from the spawn (dt $dt)',
      ({ kind, dt }) => {
        const params = atSpeed(cruiseSpeed, { nebulaShare: kind === 'nebula' ? 1 : 0 });
        // At or above the arrival speed, the profile is the default level's itself.
        if (cruiseSpeed >= ENCOUNTER_ARRIVAL_SPEED) {
          expect(params.profile).toEqual(DEFAULT_AUTOPILOT_PARAMS.profile);
          expect(params.nebula.profile).toEqual(DEFAULT_AUTOPILOT_PARAMS.nebula.profile);
        }
        const profile = kind === 'nebula' ? params.nebula.profile : params.profile;
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

    it.each((['planet', 'nebula'] as const).flatMap((kind) => [1 / 60, 1 / 120].map((dt) => ({ kind, dt }))))(
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
        const params = atSpeed(cruiseSpeed, { nebulaShare: kind === 'nebula' ? 1 : 0 });
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
        const minSpeed = (kind === 'nebula' ? params.nebula.profile : params.profile).minSpeed;
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
        // layer, when it is back at the encounter speed.
        expect(entrySpeed).toBeLessThanOrEqual(encounterSpeed);
        if (kind === 'planet') expect(entrySpeed).toBeLessThan(encounterSpeed / 2);
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
