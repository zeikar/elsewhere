import { describe, expect, it } from 'vitest';
import {
  CAMERA_FAR,
  DT_CAP_SECONDS,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DESPAWN_DISTANCE,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_FADE_IN_DISTANCE,
  ENCOUNTER_FADE_OUT_DISTANCE,
  ENCOUNTER_MIN_SPEED,
  ENCOUNTER_MIN_SPEED_DISTANCE,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  ENCOUNTER_SPEEDUP_DISTANCE,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
} from '../config';
import {
  DEFAULT_ENCOUNTER_PROFILE,
  encounterOffset,
  encounterOpacity,
  encounterRemaining,
  encounterScale,
  encounterTargetSpeed,
  planEncounter,
} from './encounter';
import { mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS, createShipState, headingAt, updateShip, type ShipParams, type Vec3 } from './Ship';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

/** Distance from point `p` to the line through the origin along unit `dir`. */
function distanceToLine(p: Vec3, dir: Vec3): number {
  const t = dot(p, dir);
  return Math.hypot(p.x - dir.x * t, p.y - dir.y * t, p.z - dir.z * t);
}

function randomUnit(random: () => number): Vec3 {
  const z = random() * 2 - 1;
  const a = random() * 2 * Math.PI;
  const r = Math.sqrt(1 - z * z);
  return { x: r * Math.cos(a), y: r * Math.sin(a), z };
}

/** Headings to test: the ship's drift headings, random directions, and (nearly) vertical ones. */
function testHeadings(): Vec3[] {
  const random = mulberry32(7);
  const headings: Vec3[] = [];
  for (let t = 0; t < 600; t += 13) headings.push(headingAt(t, DEFAULT_SHIP_PARAMS, { x: 0, y: 0, z: 0 }));
  for (let i = 0; i < 200; i++) headings.push(randomUnit(random));
  headings.push({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 1e-9, y: 1, z: 0 }, { x: 3, y: -4, z: 12 });
  return headings;
}

const MAX_SPEED = Math.max(...SHIP_SPEED_LEVELS);
/** Largest distance travelled in one capped frame at the top cruise speed. */
const MAX_FRAME_STEP = MAX_SPEED * DT_CAP_SECONDS;
/** Largest allowed change of opacity or scale in one such frame (docs/PLAN.md section 10: no abrupt appear/vanish). */
const FADE_EPSILON = 0.02;

describe('encounter config', () => {
  it('k leaves a clearance margin, so the path never intersects the sphere', () => {
    expect(ENCOUNTER_CLEARANCE_MARGIN).toBeGreaterThan(0);
    expect(ENCOUNTER_SIDE_OFFSET_FACTOR).toBeGreaterThan(1 + ENCOUNTER_CLEARANCE_MARGIN);
  });

  it('the distances are consistent', () => {
    expect(ENCOUNTER_DISTANCE).toBeLessThan(CAMERA_FAR);
    expect(ENCOUNTER_SLOWDOWN_DISTANCE).toBeLessThanOrEqual(ENCOUNTER_DISTANCE);
    expect(ENCOUNTER_MIN_SPEED_DISTANCE).toBeGreaterThan(0);
    expect(ENCOUNTER_SLOWDOWN_DISTANCE).toBeGreaterThan(ENCOUNTER_MIN_SPEED_DISTANCE);
    expect(ENCOUNTER_SPEEDUP_DISTANCE).toBeGreaterThan(0);
    // Fully visible and full size from before the slowest stretch until after it.
    expect(ENCOUNTER_DISTANCE - ENCOUNTER_FADE_IN_DISTANCE).toBeGreaterThanOrEqual(ENCOUNTER_MIN_SPEED_DISTANCE);
    expect(ENCOUNTER_DESPAWN_DISTANCE - ENCOUNTER_FADE_OUT_DISTANCE).toBeGreaterThanOrEqual(ENCOUNTER_MIN_SPEED_DISTANCE);
    // Planets keep their world size: no size animation while approaching.
    expect(DEFAULT_ENCOUNTER_PROFILE.spawnScale).toBe(1);
    expect(ENCOUNTER_MIN_SPEED).toBeGreaterThan(0);
    expect(ENCOUNTER_MIN_SPEED).toBeLessThan(Math.min(...SHIP_SPEED_LEVELS));
  });
});

