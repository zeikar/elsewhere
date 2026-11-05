import { Group, Vector3, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ASTEROID_DETAIL,
  ASTEROID_ENCOUNTER_DISTANCE,
  ASTEROID_FIELD_SHARE,
  ASTEROID_MIN_PASS_DISTANCE,
  ASTEROID_MIN_SPEED,
  ASTEROID_MIN_SPEED_DISTANCE,
  ASTEROID_RANGES,
  DT_CAP_SECONDS,
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  PLANET_GAS_RANGES,
  PLANET_ICY_RADIUS,
  PLANET_MIN_PASS_DISTANCE,
  PLANET_ROCKY_RANGES,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
} from '../config';
import {
  ASTEROID_FAMILY_NAMES,
  Asteroid,
  asteroidMinClosestDistance,
  asteroidParams,
  asteroidRockPassDistances,
  rockPosition,
  type AsteroidParams,
} from './Asteroid';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  asteroidPassFactor,
  createTravel,
  setCruiseSpeed,
  stepTravel,
  type AsteroidEncounter,
  type AutopilotParams,
} from './Autopilot';
import { encounterOffset, planEncounter, type Encounter } from './encounter';
import { MIN_RELATIVE_RADIUS, irregularBodyGeometry, irregularBodyRadii, type IrregularBodyShape } from './irregularBody';
import { encounterAsteroidParams, encounterLightDirection } from './EncounterView';
import { DEFAULT_PLANET_FRAME, SURFACE_RENDER_ORDER, planetProgramMaterials } from './Planet';
import { hash, mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS, type Vec3 } from './Ship';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Distance from `p` to the segment from `a` to `b`. */
function pointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t }));
}

/** 2,000 seeded asteroids, as the engine draws them. */
const SEEDED = Array.from({ length: 2000 }, (_, i) => asteroidParams(hash(0xa57e401d, i)));

const quantile = (values: readonly number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))]!;

/**
 * The guard on the peak bearing rate, °/s (EncounterView.test.ts: 1.2 × a median planet's 4.25°/s
 * before #36), which every planet keeps to.
 */
const BEARING_GUARD_DEG_PER_S = 1.2 * 4.25;

/** The rocks' centres relative to the field centre, in world axes, as an `Asteroid` built in `frame` places them. */
function drawnRocks(params: Readonly<AsteroidParams>, frame: Readonly<Encounter>): { centre: Vec3; radius: number; mesh: Vector3 }[] {
  const asteroid = new Asteroid(params, encounterLightDirection(frame, { x: 0, y: 0, z: 0 }), frame);
  asteroid.object.updateMatrixWorld(true);
  const rocks = asteroid.rocks.map((mesh, i) => {
    const p = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
    return { centre: { x: p.x, y: p.y, z: p.z }, radius: params.rocks[i]!.radius, mesh: new Vector3().setFromMatrixScale(mesh.matrixWorld) };
  });
  asteroid.dispose();
  return rocks;
}

/** Engine-like params with every encounter a seeded asteroid, at speed level `level`. */
function asteroidsOnly(level: number, overrides: Partial<AutopilotParams> = {}): AutopilotParams {
  const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, nebulaShare: 0, asteroidShare: 1, asteroidFor: asteroidParams, ...overrides };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  return params;
}

