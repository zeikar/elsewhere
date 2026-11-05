import { describe, expect, it } from 'vitest';
import { DT_CAP_SECONDS, SHIP_HEADING } from '../config';
import {
  DEFAULT_SHIP_PARAMS,
  clampDt,
  createShipState,
  updateShip,
  type ShipParams,
  type ShipState,
  type Vec3,
} from './Ship';

function run(state: ShipState, dt: number, steps: number, params: ShipParams): ShipState {
  let s = state;
  for (let i = 0; i < steps; i++) s = updateShip(s, dt, params);
  return s;
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

describe('clampDt', () => {
  it('caps dt at 0.1 s', () => {
    expect(DT_CAP_SECONDS).toBe(0.1);
    expect(clampDt(5)).toBe(0.1);
    expect(clampDt(0.1)).toBe(0.1);
    expect(clampDt(1 / 60)).toBe(1 / 60);
  });

  it('turns negative and NaN dt into 0, and caps +Infinity', () => {
    expect(clampDt(-1)).toBe(0);
    expect(clampDt(Number.NaN)).toBe(0);
    expect(clampDt(Number.POSITIVE_INFINITY)).toBe(0.1);
  });
});

describe('updateShip', () => {
  // Section 10: refresh-rate independence. Stated tolerance: 0.5% relative, as the issue suggests.
  // The analytic integration actually agrees to rounding error, so the distance is also held to a
  // much tighter bound that an Euler-style regression (~0.1-1% off) would clearly fail.
  const REFRESH_TOLERANCE = 0.005;
  const ANALYTIC_DISTANCE_TOLERANCE = 1e-9;

  it.each([
    { label: 'converging from rest', speed: 0 },
    { label: 'converging from above', speed: 140 },
    { label: 'already at target', speed: 60 },
  ])('travels the same distance at 60 Hz and 120 Hz ($label)', ({ speed }) => {
    const params: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: 60, speedTau: 2 };
    const start = createShipState({ speed, time: 37 });

    const at60 = run(start, 1 / 60, 60, params);
    const at120 = run(start, 1 / 120, 120, params);

    if (speed !== 60) {
      // Still converging after 1 s, so the speed is not yet at the target.
      expect(Math.abs(at60.speed - 60)).toBeGreaterThan(1);
    }
    expect(at60.distance).toBeGreaterThan(0);
    const distanceError = Math.abs(at60.distance - at120.distance) / at60.distance;
    expect(distanceError).toBeLessThan(REFRESH_TOLERANCE);
    expect(distanceError).toBeLessThan(ANALYTIC_DISTANCE_TOLERANCE);
    expect(Math.abs(at60.speed - at120.speed)).toBeLessThan(1e-9);

    const gap = Math.hypot(
      at60.position.x - at120.position.x,
      at60.position.y - at120.position.y,
      at60.position.z - at120.position.z,
    );
    expect(gap / at60.distance).toBeLessThan(REFRESH_TOLERANCE);
  });

  it('never moves further than 0.1 s of travel in one over-large step', () => {
    const params: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: 100 };
    const cruising = createShipState({ speed: 100 });
    const next = updateShip(cruising, 5, params);
    expect(next.time).toBeCloseTo(0.1, 12);
    expect(next.distance).toBeCloseTo(100 * 0.1, 9);
    expect(length(next.position)).toBeLessThanOrEqual(100 * 0.1 + 1e-9);

    // Decelerating from a higher speed: still bounded by the starting speed × 0.1 s.
    const fast = createShipState({ speed: 150 });
    const slowed = updateShip(fast, 5, params);
    expect(slowed.distance).toBeLessThanOrEqual(150 * 0.1);
  });

  it.each([
    { label: 'acceleration', from: 0, to: 150 },
    { label: 'deceleration', from: 150, to: 20 },
  ])('approaches the target speed monotonically without overshoot ($label)', ({ from, to }) => {
    const params: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: to, speedTau: 2 };
    let s = createShipState({ speed: from });
    // Mixed frame times, including clamped spikes.
    const dts = [1 / 60, 1 / 144, 1 / 30, 0.1, 3, 1 / 120];
    const sign = Math.sign(to - from);
    for (let i = 0; i < 2000; i++) {
      const next = updateShip(s, dts[i % dts.length] ?? 1 / 60, params);
      expect(sign * (next.speed - s.speed)).toBeGreaterThanOrEqual(0);
      expect(sign * (to - next.speed)).toBeGreaterThanOrEqual(0);
      s = next;
    }
    expect(s.speed).toBeCloseTo(to, 6);
  });

  it('always heads along -Z, at any time, speed and frame time: the heading never turns', () => {
    expect(SHIP_HEADING).toEqual({ x: 0, y: 0, z: -1 });
    for (const init of [{}, { time: 90 }, { time: 1e6, speed: 150 }]) expect(createShipState(init).heading).toEqual(SHIP_HEADING);
    // Ten simulated minutes through every speed and mixed frame times, including clamped spikes.
    const dts = [1 / 60, 1 / 144, 1 / 30, 0.1, 3, 1 / 120];
    const targets = [0, 20, 150, 60];
    let s = createShipState();
    const start = { ...s.position };
    for (let i = 0; s.time < 600; i++) {
      s = updateShip(s, dts[i % dts.length]!, { ...DEFAULT_SHIP_PARAMS, targetSpeed: targets[Math.floor(i / 500) % targets.length]! });
      expect(s.heading).toEqual(SHIP_HEADING);
    }
    // A straight line along it: the position moved only in -Z, by the distance travelled.
    expect(s.position.x).toBe(start.x);
    expect(s.position.y).toBe(start.y);
    expect(start.z - s.position.z).toBeCloseTo(s.distance, 6);
  });

  it('exposes velocity as heading × speed', () => {
    const params = DEFAULT_SHIP_PARAMS;
    const s = run(createShipState({}), 1 / 60, 500, params);
    expect(s.velocity.x).toBeCloseTo(s.heading.x * s.speed, 12);
    expect(s.velocity.y).toBeCloseTo(s.heading.y * s.speed, 12);
    expect(s.velocity.z).toBeCloseTo(s.heading.z * s.speed, 12);
  });

  it('keeps float64 precision far from the origin', () => {
    // ulp(1e12) is about 1.2e-4 per component, so a 1000-unit step resolves to about 1e-7 relative
    // error. In float32 the same coordinates would be 65536 units apart.
    const speed = 1000;
    const far = { x: 1e12, y: 1e12, z: 1e12 };
    const displacement = (a: ShipState, b: ShipState): Vec3 => ({
      x: b.position.x - a.position.x,
      y: b.position.y - a.position.y,
      z: b.position.z - a.position.z,
    });

    // A straight line (the heading is fixed), so the 1 s path length equals the size of the
    // position delta. A single 1 s step would be clamped to 0.1 s, so 1 s is ten 0.1 s steps.
    const params: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: speed };
    const start = createShipState({ speed, position: far });
    const delta = length(displacement(start, run(start, 0.1, 10, params)));
    expect(Math.abs(delta - speed * 1) / (speed * 1)).toBeLessThan(1e-6);

    // The delta far away matches the same journey started at the origin.
    const farStart = createShipState({ speed, time: 90, position: far });
    const nearStart = createShipState({ speed, time: 90 });
    const farDelta = displacement(farStart, run(farStart, 0.1, 10, params));
    const nearDelta = displacement(nearStart, run(nearStart, 0.1, 10, params));
    const error = Math.hypot(
      farDelta.x - nearDelta.x,
      farDelta.y - nearDelta.y,
      farDelta.z - nearDelta.z,
    );
    expect(error / length(nearDelta)).toBeLessThan(1e-6);
  });

  it('does not modify the input state', () => {
    const params = DEFAULT_SHIP_PARAMS;
    const start = createShipState({ speed: 10, position: { x: 1, y: 2, z: 3 } });
    const snapshot = structuredClone(start);
    updateShip(start, 1 / 60, params);
    expect(start).toEqual(snapshot);
  });

  it('can write into a reused output object, including the input itself', () => {
    const params = DEFAULT_SHIP_PARAMS;
    const fresh = run(createShipState({}), 1 / 60, 120, params);
    const reused = createShipState({});
    for (let i = 0; i < 120; i++) updateShip(reused, 1 / 60, params, reused);
    expect(reused).toEqual(fresh);
  });
});