describe('planEncounter', () => {
  it('places the centre D ahead and radius × k to the side, so the closest approach is radius × k', () => {
    const random = mulberry32(11);
    for (const heading of testHeadings()) {
      const ship = { x: (random() - 0.5) * 2000, y: (random() - 0.5) * 2000, z: (random() - 0.5) * 2000 };
      const radius = 20 + random() * 200;
      const D = 500 + random() * 3000;
      const k = 1.3 + random() * 3;
      const sideAngle = random() * 2 * Math.PI;
      const e = planEncounter(ship, heading, radius, D, k, sideAngle);
      const expected = radius * k;

      expect(e.closestDistance).toBe(expected);
      expect(len(e.direction)).toBeCloseTo(1, 12);
      expect(len(e.side)).toBeCloseTo(1, 12);
      expect(Math.abs(dot(e.side, e.direction))).toBeLessThan(1e-12);
      expect(dot(e.direction, heading) / len(heading)).toBeCloseTo(1, 12);
      expect(Math.abs(dot(e.offset, e.direction) - D) / D).toBeLessThan(1e-9);
      expect(Math.abs(distanceToLine(e.offset, e.direction) - expected) / expected).toBeLessThan(1e-9);

      const fromShip = { x: e.center.x - ship.x, y: e.center.y - ship.y, z: e.center.z - ship.z };
      expect(Math.abs(distanceToLine(fromShip, e.direction) - expected) / expected).toBeLessThan(1e-9);
    }
  });

  it('uses the configured D and k by default and puts the planet to the right of a -Z heading', () => {
    const e = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 50);
    expect(e.center.x).toBeCloseTo(50 * ENCOUNTER_SIDE_OFFSET_FACTOR, 12);
    expect(e.center.y).toBeCloseTo(0, 12);
    expect(e.center.z).toBeCloseTo(-ENCOUNTER_DISTANCE, 12);

    const up = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 50, 1000, 2, Math.PI / 2);
    expect(up.side.x).toBeCloseTo(0, 12);
    expect(up.side.y).toBeCloseTo(1, 12);
  });

  it('a ship flying the straight path never gets closer than radius × k', () => {
    const radius = 80;
    for (const heading of testHeadings().slice(0, 40)) {
      const e = planEncounter({ x: 10, y: -20, z: 30 }, heading, radius);
      let min = Infinity;
      const rel = { x: 0, y: 0, z: 0 };
      for (let d = 0; d <= ENCOUNTER_DISTANCE + ENCOUNTER_DESPAWN_DISTANCE; d += 0.5) {
        const ship = { x: 10 + e.direction.x * d, y: -20 + e.direction.y * d, z: 30 + e.direction.z * d };
        min = Math.min(min, len(encounterOffset(e, ship, rel)));
      }
      expect(min).toBeGreaterThanOrEqual(radius * ENCOUNTER_SIDE_OFFSET_FACTOR * (1 - 1e-9));
      expect(min).toBeGreaterThan(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
    }
  });

  it('rejects k ≤ 1, a non-positive radius and a zero heading', () => {
    const p = { x: 0, y: 0, z: 0 };
    const h = { x: 0, y: 0, z: -1 };
    expect(() => planEncounter(p, h, 50, 1000, 1)).toThrow(RangeError);
    expect(() => planEncounter(p, h, 0, 1000, 2)).toThrow(RangeError);
    expect(() => planEncounter(p, h, Number.NaN, 1000, 2)).toThrow(RangeError);
    expect(() => planEncounter(p, { x: 0, y: 0, z: 0 }, 50, 1000, 2)).toThrow(RangeError);
  });
});