describe('irregularBodyGeometry', () => {
  const shape: IrregularBodyShape = { seed: 0x5eed, detail: 8, axes: [1, 0.7, 0.55], lumpiness: 0.3, craterCount: 5, craterSize: [0.3, 0.75] };

  function radii(geometry: BufferGeometry): number[] {
    const position = geometry.getAttribute('position');
    return Array.from({ length: position.count }, (_, i) => Math.hypot(position.getX(i), position.getY(i), position.getZ(i)));
  }

  it('is a closed, indexed icosphere with the planet sphere attributes, its farthest vertex exactly at 1', () => {
    for (const detail of [ASTEROID_DETAIL.main, ASTEROID_DETAIL.satellite, 0]) {
      const geometry = irregularBodyGeometry({ ...shape, detail });
      const position = geometry.getAttribute('position');
      const index = geometry.getIndex()!;
      // 10 (detail + 1)² + 2 vertices and 20 (detail + 1)² triangles: no duplicates left.
      expect(position.count).toBe(10 * (detail + 1) ** 2 + 2);
      expect(index.count / 3).toBe(20 * (detail + 1) ** 2);
      expect(Object.keys(geometry.attributes).sort()).toEqual(['normal', 'position', 'uv']);
      // Closed: every edge is shared by exactly two triangles, once each way.
      const edges = new Map<string, number>();
      for (let t = 0; t < index.count; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = index.getX(t + e);
          const b = index.getX(t + ((e + 1) % 3));
          const key = `${a},${b}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      for (const [key, count] of edges) {
        const [a, b] = key.split(',');
        expect(count, key).toBe(1);
        expect(edges.get(`${b},${a}`), key).toBe(1);
      }
      // Within the unit sphere, touching it, and nowhere near the centre.
      const r = radii(geometry);
      expect(Math.max(...r)).toBeCloseTo(1, 6);
      expect(Math.min(...r)).toBeGreaterThan(0.2);
      expect(geometry.boundingSphere!.radius).toBeLessThanOrEqual(1 + 1e-6);
      // Unit vertex normals, facing outward.
      const normal = geometry.getAttribute('normal');
      for (let i = 0; i < normal.count; i++) {
        const n = { x: normal.getX(i), y: normal.getY(i), z: normal.getZ(i) };
        expect(len(n)).toBeCloseTo(1, 5);
        expect(dot(n, { x: position.getX(i), y: position.getY(i), z: position.getZ(i) })).toBeGreaterThan(0);
      }
      geometry.dispose();
    }
  });

  it('is deterministic: the same shape gives the same geometry, another seed another one', () => {
    const a = irregularBodyGeometry(shape);
    const b = irregularBodyGeometry({ ...shape });
    const c = irregularBodyGeometry({ ...shape, seed: shape.seed + 1 });
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
    expect(Array.from(a.getAttribute('normal').array)).toEqual(Array.from(b.getAttribute('normal').array));
    expect(Array.from(a.getIndex()!.array)).toEqual(Array.from(b.getIndex()!.array));
    const ra = radii(a);
    const rc = radii(c);
    expect(ra.reduce((sum, r, i) => sum + Math.abs(r - rc[i]!), 0) / ra.length).toBeGreaterThan(0.02);
    for (const g of [a, b, c]) g.dispose();
  });

  it('is irregular: elongated, lumpy and cratered, unlike a sphere or a plain ellipsoid', () => {
    const plain = irregularBodyGeometry({ ...shape, lumpiness: 0, craterCount: 0 });
    const lumpy = irregularBodyGeometry(shape);
    const sphere = irregularBodyGeometry({ ...shape, axes: [1, 1, 1], lumpiness: 0, craterCount: 0 });
    const r = { plain: radii(plain), lumpy: radii(lumpy), sphere: radii(sphere) };
    // A sphere stays a sphere; the ellipsoid spans its axes; the lumps and craters move most
    // vertices away from it.
    expect(Math.min(...r.sphere)).toBeCloseTo(1, 6);
    expect(Math.min(...r.plain)).toBeCloseTo(0.55, 2);
    const moved = r.lumpy.filter((x, i) => Math.abs(x / Math.max(...r.lumpy) - r.plain[i]!) > 0.02).length;
    expect(moved / r.lumpy.length).toBeGreaterThan(0.5);
    for (const g of [plain, lumpy, sphere]) g.dispose();
  });

  it('never folds through its centre: every seeded rock keeps each vertex at least the floor over the farthest radius', () => {
    for (const [i, params] of SEEDED.entries()) {
      for (const [j, rock] of params.rocks.entries()) {
        const label = `seed ${i}, rock ${j}`;
        const { shape } = rock;
        const [a, b, c] = shape.axes;
        const before = irregularBodyRadii(shape);
        const farthest = Math.max(...before);
        const geometry = irregularBodyGeometry(shape);
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        expect(position.count, label).toBe(before.length);
        let worst = Infinity;
        let mismatch = 0;
        let inward = 0;
        for (let v = 0; v < position.count; v++) {
          const p = { x: position.getX(v), y: position.getY(v), z: position.getZ(v) };
          const r = len(p);
          // The ellipsoid's radius along this vertex's own direction (the longest axis is 1).
          const ellipsoid = 1 / Math.hypot(p.x / r / a, p.y / r / b, p.z / r / c);
          mismatch = Math.max(mismatch, Math.abs(r - before[v]! / farthest));
          worst = Math.min(worst, r / ((ellipsoid * MIN_RELATIVE_RADIUS) / farthest));
          if (dot({ x: normal.getX(v), y: normal.getY(v), z: normal.getZ(v) }, p) <= 0) inward++;
        }
        expect(mismatch, label).toBeLessThan(1e-6);
        expect(worst, label).toBeGreaterThanOrEqual(1 - 1e-6);
        // No folded triangles: every vertex normal still faces outward.
        expect(inward, label).toBe(0);
        geometry.dispose();
      }
    }
  }, 30_000);
});

describe('asteroidParams', () => {
  it('is deterministic, and every value lies within the configured ranges', () => {
    const g = ASTEROID_RANGES;
    for (const [i, p] of SEEDED.entries()) {
      expect(asteroidParams(p.seed)).toEqual(p);
      const label = `seed ${i}`;
      expect(ASTEROID_FAMILY_NAMES, label).toContain(p.family);
      const [main, ...others] = p.rocks;
      expect(main!.offset, label).toEqual([0, 0, 0]);
      expect(main!.radius, label).toBeGreaterThanOrEqual(g.radius[0]);
      expect(main!.radius, label).toBeLessThanOrEqual(g.radius[1]);
      expect(main!.shape.detail).toBe(ASTEROID_DETAIL.main);
      if (others.length > 0) {
        expect(p.rocks.length, label).toBeGreaterThanOrEqual(g.fieldCount[0]);
        expect(p.rocks.length, label).toBeLessThanOrEqual(g.fieldCount[1]);
      }
      for (const rock of p.rocks) {
        const s = rock.shape;
        expect(s.axes[0]).toBe(1);
        expect(s.axes[1]).toBeGreaterThanOrEqual(g.axisB[0]);
        expect(s.axes[1]).toBeLessThanOrEqual(g.axisB[1]);
        expect(s.axes[2]).toBeLessThanOrEqual(s.axes[1]);
        expect(s.axes[2]).toBeGreaterThanOrEqual(g.axisC[0]);
        expect(s.lumpiness).toBeGreaterThanOrEqual(g.lumpiness[0]);
        expect(s.lumpiness).toBeLessThanOrEqual(g.lumpiness[1]);
        expect(s.craterCount).toBeGreaterThanOrEqual(g.craterCount[0]);
        expect(s.craterCount).toBeLessThanOrEqual(g.craterCount[1]);
        expect(rock.tumbleSpeed).toBeGreaterThanOrEqual(g.tumbleSpeed[0]);
        expect(rock.tumbleSpeed).toBeLessThanOrEqual(g.tumbleSpeed[1]);
        expect(len({ x: rock.tumbleAxis[0], y: rock.tumbleAxis[1], z: rock.tumbleAxis[2] })).toBeCloseTo(1, 12);
      }
      for (const rock of others) {
        expect(rock.shape.detail).toBe(ASTEROID_DETAIL.satellite);
        // Smaller than the main rock (made smaller still where it had to, to fit).
        expect(rock.radius, label).toBeLessThanOrEqual(main!.radius * g.satelliteRadius[1]);
        expect(rock.radius, label).toBeGreaterThan(main!.radius * g.satelliteRadius[0] * 0.5);
        // Within the field's box, which the minimum-speed band covers along the path.
        const reach = main!.radius * g.spread[1];
        expect(Math.abs(rock.offset[0]), label).toBeLessThanOrEqual(reach);
        expect(Math.abs(rock.offset[1]), label).toBeLessThanOrEqual(0.75 * reach);
        expect(Math.abs(rock.offset[2]), label).toBeLessThanOrEqual(0.6 * reach);
        expect(reach).toBeLessThanOrEqual(ASTEROID_MIN_SPEED_DISTANCE);
      }
      for (const [a, ra] of p.rocks.entries()) {
        // The bounding radius holds every rock.
        expect(len({ x: ra.offset[0], y: ra.offset[1], z: ra.offset[2] }) + ra.radius, label).toBeLessThanOrEqual(p.radius * (1 + 1e-12));
        // No two rocks touch.
        for (const rb of p.rocks.slice(a + 1)) {
          const gap = Math.hypot(ra.offset[0] - rb.offset[0], ra.offset[1] - rb.offset[1], ra.offset[2] - rb.offset[2]);
          expect(gap, label).toBeGreaterThanOrEqual((ra.radius + rb.radius) * 1.25 * (1 - 1e-12));
        }
      }
      expect(Math.max(...p.rocks.map((r) => len({ x: r.offset[0], y: r.offset[1], z: r.offset[2] }) + r.radius))).toBeCloseTo(p.radius, 12);
    }
  });

  it('about half are fields of 3–7 rocks of different sizes, every family occurs, and asteroids are smaller than planets', () => {
    const fields = SEEDED.filter((p) => p.rocks.length > 1);
    expect(Math.abs(fields.length / SEEDED.length - ASTEROID_FIELD_SHARE)).toBeLessThan(0.05);
    expect(new Set(fields.map((p) => p.rocks.length))).toEqual(new Set([3, 4, 5, 6, 7]));
    expect(new Set(SEEDED.map((p) => p.family))).toEqual(new Set(ASTEROID_FAMILY_NAMES));
    // Every rock is smaller than the smallest planet.
    const smallestPlanet = Math.min(PLANET_ROCKY_RANGES.radius[0], PLANET_GAS_RANGES.radius[0], PLANET_ICY_RADIUS[0]);
    expect(Math.max(...SEEDED.map((p) => p.rocks[0]!.radius))).toBeLessThan(smallestPlanet);
  });

  it('plugs into the autopilot as asteroidFor: the encounter is planned with the field radius and its own pass factor', () => {
    const params = asteroidsOnly(SHIP_DEFAULT_SPEED_LEVEL, { interval: 1 });
    const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
    while (travel.autopilot.encounter === null) stepTravel(travel, 0.1);
    const encounter = travel.autopilot.encounter as AsteroidEncounter;
    expect(encounter.kind).toBe('asteroid');
    const expected = asteroidParams(encounter.seed);
    expect(encounter.asteroid).toEqual(expected);
    expect(encounter.plan.radius).toBe(expected.radius);
    expect(encounter.plan.spawnDistance).toBe(ASTEROID_ENCOUNTER_DISTANCE);
    expect(encounter.plan.closestDistance).toBeCloseTo(expected.radius * expected.passFactor, 9);
    // The view draws exactly those parameters.
    expect(encounterAsteroidParams(encounter)).toEqual(expected);
    // A chooser with another radius gets the seeded field scaled to it, at the default k.
    const bare: AsteroidEncounter = {
      ...encounter,
      asteroid: { radius: 20 },
      plan: planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 20, ASTEROID_ENCOUNTER_DISTANCE, asteroidPassFactor({ radius: 20 }, 3), 0),
    };
    const scaled = encounterAsteroidParams(bare);
    expect(scaled.radius).toBe(20);
    expect(scaled.passFactor).toBeCloseTo(3, 12);
    expect(scaled.rocks[0]!.radius).toBeCloseTo((expected.rocks[0]!.radius * 20) / expected.radius, 12);
    expect(asteroidPassFactor({ radius: 1, passFactor: 1.1 }, 3)).toBe(1 + ENCOUNTER_CLEARANCE_MARGIN);
  });
});

describe('the camera never passes through an asteroid (docs/PLAN.md section 6, Variety)', () => {
  it('the planned path passes every rock of 2,000 seeded asteroids, as drawn, at least the minimum pass distance from its centre and clear of it, at any heading and side', () => {
    const random = mulberry32(0xc1ea7);
    const passes: number[] = [];
    const fieldClosest: number[] = [];
    let tightest = Number.POSITIVE_INFINITY;
    for (const [i, params] of SEEDED.entries()) {
      const heading = { x: random() * 2 - 1, y: (random() * 2 - 1) * 0.4, z: -0.2 - random() };
      const elevation = (random() * 2 - 1) * 0.6;
      const sideAngle = random() < 0.5 ? elevation : Math.PI - elevation;
      const k = asteroidPassFactor(params, DEFAULT_AUTOPILOT_PARAMS.asteroid.sideOffsetFactor);
      expect(k).toBe(params.passFactor);
      const plan = planEncounter({ x: 1e9 * random(), y: 0, z: 0 }, heading, params.radius, ASTEROID_ENCOUNTER_DISTANCE, k, sideAngle);
      const expected = asteroidRockPassDistances(params.rocks, plan.closestDistance);
      fieldClosest.push(plan.closestDistance);
      // The field's sphere is clear of the path by the margin, and the pass is no closer than it must be.
      expect(plan.closestDistance).toBeGreaterThanOrEqual(params.radius * (1 + ENCOUNTER_CLEARANCE_MARGIN) * (1 - 1e-12));
      expect(plan.closestDistance).toBeGreaterThanOrEqual(asteroidMinClosestDistance(params.rocks, params.radius) * (1 - 1e-12));
      for (const [j, rock] of drawnRocks(params, plan).entries()) {
        const label = `seed ${i}, rock ${j}`;
        // The rock as drawn: at its planned offset in the encounter frame, scaled by its radius.
        const planned = rockPosition(params.rocks[j]!.offset, plan, { x: 0, y: 0, z: 0 });
        expect(len(sub(rock.centre, planned)), label).toBeLessThan(1e-9);
        expect(rock.mesh.x, label).toBeCloseTo(rock.radius, 9);
        // The path, relative to the field centre: -side × closestDistance + direction × t.
        const toPath = { x: -plan.side.x * plan.closestDistance, y: -plan.side.y * plan.closestDistance, z: -plan.side.z * plan.closestDistance };
        const rel = sub(rock.centre, toPath);
        const along = dot(rel, plan.direction);
        const distance = len(sub(rel, { x: plan.direction.x * along, y: plan.direction.y * along, z: plan.direction.z * along }));
        expect(distance, label).toBeCloseTo(expected[j]!, 6);
        expect(distance, label).toBeGreaterThanOrEqual(ASTEROID_MIN_PASS_DISTANCE * (1 - 1e-9));
        expect(distance, label).toBeGreaterThanOrEqual(rock.radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
        passes.push(distance);
        tightest = Math.min(tightest, distance / ASTEROID_MIN_PASS_DISTANCE);
      }
    }
    // Not a loose bound: many rocks pass right at it. Closer than any planet: measured p10/p50/p90
    // of every rock's pass about 32/46/67, and of the field centre about 31/41/57.
    expect(tightest).toBeLessThan(1 + 1e-6);
    expect(quantile(passes, 0.5)).toBeLessThan(PLANET_MIN_PASS_DISTANCE);
    expect(quantile(fieldClosest, 0.5)).toBeLessThan(PLANET_MIN_PASS_DISTANCE);
  }, 120_000);

  it('the ship, flown frame by frame at every level, never comes within the minimum pass distance of any rock: 60 asteroid encounters', () => {
    let worst = Number.POSITIVE_INFINITY;
    let worstSurface = Number.POSITIVE_INFINITY;
    let fields = 0;
    for (let n = 0; n < 60; n++) {
      const level = n % SHIP_SPEED_LEVELS.length;
      const dt = n % 2 === 0 ? 1 / 60 : DT_CAP_SECONDS;
      const travel = createTravel(asteroidsOnly(level, { interval: 2, baseSeed: 0xf1e1d + n }), DEFAULT_SHIP_PARAMS);
      let encounter: AsteroidEncounter | null = null;
      let rocks: { centre: Vec3; radius: number }[] = [];
      const prev = { x: 0, y: 0, z: 0 };
      const now = { x: 0, y: 0, z: 0 };
      let flown = 0;
      for (let i = 0; i < 1e6; i++) {
        const before = { ...travel.ship.position };
        stepTravel(travel, dt);
        const active = travel.autopilot.encounter;
        if (encounter === null && active !== null && active.kind === 'asteroid') {
          encounter = active;
          rocks = drawnRocks(encounterAsteroidParams(active), active.plan);
          if (rocks.length > 1) fields++;
        }
        if (encounter === null) continue;
        if (active !== encounter) break;
        // The frame's segment, relative to the field centre (ship - centre).
        encounterOffset(encounter.plan, before, prev);
        encounterOffset(encounter.plan, travel.ship.position, now);
        const a = { x: -prev.x, y: -prev.y, z: -prev.z };
        const b = { x: -now.x, y: -now.y, z: -now.z };
        for (const rock of rocks) {
          const d = pointToSegment(rock.centre, a, b);
          worst = Math.min(worst, d / ASTEROID_MIN_PASS_DISTANCE);
          worstSurface = Math.min(worstSurface, d / (rock.radius * (1 + ENCOUNTER_CLEARANCE_MARGIN)));
        }
        flown++;
      }
      expect(flown, `trip ${n}`).toBeGreaterThan(100);
    }
    expect(fields).toBeGreaterThan(10);
    expect(worst).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(worstSurface).toBeGreaterThan(1);
  }, 120_000);
});

describe('asteroid flybys never whip by', () => {
  const fasterLevels = SHIP_SPEED_LEVELS.map((cruiseSpeed, level) => ({ level, cruiseSpeed })).filter(
    ({ cruiseSpeed }) => cruiseSpeed >= ENCOUNTER_ARRIVAL_SPEED,
  );

  /** The remaining distance at every step of one asteroid encounter flown at `level`, and the ship's speed at the closest approach. */
  function trace(level: number, dt: number): { remaining: number[]; speedAtClosest: number } {
    const travel = createTravel(asteroidsOnly(level, { asteroidFor: () => ({ radius: 10 }) }), DEFAULT_SHIP_PARAMS);
    const remaining: number[] = [];
    let speedAtClosest = Number.NaN;
    for (let i = 0; i < 1e7 && !(remaining.length > 0 && travel.autopilot.encounter === null); i++) {
      stepTravel(travel, dt);
      if (travel.autopilot.encounter === null) continue;
      remaining.push(travel.autopilot.remaining);
      if (Number.isNaN(speedAtClosest) && travel.autopilot.remaining <= 0) speedAtClosest = travel.ship.speed;
    }
    return { remaining, speedAtClosest };
  }

  /**
   * Peak bearing rate, °/s, of a point `lateral` from the path and `along` ahead of the field centre
   * along it, so `remaining + along` ahead of the ship.
   */
  function peakFor(remaining: readonly number[], dt: number, lateral: number, along: number): number {
    let peak = 0;
    for (let i = 1; i < remaining.length; i++) {
      const rate = Math.abs(Math.atan2(lateral, remaining[i]! + along) - Math.atan2(lateral, remaining[i - 1]! + along)) / dt;
      peak = Math.max(peak, (rate * 180) / Math.PI);
    }
    return peak;
  }

  it.each([...fasterLevels, { level: 0, cruiseSpeed: SHIP_SPEED_LEVELS[0]! }])(
    'at speed level $level ($cruiseSpeed u/s) no rock of 2,000 seeded asteroids sweeps past faster in angle than the planet guard (5.1°/s)',
    ({ level }) => {
      // As for planets (EncounterView.test.ts): the speed profile depends only on the remaining
      // distance, so one flown trace gives every rock's bearing over time: a rock `lateral` from the
      // path and `along` ahead of the field centre is at bearing atan2(lateral, remaining + along).
      const dt = 1 / 60;
      const { remaining, speedAtClosest } = trace(level, dt);
      let worst = { peak: 0, lateral: 0, along: 0, seed: 0, rock: 0 };
      for (const params of SEEDED) {
        const distances = asteroidRockPassDistances(params.rocks, params.radius * params.passFactor);
        for (const [j, rock] of params.rocks.entries()) {
          const peak = peakFor(remaining, dt, distances[j]!, rock.offset[0]);
          if (peak > worst.peak) worst = { peak, lateral: distances[j]!, along: rock.offset[0], seed: params.seed, rock: j };
        }
      }
      // Measured at the default and top levels: about 4.6°/s at most, for a rock at the minimum
      // pass distance, passed at the minimum speed (2.4 u/s over 30 units); 3.8°/s at the slowest.
      expect(worst.peak).toBeLessThanOrEqual(BEARING_GUARD_DEG_PER_S);
      expect(worst.lateral).toBeCloseTo(ASTEROID_MIN_PASS_DISTANCE, 1);
      expect(peakFor(remaining, dt, ASTEROID_MIN_PASS_DISTANCE, 0)).toBeGreaterThan(worst.peak - 0.01);
      // Every rock is passed within the minimum-speed band, at the (scaled) minimum speed.
      if (level >= SHIP_DEFAULT_SPEED_LEVEL) {
        expect(speedAtClosest).toBeGreaterThanOrEqual(ASTEROID_MIN_SPEED);
        expect(speedAtClosest).toBeLessThan(ASTEROID_MIN_SPEED * 1.05);
      }

      // Flown for real, the bearing of the worst rock's centre peaks as computed.
      const params = SEEDED.find((p) => p.seed === worst.seed)!;
      const travel = createTravel(asteroidsOnly(level, { asteroidFor: () => params }), DEFAULT_SHIP_PARAMS);
      let rock: Vec3 | null = null;
      let prev = Number.NaN;
      let peak = 0;
      let started = false;
      const rel = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 1e7; i++) {
        stepTravel(travel, dt);
        const encounter = travel.autopilot.encounter;
        if (encounter === null) {
          if (started) break;
          continue;
        }
        started = true;
        // Where the rock is drawn: its offset in the encounter frame (checked against the drawn
        // meshes above). The view draws the trip's own seed, so the chooser's rocks are placed here.
        rock ??= rockPosition(params.rocks[worst.rock]!.offset, encounter.plan, { x: 0, y: 0, z: 0 });
        encounterOffset(encounter.plan, travel.ship.position, rel);
        const to = { x: rel.x + rock.x, y: rel.y + rock.y, z: rel.z + rock.z };
        const bearing = Math.acos(Math.min(1, dot(to, encounter.plan.direction) / len(to)));
        if (!Number.isNaN(prev)) peak = Math.max(peak, ((Math.abs(bearing - prev) / dt) * 180) / Math.PI);
        prev = bearing;
      }
      expect(peak).toBeCloseTo(worst.peak, 4);
    },
    120_000,
  );
});

describe('Asteroid', () => {
  const params = SEEDED.find((p) => p.rocks.length === 7)!;

  it('draws one mesh per rock with the rocky planet surface program, at its planned place and size', () => {
    const asteroid = new Asteroid(params, { x: 1, y: 0, z: 0 }, DEFAULT_PLANET_FRAME);
    expect(asteroid.rocks).toHaveLength(7);
    expect(asteroid.object.children).toHaveLength(7);
    const [rocky] = planetProgramMaterials();
    const position = { x: 0, y: 0, z: 0 };
    for (const [i, mesh] of asteroid.rocks.entries()) {
      const rock = params.rocks[i]!;
      // The same sources and defines as the rocky planets' surface, so the same program, and drawn
      // where a rocky surface is drawn.
      expect(mesh.material.vertexShader).toBe(rocky!.vertexShader);
      expect(mesh.material.fragmentShader).toBe(rocky!.fragmentShader);
      expect(mesh.material.defines).toEqual(rocky!.defines);
      expect(mesh.material.side).toBe(rocky!.side);
      expect(mesh.material.transparent).toBe(true);
      expect(mesh.material.depthWrite).toBe(true);
      expect(mesh.renderOrder).toBe(SURFACE_RENDER_ORDER);
      // Every uniform the rocky surface reads, and the fade and light shared by all rocks.
      for (const name of ['uColor0', 'uColor3', 'uNoiseScale', 'uNoiseOffset', 'uOctaves', 'uWarp', 'uSeaLevel', 'uIceCap', 'uSpecular', 'uRelief', 'uCraters', 'uAtmosphereColor', 'uAtmosphereIntensity']) {
        expect(mesh.material.uniforms[name], name).toBeDefined();
      }
      expect(mesh.material.uniforms.uOpacity).toBe(asteroid.uniforms.uOpacity);
      expect(mesh.material.uniforms.uLightDir).toBe(asteroid.uniforms.uLightDir);
      expect(mesh.material.uniforms.uAtmosphereIntensity!.value).toBe(0);
      rockPosition(rock.offset, DEFAULT_PLANET_FRAME, position);
      expect(mesh.position.toArray()).toEqual([position.x, position.y, position.z]);
      expect(mesh.scale.toArray()).toEqual([rock.radius, rock.radius, rock.radius]);
    }
    // Each rock has its own surface.
    expect(new Set(asteroid.rocks.map((m) => (m.material.uniforms.uNoiseOffset!.value as Vector3).x)).size).toBe(7);
    // In the default frame (ahead along -Z, to the right), along is -Z, side +X and up +Y.
    expect(rockPosition([1, 2, 3], DEFAULT_PLANET_FRAME, position)).toEqual({ x: 2, y: 3, z: -1 });
    asteroid.dispose();
    rocky!.dispose();
  });

  it('tumbles each rock slowly about its own axis, its centre fixed, and fades like a planet', () => {
    const asteroid = new Asteroid(params);
    const centres = asteroid.rocks.map((m) => m.position.clone());
    const at0 = asteroid.rocks.map((m) => m.quaternion.clone());
    asteroid.update(10);
    for (const [i, mesh] of asteroid.rocks.entries()) {
      const rock = params.rocks[i]!;
      expect(mesh.position.equals(centres[i]!)).toBe(true);
      // Turned by the tumble speed × the time about the tumble axis.
      const turn = 2 * Math.acos(Math.min(1, Math.abs(at0[i]!.dot(mesh.quaternion))));
      const expected = (rock.tumbleSpeed * 10) % (2 * Math.PI);
      expect(Math.min(turn, 2 * Math.PI - turn)).toBeCloseTo(Math.min(expected, 2 * Math.PI - expected), 6);
      const axis = new Vector3(...rock.tumbleAxis).applyQuaternion(mesh.quaternion);
      expect(axis.distanceTo(new Vector3(...rock.tumbleAxis))).toBeLessThan(1e-9);
    }
    asteroid.setFade(0);
    expect(asteroid.object.visible).toBe(false);
    asteroid.setFade(0.4);
    expect(asteroid.object.visible).toBe(true);
    expect(asteroid.uniforms.uOpacity.value).toBe(0.4);
    asteroid.setFade(3);
    expect(asteroid.uniforms.uOpacity.value).toBe(1);
    asteroid.dispose();
  });

  it('dispose() frees every rock geometry and material, once, and removes the field from the scene', () => {
    const asteroid = new Asteroid(params);
    const scene = new Group();
    scene.add(asteroid.object);
    let geometries = 0;
    let materials = 0;
    for (const mesh of asteroid.rocks) {
      mesh.geometry.addEventListener('dispose', () => geometries++);
      mesh.material.addEventListener('dispose', () => materials++);
    }
    asteroid.dispose();
    asteroid.dispose();
    expect(geometries).toBe(7);
    expect(materials).toBe(7);
    expect(asteroid.object.parent).toBeNull();
    expect(scene.children).toHaveLength(0);
  });
});
