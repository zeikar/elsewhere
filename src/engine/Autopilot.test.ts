import { describe, expect, it } from 'vitest';
import {
  DT_CAP_SECONDS,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DESPAWN_DISTANCE,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_DRIFT_SETTLE_SECONDS,
  ENCOUNTER_FLYBY_DISTANCE,
  ENCOUNTER_INTERVAL_SECONDS,
  ENCOUNTER_MIN_SPEED_FLOOR,
  ENCOUNTER_NEBULA_SHARE,
  ENCOUNTER_NEBULA_SHARE_BOUNDS,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  NEBULA_DESPAWN_DISTANCE,
  NEBULA_ENCOUNTER_DISTANCE,
  NEBULA_MIN_SPEED,
  NEBULA_SIDE_OFFSET_FACTOR,
  SHIP_MAX_TURN_RATE_RAD_PER_S,
  SHIP_SPEED_LEVELS,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  NEBULA_ENCOUNTER_PROFILE,
  createAutopilotState,
  defaultNebula,
  defaultPlanet,
  encounterKind,
  setCruiseSpeed,
  updateAutopilot,
  type AutopilotParams,
  type AutopilotState,
  type TravelState,
} from './Autopilot';
import { encounterOffset } from './encounter';
import { hash } from './seed';
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

/** Stops once `n` encounters have finished (returned to CRUISE). */
const afterEncounters = (n: number) => (_a: Readonly<AutopilotState>, transitions: readonly Transition[]) =>
  transitions.filter((t) => t.to === 'CRUISE').length >= n;

const CYCLE: TravelState[] = ['APPROACH', 'FLYBY', 'DEPARTURE', 'CRUISE'];

/** The default params with every encounter a planet. */
const PLANETS_ONLY: Readonly<AutopilotParams> = { ...DEFAULT_AUTOPILOT_PARAMS, nebulaShare: 0 };