describe('planning at large coordinates', () => {
  it('keeps planet - ship accurate to 1e-6 with ship positions around 1e12', () => {
    const origin = { x: 1e12, y: -7.3e11, z: 1.2e12 + 0.375 };
    const heading = headingAt(37, DEFAULT_SHIP_PARAMS, { x: 0, y: 0, z: 0 });
    const radius = 90;
    const e = planEncounter(origin, heading, radius);
    const rel = { x: 0, y: 0, z: 0 };

    // At the start, planet - ship is exactly the planned offset.
    encounterOffset(e, origin, rel);
    expect(len({ x: rel.x - e.offset.x, y: rel.y - e.offset.y, z: rel.z - e.offset.z })).toBeLessThan(1e-6);
    expect(Math.abs(encounterRemaining(e, origin) - ENCOUNTER_DISTANCE)).toBeLessThan(1e-6);
    expect(Math.abs(distanceToLine(rel, e.direction) - radius * ENCOUNTER_SIDE_OFFSET_FACTOR)).toBeLessThan(1e-6);

    // Ship moves by whole units, so its 1e12 coordinates stay exact and the expected offset is known.
    for (const [mx, my, mz] of [
      [12, -3, -801],
      [-45, 7, -1600],
      [300, 120, -2900],
    ] as const) {
      const ship = { x: origin.x + mx, y: origin.y + my, z: origin.z + mz };
      expect(ship.x - origin.x).toBe(mx);
      encounterOffset(e, ship, rel);
      const expected = { x: e.offset.x - mx, y: e.offset.y - my, z: e.offset.z - mz };
      expect(len({ x: rel.x - expected.x, y: rel.y - expected.y, z: rel.z - expected.z })).toBeLessThan(1e-6);
      expect(Math.abs(encounterRemaining(e, ship) - dot(expected, e.direction))).toBeLessThan(1e-6);
    }
  });
});

