import { describe, expect, it } from 'vitest';
import { DT_CAP_SECONDS, SHIP_MAX_TURN_RATE_RAD_PER_S } from '../config';
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

function angleBetween(a: Vec3, b: Vec3): number {
  const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (length(a) * length(b));
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

describe('clampDt', () => {
  it('caps dt at 0.1 s', () => {
    expect(DT_CAP_SECONDS).toBe(0.1);
    expect(clampDt(5)).toBe(0.1);
    expect(clampDt(0.1)).toBe(0.1);
    expect(clampDt(1 / 60)).toBe(1 / 60);
  });

  it('turns negative and non-finite dt into 0', () => {
    expect(clampDt(-1)).toBe(0);
    expect(clampDt(Number.NaN)).toBe(0);
    expect(clampDt(Number.POSITIVE_INFINITY)).toBe(0.1);
  });
});

describe('updateShip', () => {
  // Section 10: refresh-rate independence. Stated tolerance: 0.5% relative, as the issue suggests;
  // the analytic integration actually agrees to rounding error.
  const REFRESH_TOLERANCE = 0.005;

  it.each([
    { label: 'converging from rest', speed: 0 },
    { label: 'converging from above', speed: 140 },
    { label: 'already at target', speed: 60 },
  ])('travels the same distance at 60 Hz and 120 Hz ($label)', ({ speed }) => {
    const params: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: 60, speedTau: 2 };
    const start = createShipState({ speed, time: 37 }, params);

    const at60 = run(start, 1 / 60, 60, params);
    const at120 = run(start, 1 / 120, 120, params);

    if (speed !== 60) {
      // Still converging after 1 s, so the speed is not yet at the target.
      expect(Math.abs(at60.speed - 60)).toBeGreaterThan(1);
    }
    expect(at60.distance).toBeGreaterThan(0);
    expect(Math.abs(at60.distance - at120.distance) / at60.distance).toBeLessThan(
      REFRESH_TOLERANCE,
    );
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
    const cruising = createShipState({ speed: 100 }, params);
    const next = updateShip(cruising, 5, params);
    expect(next.time).toBeCloseTo(0.1, 12);
    expect(next.distance).toBeCloseTo(100 * 0.1, 9);
    expect(length(next.position)).toBeLessThanOrEqual(100 * 0.1 + 1e-9);

    // Decelerating from a higher speed: still bounded by the starting speed × 0.1 s.
    const fast = createShipState({ speed: 150 }, params);
    const slowed = updateShip(fast, 5, params);
    expect(slowed.distance).toBeLessThanOrEqual(150 * 0.1);
  });

  it.each([
    { label: 'acceleration', from: 0, to: 150 },
    { label: 'deceleration', from: 150, to: 20 },
  ])('approaches the target speed monotonically without overshoot ($label)', ({ from, to }) => {
    const params: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: to, speedTau: 2 };
    let s = createShipState({ speed: from }, params);
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

  it('drifts the heading smoothly over simulated minutes, keeping it a unit vector', () => {
    const params = DEFAULT_SHIP_PARAMS;
    let s = createShipState({ speed: params.targetSpeed }, params);
    const initial = { ...s.heading };
    let lastSecond = { ...s.heading };
    let maxTurn = 0;
    let maxDeviation = 0;
    const fps = 60;
    for (let second = 1; second <= 10 * 60; second++) {
      for (let f = 0; f < fps; f++) {
        s = updateShip(s, 1 / fps, params);
        expect(Math.abs(length(s.heading) - 1)).toBeLessThan(1e-12);
      }
      maxTurn = Math.max(maxTurn, angleBetween(lastSecond, s.heading));
      maxDeviation = Math.max(maxDeviation, angleBetween(initial, s.heading));
      lastSecond = { ...s.heading };
    }
    expect(maxDeviation).toBeGreaterThan(0.2);
    expect(maxTurn).toBeGreaterThan(0);
    expect(maxTurn).toBeLessThan(SHIP_MAX_TURN_RATE_RAD_PER_S);
  });

  it('exposes velocity as heading × speed', () => {
    const params = DEFAULT_SHIP_PARAMS;
    const s = run(createShipState({}, params), 1 / 60, 500, params);
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

    // Straight line (drift off), so the 1 s path length equals the size of the position delta.
    // A single 1 s step would be clamped to 0.1 s, so 1 s is ten 0.1 s steps.
    const straight: ShipParams = {
      ...DEFAULT_SHIP_PARAMS,
      targetSpeed: speed,
      yawAmplitude: 0,
      pitchAmplitude: 0,
    };
    const start = createShipState({ speed, position: far }, straight);
    const delta = length(displacement(start, run(start, 0.1, 10, straight)));
    expect(Math.abs(delta - speed * 1) / (speed * 1)).toBeLessThan(1e-6);

    // With drift on, the delta far away matches the same journey started at the origin.
    const drifting: ShipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: speed };
    const farStart = createShipState({ speed, time: 90, position: far }, drifting);
    const nearStart = createShipState({ speed, time: 90 }, drifting);
    const farDelta = displacement(farStart, run(farStart, 0.1, 10, drifting));
    const nearDelta = displacement(nearStart, run(nearStart, 0.1, 10, drifting));
    const error = Math.hypot(
      farDelta.x - nearDelta.x,
      farDelta.y - nearDelta.y,
      farDelta.z - nearDelta.z,
    );
    expect(error / length(nearDelta)).toBeLessThan(1e-6);
  });

  it('does not modify the input state', () => {
    const params = DEFAULT_SHIP_PARAMS;
    const start = createShipState({ speed: 10, position: { x: 1, y: 2, z: 3 } }, params);
    const snapshot = structuredClone(start);
    updateShip(start, 1 / 60, params);
    expect(start).toEqual(snapshot);
  });

  it('can write into a reused output object, including the input itself', () => {
    const params = DEFAULT_SHIP_PARAMS;
    const fresh = run(createShipState({}, params), 1 / 60, 120, params);
    const reused = createShipState({}, params);
    for (let i = 0; i < 120; i++) updateShip(reused, 1 / 60, params, reused);
    expect(reused).toEqual(fresh);
  });
});