describe('autopilot config', () => {
  it('the thresholds are consistent', () => {
    expect(ENCOUNTER_INTERVAL_SECONDS).toBeGreaterThan(0);
    expect(ENCOUNTER_DRIFT_SETTLE_SECONDS).toBeGreaterThan(0);
    expect(ENCOUNTER_DRIFT_SETTLE_SECONDS).toBeLessThanOrEqual(ENCOUNTER_INTERVAL_SECONDS);
    expect(ENCOUNTER_FLYBY_DISTANCE).toBeGreaterThan(0);
    expect(ENCOUNTER_FLYBY_DISTANCE).toBeLessThan(ENCOUNTER_DISTANCE);
    expect(ENCOUNTER_PLANET_RADIUS).toBeGreaterThan(0);
    // The planet is planned past the slowdown, so the encounter starts at cruise speed.
    expect(ENCOUNTER_DISTANCE).toBeGreaterThanOrEqual(ENCOUNTER_SLOWDOWN_DISTANCE);
  });

  it('defaults to the config values', () => {
    expect(DEFAULT_AUTOPILOT_PARAMS.interval).toBe(ENCOUNTER_INTERVAL_SECONDS);
    expect(DEFAULT_AUTOPILOT_PARAMS.encounterDistance).toBe(ENCOUNTER_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.sideOffsetFactor).toBe(ENCOUNTER_SIDE_OFFSET_FACTOR);
    expect(DEFAULT_AUTOPILOT_PARAMS.profile.despawnDistance).toBe(ENCOUNTER_DESPAWN_DISTANCE);
    expect(DEFAULT_AUTOPILOT_PARAMS.baseSeed).toBe(ENCOUNTER_BASE_SEED);
    expect(defaultPlanet(123).radius).toBe(ENCOUNTER_PLANET_RADIUS);
    expect(DEFAULT_AUTOPILOT_PARAMS.nebulaShare).toBe(ENCOUNTER_NEBULA_SHARE);
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
  it('is deterministic, and over 1,000 encounter indices both kinds occur at shares within the configured bounds', () => {
    const [low, high] = ENCOUNTER_NEBULA_SHARE_BOUNDS;
    for (const baseSeed of [ENCOUNTER_BASE_SEED, 1, 0xdeadbeef, 0x12345678, 2024]) {
      let nebulae = 0;
      for (let i = 0; i < 1000; i++) {
        const seed = hash(baseSeed, i);
        const kind = encounterKind(seed, ENCOUNTER_NEBULA_SHARE);
        expect(encounterKind(seed, ENCOUNTER_NEBULA_SHARE)).toBe(kind);
        if (kind === 'nebula') nebulae++;
      }
      const share = nebulae / 1000;
      expect(share, `base seed ${baseSeed}`).toBeGreaterThanOrEqual(low);
      expect(share, `base seed ${baseSeed}`).toBeLessThanOrEqual(high);
      expect(1 - share, `base seed ${baseSeed}: planets`).toBeGreaterThan(0);
    }
  });

  it('a share of 0 gives only planets and 1 only nebulae; the first default encounter is a planet', () => {
    for (let i = 0; i < 200; i++) {
      const seed = hash(ENCOUNTER_BASE_SEED, i);
      expect(encounterKind(seed, 0)).toBe('planet');
      expect(encounterKind(seed, 1)).toBe('nebula');
    }
    expect(encounterKind(hash(ENCOUNTER_BASE_SEED, 0), ENCOUNTER_NEBULA_SHARE)).toBe('planet');
  });
});

describe('createAutopilotState', () => {
  it('starts in CRUISE at cruise speed with full drift and no encounter', () => {
    const s = createAutopilotState();
    expect(s).toEqual({
      state: 'CRUISE',
      cruiseTime: 0,
      encounterCount: 0,
      encounter: null,
      remaining: Number.POSITIVE_INFINITY,
      fade: 0,
      targetSpeed: DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed,
      driftRate: 1,
    });
  });
});

describe('updateAutopilot', () => {
  it('is pure: the input state is not modified, and writing into the input gives the same result', () => {
    const ship = createShipState({ time: 10, speed: 60 });
    const state = { ...createAutopilotState(), cruiseTime: ENCOUNTER_INTERVAL_SECONDS - 0.01 };
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
    const state = { ...createAutopilotState(), cruiseTime: ENCOUNTER_INTERVAL_SECONDS, encounterCount: 4 };
    const next = updateAutopilot(state, ship, 1 / 60, PLANETS_ONLY);
    expect(next.state).toBe('APPROACH');
    expect(next.encounterCount).toBe(5);
    // The encounter starts one frame late; that lateness is kept for the next cruise.
    expect(next.cruiseTime).toBeCloseTo(1 / 60, 12);
    const encounter = next.encounter!;
    expect(encounter.index).toBe(4);
    expect(encounter.seed).toBe(hash(ENCOUNTER_BASE_SEED, 4));
    expect(encounter.kind).toBe('planet');
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
    const state = { ...createAutopilotState(params), cruiseTime: ENCOUNTER_INTERVAL_SECONDS };
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
    const state = { ...createAutopilotState(params), cruiseTime: ENCOUNTER_INTERVAL_SECONDS, encounterCount: 2 };
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
      let end: { shipSpeed: number; targetSpeed: number; fade: number; driftRate: number } | null = null;
      const { transitions } = simulate(dt, {
        params,
        until: afterEncounters(1),
        onFrame: ({ ship, prevAutopilot, autopilot }) => {
          worstFadeStep = Math.max(worstFadeStep, Math.abs(autopilot.fade - prevAutopilot.fade));
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
            end = { shipSpeed: ship.speed, targetSpeed: autopilot.targetSpeed, fade: autopilot.fade, driftRate: autopilot.driftRate };
          }
        },
      });
      expect(transitions.map((t) => t.to)).toEqual(CYCLE);
      expect(transitions.map((t) => t.encounterIndex)).toEqual([0, 0, 0, 0]);
      // Slows for the nebula (to the scaled minimum, floored), and is back at cruise speed by the end.
      const minSpeed = Math.min(cruiseSpeed, Math.max(NEBULA_MIN_SPEED * (cruiseSpeed / DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed), ENCOUNTER_MIN_SPEED_FLOOR));
      expect(slowest).toBeLessThan(minSpeed * 1.25);
      expect(end).not.toBeNull();
      expect(end!.targetSpeed).toBe(cruiseSpeed);
      // Within 2% of it (within 1% at the default speed; the top speed covers the margin after the
      // speed-up in fewer time constants, as it does for planets).
      const tolerance = cruiseSpeed === DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed ? 0.01 : 0.02;
      expect(Math.abs(end!.shipSpeed - cruiseSpeed) / cruiseSpeed).toBeLessThan(tolerance);
      expect(end!.fade).toBe(0);
      expect(end!.driftRate).toBe(1);
      // Heading held, fades gradual, and clear of the core.
      expect(worstHeldAngle).toBe(0);
      expect(worstFadeStep).toBeLessThan(0.02);
      const radius = defaultNebula(0).radius;
      expect(minClearance).toBeCloseTo(radius * NEBULA_SIDE_OFFSET_FACTOR, 3);
    },
  );

  it('with the default share, planets and nebulae alternate by seed, each through the full cycle', () => {
    const kinds: string[] = [];
    const { transitions } = simulate(1 / 60, {
      until: afterEncounters(6),
      maxSeconds: 4000,
      onFrame: ({ prevAutopilot, autopilot }) => {
        if (autopilot.state === 'APPROACH' && prevAutopilot.state === 'CRUISE') kinds.push(autopilot.encounter!.kind);
      },
    });
    expect(transitions.map((t) => t.to)).toEqual(Array.from({ length: 6 }, () => CYCLE).flat());
    expect(kinds).toEqual(
      Array.from({ length: 6 }, (_, i) => encounterKind(hash(ENCOUNTER_BASE_SEED, i), ENCOUNTER_NEBULA_SHARE)),
    );
    expect(new Set(kinds)).toEqual(new Set(['planet', 'nebula']));
  });

  it('setCruiseSpeed scales the nebula profile like the planet one and keeps its distances', () => {
    for (const speed of SHIP_SPEED_LEVELS) {
      const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS };
      setCruiseSpeed(params, speed);
      const factor = speed / DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed;
      expect({ ...params.nebula.profile, minSpeed: 0 }).toEqual({ ...NEBULA_ENCOUNTER_PROFILE, minSpeed: 0 });
      expect(params.nebula.profile.minSpeed).toBeCloseTo(
        Math.min(speed, Math.max(NEBULA_MIN_SPEED * factor, ENCOUNTER_MIN_SPEED_FLOOR)),
        12,
      );
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

  it.each([5, 20, 40, 55])('APPROACH begins after the configured interval (%f s), every cycle', (interval) => {
    const dt = 1 / 60;
    const { transitions } = simulate(dt, { params: { interval }, until: afterEncounters(2) });
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
            worstFadeStep = Math.max(worstFadeStep, Math.abs(autopilot.fade - prevAutopilot.fade));

            const encounter = autopilot.encounter ?? prevAutopilot.encounter;
            if (encounter === null) return;
            // Minimum centre distance over the whole frame segment, not just its end points.
            encounterOffset(encounter.plan, prev.position, rel0);
            encounterOffset(encounter.plan, ship.position, rel1);
            const negate = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: -v.z });
            minClearance = Math.min(minClearance, originToSegment(negate(rel0), negate(rel1)));

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
        expect(worstHeldAngle).toBe(0);
        expect(worstPathDeviation).toBeLessThan(1e-6);
        // Fades in and out gradually: no frame changes the opacity by more than 2%.
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

  // Stated tolerance: 0.05 s. Each transition fires on the first frame past its threshold, so it
  // lands up to one frame (1/60 s) after the exact time. The autopilot carries that overshoot into
  // the next phase, so the lateness does not add up across encounters. A small O(dt) difference per
  // encounter remains, because the target speed is updated only once per frame, so the gap still
  // grows slowly with the encounter count (it passes 0.05 s at around 30 encounters). Raising the
  // count here needs a larger tolerance.
  const TIMELINE_TOLERANCE_S = 0.05;

  it.each([3, 15])('the timeline matches between dt = 1/60 and dt = 1/120 over %i encounters', (n) => {
    const maxSeconds = 600 * n;
    const at60 = simulate(1 / 60, { until: afterEncounters(n), maxSeconds }).transitions;
    const at120 = simulate(1 / 120, { until: afterEncounters(n), maxSeconds }).transitions;
    expect(at60.map((t) => t.to)).toEqual(at120.map((t) => t.to));
    expect(at60).toHaveLength(4 * n);
    for (let i = 0; i < at60.length; i++) {
      expect(Math.abs(at60[i]!.time - at120[i]!.time)).toBeLessThanOrEqual(TIMELINE_TOLERANCE_S);
    }
  });

  it('completes 10 consecutive encounters with distinct indices, each ending back at cruise speed', () => {
    const cruiseSpeed = DEFAULT_AUTOPILOT_PARAMS.cruiseSpeed;
    const ends: Array<{ shipSpeed: number; targetSpeed: number; fade: number; driftRate: number }> = [];
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
          ends.push({ shipSpeed: ship.speed, targetSpeed: a.targetSpeed, fade: a.fade, driftRate: a.driftRate });
        }
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
      expect(end.targetSpeed).toBe(cruiseSpeed);
      expect(Math.abs(end.shipSpeed - cruiseSpeed) / cruiseSpeed).toBeLessThan(0.01);
      expect(end.fade).toBe(0);
      expect(end.driftRate).toBe(1);
    }
  });
});