describe('encounterTargetSpeed', () => {
  const { minSpeedDistance: hold, slowdownDistance, speedupDistance } = DEFAULT_ENCOUNTER_PROFILE;

  it('is continuous and non-increasing while approaching, and cruise before the slowdown', () => {
    for (const cruise of SHIP_SPEED_LEVELS) {
      let prev = encounterTargetSpeed(ENCOUNTER_DISTANCE, cruise);
      expect(prev).toBe(cruise);
      for (let s = ENCOUNTER_DISTANCE; s >= 0; s -= 0.25) {
        const v = encounterTargetSpeed(s, cruise);
        expect(v).toBeLessThanOrEqual(prev);
        // Smoothstep's slope is at most 1.5 × range / width, so a 0.25 step stays well under this.
        expect(prev - v).toBeLessThan((1.5 * (cruise - ENCOUNTER_MIN_SPEED) * 0.25) / (slowdownDistance - hold) + 1e-9);
        if (s >= slowdownDistance) expect(v).toBe(cruise);
        prev = v;
      }
    }
  });

  it('has its minimum, the configured minimum speed, around the closest approach', () => {
    for (const cruise of SHIP_SPEED_LEVELS) {
      expect(encounterTargetSpeed(0, cruise)).toBe(ENCOUNTER_MIN_SPEED);
      expect(encounterTargetSpeed(hold, cruise)).toBe(ENCOUNTER_MIN_SPEED);
      expect(encounterTargetSpeed(-hold, cruise)).toBe(ENCOUNTER_MIN_SPEED);
      expect(encounterTargetSpeed(hold + 1, cruise)).toBeGreaterThan(ENCOUNTER_MIN_SPEED);
      expect(encounterTargetSpeed(-hold - 1, cruise)).toBeGreaterThan(ENCOUNTER_MIN_SPEED);
      for (let s = ENCOUNTER_DISTANCE; s >= -ENCOUNTER_DESPAWN_DISTANCE; s -= 1) {
        expect(encounterTargetSpeed(s, cruise)).toBeGreaterThanOrEqual(ENCOUNTER_MIN_SPEED);
      }
    }
  });

  it('is continuous and non-decreasing after passing, and back at cruise speed', () => {
    for (const cruise of SHIP_SPEED_LEVELS) {
      let prev = encounterTargetSpeed(0, cruise);
      for (let s = 0; s >= -ENCOUNTER_DESPAWN_DISTANCE - 500; s -= 0.25) {
        const v = encounterTargetSpeed(s, cruise);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(v - prev).toBeLessThan((1.5 * (cruise - ENCOUNTER_MIN_SPEED) * 0.25) / speedupDistance + 1e-9);
        prev = v;
      }
      expect(encounterTargetSpeed(-hold - speedupDistance, cruise)).toBe(cruise);
      expect(encounterTargetSpeed(-ENCOUNTER_DESPAWN_DISTANCE, cruise)).toBe(cruise);
    }
  });

  it('never speeds up a cruise speed below the minimum', () => {
    for (const s of [ENCOUNTER_DISTANCE, 300, 0, -300, -ENCOUNTER_DESPAWN_DISTANCE]) {
      expect(encounterTargetSpeed(s, ENCOUNTER_MIN_SPEED / 2)).toBe(ENCOUNTER_MIN_SPEED / 2);
    }
  });

  it("works with Ship's exponential speed approach: slows to near the minimum and returns to cruise", () => {
    const radius = 100;
    const steady: ShipParams = { ...DEFAULT_SHIP_PARAMS, yawAmplitude: 0, pitchAmplitude: 0 };
    for (const dt of [1 / 60, 1 / 120]) {
      for (const cruise of SHIP_SPEED_LEVELS) {
        const params: ShipParams = { ...steady, targetSpeed: cruise };
        let ship = createShipState({ speed: cruise, position: { x: 5e9, y: 0, z: -3e9 } }, params);
        const e = planEncounter(ship.position, ship.heading, radius);
        const rel = { x: 0, y: 0, z: 0 };
        let remaining = encounterRemaining(e, ship.position);
        let prevSpeed = ship.speed;
        let speedAtClosest = Number.NaN;
        let minDistance = Infinity;
        while (remaining > -ENCOUNTER_DESPAWN_DISTANCE) {
          params.targetSpeed = encounterTargetSpeed(remaining, cruise);
          ship = updateShip(ship, dt, params, ship);
          const next = encounterRemaining(e, ship.position);
          if (next > 0) expect(ship.speed).toBeLessThanOrEqual(prevSpeed + 1e-9);
          if (remaining > 0 && next <= 0) speedAtClosest = ship.speed;
          minDistance = Math.min(minDistance, len(encounterOffset(e, ship.position, rel)));
          prevSpeed = ship.speed;
          remaining = next;
        }
        // The ship lags the profile by about tau, so it reaches the closest approach a little faster.
        // Above the default cruise speed the slowdown spans fewer time constants: from the top speed,
        // with this unscaled minimum, it is still at about a quarter of the cruise speed there.
        expect(speedAtClosest).toBeGreaterThanOrEqual(ENCOUNTER_MIN_SPEED);
        expect(speedAtClosest).toBeLessThan(cruise <= SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL] ? ENCOUNTER_MIN_SPEED * 1.5 : cruise / 3);
        expect(ship.speed).toBeGreaterThan(cruise * 0.95);
        expect(minDistance).toBeGreaterThan(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
      }
    }
  });
});

describe('encounter fade', () => {
  const despawn = -ENCOUNTER_DESPAWN_DISTANCE;
  const e = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 50);

  it('records the D it was planned with as the spawn distance', () => {
    expect(e.spawnDistance).toBe(ENCOUNTER_DISTANCE);
    expect(encounterRemaining(e, { x: 0, y: 0, z: 0 })).toBeCloseTo(e.spawnDistance, 9);
  });

  it('starts at opacity 0 and at full size for a non-default D (no pop-in)', () => {
    for (const D of [1000, 1500, ENCOUNTER_DISTANCE * 2, 5000]) {
      const ship = { x: 12, y: -3, z: 40 };
      const custom = planEncounter(ship, { x: 1, y: 0.2, z: -1 }, 50, D);
      expect(custom.spawnDistance).toBe(D);
      const remaining = encounterRemaining(custom, ship);
      expect(remaining).toBeCloseTo(D, 9);
      expect(encounterOpacity(custom, D)).toBe(0);
      expect(encounterScale(custom, D)).toBe(1);
      // The first frame, at the remaining distance actually measured from the ship.
      expect(encounterOpacity(custom, remaining)).toBeLessThan(1e-12);
      // Then eases in over the fade-in distance, as with the default D.
      expect(encounterOpacity(custom, D - MAX_FRAME_STEP)).toBeLessThan(FADE_EPSILON);
      expect(encounterOpacity(custom, D - ENCOUNTER_FADE_IN_DISTANCE)).toBe(1);
    }
  });

  it('opacity is 0 at the spawn and despawn distances, and 1 around the closest approach', () => {
    expect(encounterOpacity(e, ENCOUNTER_DISTANCE)).toBe(0);
    expect(encounterOpacity(e, despawn)).toBe(0);
    expect(encounterOpacity(e, ENCOUNTER_DISTANCE + 100)).toBe(0);
    expect(encounterOpacity(e, despawn - 100)).toBe(0);
    expect(encounterOpacity(e, ENCOUNTER_DISTANCE - 1)).toBeGreaterThan(0);
    expect(encounterOpacity(e, despawn + 1)).toBeGreaterThan(0);
    for (let s = ENCOUNTER_MIN_SPEED_DISTANCE; s >= -ENCOUNTER_MIN_SPEED_DISTANCE; s -= 1) {
      expect(encounterOpacity(e, s)).toBe(1);
    }
  });

  it('the planet keeps its world size: the size scale is 1 from spawn to despawn', () => {
    // Its apparent size comes from perspective alone, for the default D and others.
    for (const D of [ENCOUNTER_DISTANCE, 1000, ENCOUNTER_DISTANCE * 2]) {
      const custom = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 50, D);
      for (let s = D + 100; s >= despawn - 100; s -= 0.5) {
        expect(encounterScale(custom, s)).toBe(1);
      }
    }
  });

  it(`changes by less than ${FADE_EPSILON} over a 0.1 s capped frame at the top speed`, () => {
    let maxOpacityStep = 0;
    let maxScaleStep = 0;
    // Every alignment of frames: offsets in 0.5-unit steps, frames of MAX_FRAME_STEP.
    for (let start = 0; start < MAX_FRAME_STEP; start += 0.5) {
      for (let s = ENCOUNTER_DISTANCE + 50 - start; s >= despawn - 50; s -= MAX_FRAME_STEP) {
        const opacity = encounterOpacity(e, s);
        const scale = encounterScale(e, s);
        const nextOpacity = encounterOpacity(e, s - MAX_FRAME_STEP);
        const nextScale = encounterScale(e, s - MAX_FRAME_STEP);
        maxOpacityStep = Math.max(maxOpacityStep, Math.abs(nextOpacity - opacity));
        maxScaleStep = Math.max(maxScaleStep, Math.abs(nextScale - scale));
        // Continuity at a fine step as well.
        expect(Math.abs(encounterOpacity(e, s - 0.01) - opacity)).toBeLessThan(1e-4);
      }
    }
    expect(maxOpacityStep).toBeGreaterThan(0);
    expect(maxOpacityStep).toBeLessThan(FADE_EPSILON);
    expect(maxScaleStep).toBeLessThan(FADE_EPSILON);
  });

  it('opacity rises monotonically while fading in and falls monotonically while fading out', () => {
    let prev = encounterOpacity(e, ENCOUNTER_DISTANCE);
    for (let s = ENCOUNTER_DISTANCE; s >= 0; s -= 1) {
      const o = encounterOpacity(e, s);
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
    for (let s = 0; s >= despawn; s -= 1) {
      const o = encounterOpacity(e, s);
      expect(o).toBeLessThanOrEqual(prev);
      prev = o;
    }
  });
});
