import { Group, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  COMET_COMA_SEGMENTS,
  COMET_ENCOUNTER_DISTANCE,
  COMET_MAX_FILL,
  COMET_MIN_PASS_DISTANCE,
  COMET_MIN_SPEED,
  COMET_NUCLEUS_DETAIL,
  COMET_PASS_EXTRA,
  COMET_RANGES,
  COMET_TAIL_SEGMENTS,
  COMET_TAIL_SIDES,
  ENCOUNTER_CLEARANCE_MARGIN,
  PLANET_MIN_PASS_DISTANCE,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
  VIEW_WIDEST_ASPECT,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  cometPassFactor,
  createTravel,
  encounterSide,
  encounterViewMargin,
  setCruiseSpeed,
  stepTravel,
  type AutopilotParams,
  type CometEncounter,
} from './Autopilot';
import {
  COMET_FAMILY_NAMES,
  Comet,
  cometBounds,
  cometGlowGeometry,
  cometLightDirection,
  cometParams,
  cometSun,
  cometTailClearance,
  cometTailPoint,
  cometTailRings,
  cometTailTangent,
  frameToWorld,
  type CometParams,
} from './Comet';
import { encounterOffset, encounterRemaining, planEncounter, type Encounter } from './encounter';
import { EncounterView, encounterCometParams } from './EncounterView';
import { ATMOSPHERE_RENDER_ORDER, DEFAULT_PLANET_FRAME, SURFACE_RENDER_ORDER, planetProgramMaterials } from './Planet';
import { cameraFovDeg, cameraFrustum } from './renderSize';
import { MIN_RELATIVE_RADIUS, irregularBodyGeometry, irregularBodyRadii } from './irregularBody';
import { hash, mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS, type Vec3 } from './Ship';

const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

/** 2,000 seeded comets, as the engine draws them. */
const SEEDED = Array.from({ length: 2000 }, (_, i) => cometParams(hash(0xc0e7_5eed, i)));

const quantile = (values: readonly number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))]!;

/** The guard on the peak bearing rate, °/s (EncounterView.test.ts: 1.2 × a median planet's 4.25°/s before #36). */
const BEARING_GUARD_DEG_PER_S = 1.2 * 4.25;

/** Engine-like params with every encounter a seeded comet, at speed level `level`. */
function cometsOnly(level: number, overrides: Partial<AutopilotParams> = {}): AutopilotParams {
  const params: AutopilotParams = {
    ...DEFAULT_AUTOPILOT_PARAMS,
    nebulaShare: 0,
    asteroidShare: 0,
    cometShare: 1,
    cometFor: cometParams,
    ...overrides,
  };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  return params;
}

/** A comet encounter planned from the origin along -Z on the seed's side, as the autopilot plans one. */
function plannedComet(params: Readonly<CometParams>, heading: Vec3 = { x: 0, y: 0, z: -1 }, origin: Vec3 = { x: 0, y: 0, z: 0 }): CometEncounter {
  const { side, sideAngle } = encounterSide(params.seed);
  const plan = planEncounter(origin, heading, params.radius, COMET_ENCOUNTER_DISTANCE, cometPassFactor(params, 4), sideAngle);
  return { kind: 'comet', index: 0, seed: params.seed, side, comet: params, plan };
}

/** The world-space position, relative to the nucleus, of an encounter-frame point. */
function toWorld(v: readonly [number, number, number], frame: Readonly<Encounter>): Vec3 {
  return frameToWorld(v, frame, { x: 0, y: 0, z: 0 });
}

describe('cometParams', () => {
  it('is deterministic, and every value lies within the configured ranges', () => {
    const g = COMET_RANGES;
    const within = (x: number, range: readonly [number, number], label: string) => {
      expect(x, label).toBeGreaterThanOrEqual(range[0] - 1e-12);
      expect(x, label).toBeLessThanOrEqual(range[1] + 1e-12);
    };
    for (const p of SEEDED.slice(0, 500)) {
      expect(cometParams(p.seed)).toEqual(p);
      const label = `seed ${p.seed}`;
      within(p.nucleus.radius, g.nucleusRadius, label);
      within(p.radius, g.comaRadius, label);
      within(p.coma.intensity, g.comaIntensity, label);
      within(p.ion.length, g.ionLength, label);
      within(p.dust.length, g.dustLength, label);
      within(p.ion.headWidth / p.radius, g.ionHeadWidth, label);
      within(p.ion.endWidth / p.radius, g.ionEndWidth, label);
      within(p.dust.headWidth / p.radius, g.dustHeadWidth, label);
      within(p.dust.endWidth / p.radius, g.dustEndWidth, label);
      within(p.dust.angle, g.dustAngle, label);
      within(p.dust.curvature, g.dustCurvature, label);
      // A family's factor is at most 1, so the brightness never exceeds its range.
      expect(p.ion.intensity, label).toBeLessThanOrEqual(g.ionIntensity[1]);
      expect(p.dust.intensity, label).toBeLessThanOrEqual(g.dustIntensity[1]);
      expect(p.ion.intensity, label).toBeGreaterThan(0);
      expect(p.dust.intensity, label).toBeGreaterThan(0);
      within(p.nucleus.shape.craterCount, g.craterCount, label);
      within(p.nucleus.tumbleSpeed, g.tumbleSpeed, label);
      expect(p.nucleus.shape.detail).toBe(COMET_NUCLEUS_DETAIL);
      // The nucleus lies well inside the coma, which bounds it.
      expect(p.nucleus.radius, label).toBeLessThan(0.25 * p.radius);
      expect(p.tails).toBe(true);
      expect(p.bounds[0]!.offset).toEqual([0, 0, 0]);
      expect(p.bounds[0]!.radius).toBeCloseTo(p.radius, 3);
    }
    expect(new Set(SEEDED.map((p) => p.family))).toEqual(new Set(COMET_FAMILY_NAMES));
    expect(new Set(SEEDED.map((p) => p.radius)).size).toBe(SEEDED.length);
  });

  it('never folds the nucleus through its centre: every vertex of 300 seeded nuclei keeps at least the soft floor over the farthest radius, with every normal facing out', () => {
    for (const [i, p] of SEEDED.slice(0, 300).entries()) {
      const label = `seed ${i}`;
      const { shape } = p.nucleus;
      const [a, b, c] = shape.axes;
      const before = irregularBodyRadii(shape);
      const farthest = Math.max(...before);
      const geometry = irregularBodyGeometry(shape);
      const position = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      expect(position.count, label).toBe(before.length);
      let worst = Infinity;
      let inward = 0;
      for (let v = 0; v < position.count; v++) {
        const q = { x: position.getX(v), y: position.getY(v), z: position.getZ(v) };
        const r = len(q);
        // The ellipsoid's radius along this vertex's own direction (the longest axis is 1).
        const ellipsoid = 1 / Math.hypot(q.x / r / a, q.y / r / b, q.z / r / c);
        worst = Math.min(worst, r / ((ellipsoid * MIN_RELATIVE_RADIUS) / farthest));
        if (normal.getX(v) * q.x + normal.getY(v) * q.y + normal.getZ(v) * q.z <= 0) inward++;
      }
      expect(worst, label).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(inward, label).toBe(0);
      geometry.dispose();
    }
  }, 30_000);

  it('passes the nucleus at the minimum pass distance or a little more, well beyond the coma', () => {
    const closest = SEEDED.map((p) => p.radius * p.passFactor);
    for (const p of SEEDED) {
      const c = p.radius * p.passFactor;
      expect(c).toBeGreaterThanOrEqual(COMET_MIN_PASS_DISTANCE * (1 - 1e-12));
      expect(c).toBeLessThanOrEqual(COMET_MIN_PASS_DISTANCE * (1 + COMET_PASS_EXTRA) * (1 + 1e-12));
      expect(p.passFactor).toBeGreaterThanOrEqual(1 + ENCOUNTER_CLEARANCE_MARGIN);
      // Planned with its own pass factor.
      expect(cometPassFactor(p, 99)).toBe(p.passFactor);
    }
    // Most pass close (u² skew): measured median about 124.
    expect(quantile(closest, 0.5)).toBeLessThan(COMET_MIN_PASS_DISTANCE * 1.2);
    expect(Math.min(...closest)).toBeGreaterThan(PLANET_MIN_PASS_DISTANCE);
  });

  it('both tails point away from the sun in the encounter frame; the ion tail is straight, the dust tail curves away from the path', () => {
    const sun = cometSun();
    expect(Math.hypot(...sun)).toBeCloseTo(1, 12);
    // Ahead of the comet, toward the path and up: the tails go back along the path and away from it.
    expect(sun[0]).toBeGreaterThan(0);
    expect(sun[1]).toBeLessThan(0);
    for (const p of SEEDED.slice(0, 500)) {
      expect(p.sun).toEqual(sun);
      for (const tail of [p.ion, p.dust]) {
        expect(tail.direction[0]).toBeCloseTo(-sun[0], 12);
        expect(tail.direction[1]).toBeCloseTo(-sun[1], 12);
        expect(tail.direction[2]).toBeCloseTo(-sun[2], 12);
        expect(Math.hypot(...tail.bend)).toBeCloseTo(1, 12);
        expect(tail.bend[0] * tail.direction[0] + tail.bend[1] * tail.direction[1] + tail.bend[2] * tail.direction[2]).toBeCloseTo(0, 12);
      }
      expect(p.ion.angle).toBe(0);
      expect(p.ion.curvature).toBe(0);
      // The dust tail's bend never leans toward the path or ahead: it never curves toward either.
      expect(p.dust.bend[1]).toBeGreaterThanOrEqual(0);
      expect(p.dust.bend[0]).toBeLessThanOrEqual(1e-12);
      // The ion tail: its axis is the anti-sun line itself.
      for (const t of [0, 0.5, 1]) {
        const a = cometTailPoint(p.ion, t);
        expect(a[0]).toBeCloseTo(-sun[0] * p.ion.length * t, 9);
        expect(a[1]).toBeCloseTo(-sun[1] * p.ion.length * t, 9);
        expect(a[2]).toBeCloseTo(-sun[2] * p.ion.length * t, 9);
      }
      // The dust tail: away from the sun at the head, then bending further away from it.
      const head = cometTailTangent(p.dust, 0);
      const end = cometTailTangent(p.dust, 1);
      const away = (v: readonly number[]) => -(v[0]! * sun[0] + v[1]! * sun[1] + v[2]! * sun[2]);
      expect(away(head)).toBeGreaterThan(Math.cos(0.4));
      expect(away(end)).toBeLessThan(away(head));
      expect(away(end)).toBeGreaterThan(0.5);
    }
  });

  it('plugs into the autopilot as cometFor: the encounter is planned with the coma radius and its own pass factor', () => {
    const travel = createTravel(cometsOnly(SHIP_DEFAULT_SPEED_LEVEL, { interval: 1 }), DEFAULT_SHIP_PARAMS);
    for (let i = 0; i < 1000 && travel.autopilot.encounter === null; i++) stepTravel(travel, 0.05);
    const encounter = travel.autopilot.encounter as CometEncounter;
    expect(encounter.kind).toBe('comet');
    const p = cometParams(encounter.seed);
    expect(encounter.comet).toEqual(p);
    expect(encounter.plan.radius).toBe(p.radius);
    expect(encounter.plan.closestDistance).toBeCloseTo(p.radius * p.passFactor, 9);
    expect(encounter.plan.spawnDistance).toBe(COMET_ENCOUNTER_DISTANCE);
    // The view draws exactly these parameters, tails and all.
    expect(encounterCometParams(encounter)).toEqual({ ...p });
  });
});

describe('the comet glow geometry', () => {
  const p = SEEDED[3]!;
  const plan = plannedComet(p).plan;

  it('is the coma sphere and two open tubes, with the planet sphere attributes, wound to face out of each piece', () => {
    const geometry = cometGlowGeometry(p, plan);
    expect(Object.keys(geometry.attributes).sort()).toEqual(['normal', 'position', 'uv']);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex()!;
    const sphere = (COMET_COMA_SEGMENTS[0] + 1) * (COMET_COMA_SEGMENTS[1] + 1);
    const tube = (COMET_TAIL_SEGMENTS + 1) * COMET_TAIL_SIDES;
    expect(position.count).toBe(sphere + 2 * tube);
    const pieces = [0, 0, 0];
    for (let i = 0; i < uv.count; i++) pieces[uv.getY(i)]!++;
    expect(pieces).toEqual([sphere, tube, tube]);
    // Every triangle faces out of its piece: away from the coma centre, or from the tail's axis.
    const v = (i: number) => new Vector3().fromBufferAttribute(position, i);
    let inward = 0;
    for (let k = 0; k < index.count; k += 3) {
      const [a, b, c] = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
      const n = v(b).sub(v(a)).cross(v(c).sub(v(a)));
      if (n.lengthSq() < 1e-12) continue;
      const piece = uv.getY(a);
      expect(uv.getY(b)).toBe(piece);
      expect(uv.getY(c)).toBe(piece);
      const centroid = v(a).add(v(b)).add(v(c)).divideScalar(3);
      let from: Vector3;
      if (piece === 0) from = new Vector3();
      else {
        const tail = piece === 1 ? p.ion : p.dust;
        const t = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
        const axis = toWorld(cometTailPoint(tail, t), plan);
        from = new Vector3(axis.x, axis.y, axis.z);
      }
      if (n.dot(centroid.sub(from)) <= 0) inward++;
    }
    expect(inward).toBe(0);
    // Unit normals pointing out of each piece.
    for (let i = 0; i < normal.count; i += 7) expect(new Vector3().fromBufferAttribute(normal, i).length()).toBeCloseTo(1, 5);
    // The tubes are the tail rings in world axes, so the bounds made from the rings hold them.
    const rings = cometTailRings(p.ion);
    const first = toWorld([rings[0]!, rings[1]!, rings[2]!], plan);
    expect(position.getX(sphere)).toBeCloseTo(first.x, 4);
    expect(position.getY(sphere)).toBeCloseTo(first.y, 4);
    expect(position.getZ(sphere)).toBeCloseTo(first.z, 4);
    geometry.dispose();
    // Without its tails, only the coma.
    const bare = cometGlowGeometry({ ...p, tails: false }, plan);
    expect(bare.getAttribute('position').count).toBe(sphere);
    bare.dispose();
  });

  it('the bounds hold every vertex of the coma, both tails and the nucleus, whatever the tumble, for 300 seeded comets', () => {
    for (const params of SEEDED.slice(0, 300)) {
      const encounter = plannedComet(params);
      const geometry = cometGlowGeometry(params, encounter.plan);
      const position = geometry.getAttribute('position');
      const bounds = params.bounds.map((b) => ({ centre: toWorld(b.offset, encounter.plan), radius: b.radius }));
      let outside = 0;
      for (let i = 0; i < position.count; i++) {
        const x = { x: position.getX(i), y: position.getY(i), z: position.getZ(i) };
        if (!bounds.some((b) => Math.hypot(x.x - b.centre.x, x.y - b.centre.y, x.z - b.centre.z) <= b.radius)) outside++;
      }
      expect(outside, `seed ${params.seed}`).toBe(0);
      geometry.dispose();
      // The nucleus's bounding radius is inside the coma's sphere.
      expect(params.nucleus.radius).toBeLessThan(params.bounds[0]!.radius);
      // One sphere for the coma, eight per tail.
      expect(params.bounds).toHaveLength(1 + 2 * Math.ceil(COMET_TAIL_SEGMENTS / 5));
    }
    expect(cometBounds(30, [])).toHaveLength(1);
  });
});

describe('the camera never passes through a comet (docs/PLAN.md section 6, Variety)', () => {
  it('for 2,000 seeded comets the path passes the nucleus at least the minimum pass distance off, outside the coma, and never meets a tail', () => {
    let nearestTail = Number.POSITIVE_INFINITY;
    let nearestRatio = Number.POSITIVE_INFINITY;
    for (const p of SEEDED) {
      const closest = p.radius * p.passFactor;
      expect(closest).toBeGreaterThanOrEqual(COMET_MIN_PASS_DISTANCE * (1 - 1e-12));
      expect(closest).toBeGreaterThan(p.radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
      for (const tail of [p.ion, p.dust]) {
        // Every vertex of the tube (and so every triangle between them) keeps away from the path, no
        // nearer than the coma's edge (the head ring is within the coma).
        const clearance = cometTailClearance(tail, closest);
        expect(clearance, `seed ${p.seed}`).toBeGreaterThanOrEqual(closest - p.radius);
        nearestTail = Math.min(nearestTail, clearance);
        nearestRatio = Math.min(nearestRatio, clearance / closest);
        // The axis itself only moves away from the path as it goes.
        let prev = 0;
        for (let i = 0; i <= 20; i++) {
          const a = cometTailPoint(tail, i / 20);
          const lateral = Math.hypot(closest + a[1], a[2]);
          expect(lateral).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = lateral;
        }
      }
    }
    // Measured: no tail vertex nearer the path than about 99 units, 0.9 of the nucleus's own distance.
    expect(nearestTail).toBeGreaterThan(90);
    expect(nearestRatio).toBeGreaterThan(0.8);
  });

  it('the ship, flown frame by frame at every level, keeps the planned distance from the nucleus and never enters the coma or a tail: 30 comet encounters', () => {
    let checked = 0;
    for (let level = 0; level < SHIP_SPEED_LEVELS.length; level++) {
      for (let n = 0; n < 10; n++) {
        const p = SEEDED[37 * n + level]!;
        // Flown past the closest approach (no view), where a comet on a wide enough screen would still be.
        const travel = createTravel(cometsOnly(level, { cometFor: () => p, interval: 1, baseSeed: 0xc0e7 + n, view: null }), DEFAULT_SHIP_PARAMS);
        let nearestNucleus = Number.POSITIVE_INFINITY;
        let nearestVertex = Number.POSITIVE_INFINITY;
        let vertices: Vec3[] = [];
        let started = false;
        const rel = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < 2e5; i++) {
          stepTravel(travel, 1 / 30);
          const encounter = travel.autopilot.encounter;
          if (encounter === null) {
            if (started) break;
            continue;
          }
          if (!started) {
            started = true;
            const geometry = cometGlowGeometry(p, encounter.plan);
            const position = geometry.getAttribute('position');
            // Every fourth vertex of the coma and the tubes: enough to see the ship keep its distance.
            vertices = Array.from({ length: Math.ceil(position.count / 4) }, (_, k) => ({ x: position.getX(4 * k), y: position.getY(4 * k), z: position.getZ(4 * k) }));
            geometry.dispose();
          }
          encounterOffset(encounter.plan, travel.ship.position, rel);
          nearestNucleus = Math.min(nearestNucleus, len(rel));
          if (i % 4 === 0) for (const v of vertices) nearestVertex = Math.min(nearestVertex, Math.hypot(rel.x + v.x, rel.y + v.y, rel.z + v.z));
        }
        const closest = p.radius * p.passFactor;
        const label = `level ${level}, seed ${p.seed}`;
        expect(nearestNucleus, label).toBeGreaterThanOrEqual(closest * (1 - 1e-6));
        expect(nearestNucleus, label).toBeLessThan(closest * 1.01);
        expect(nearestVertex, label).toBeGreaterThan(closest - p.radius);
        checked++;
      }
    }
    expect(checked).toBe(30);
  }, 60_000);

  it('the real pass, flown with the live view at every level, past the end of the encounter: the nucleus stays near the planned distance and the camera out of the coma and the tails', () => {
    // On a live screen the encounter ends once the comet is off it, short of the closest approach, and
    // the next cruise eases the heading drift back up from 0 (`cruiseDriftRate`) while the ship is
    // still short of the nucleus: the heading is no longer held all the way to the closest approach,
    // so the real pass can be a little nearer than the planned one (issue #62 removes the drift). The
    // nucleus and the tails are measured from the captured plan until the ship is a coma radius past
    // the closest approach. Measured (105 comets, 4:3 to 32:9): at level 0 the nucleus at 0.969 × the
    // planned distance at the nearest, at levels 1 and 2 at 0.990 ×; tail vertices at 0.96 × (closest
    // − coma radius) at the nearest. This set (54 comets, 6 per level and aspect): at level 0 the
    // nucleus at 0.974 ×, at levels 1 and 2 at 0.997 ×; tail vertices at 0.978 × at the nearest.
    const aspects = [4 / 3, 16 / 9, 32 / 9];
    let checked = 0;
    let endedEarly = 0;
    let worstNucleus = Number.POSITIVE_INFINITY;
    let worstVertex = Number.POSITIVE_INFINITY;
    for (let level = 0; level < SHIP_SPEED_LEVELS.length; level++) {
      for (const aspect of aspects) {
        for (let n = 0; n < 6; n++) {
          const p = SEEDED[101 * n + 7 * level + aspects.indexOf(aspect)]!;
          const view = cameraFrustum(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT);
          const travel = createTravel(cometsOnly(level, { cometFor: () => p, baseSeed: 0x9a55 + 17 * n + level, view }), DEFAULT_SHIP_PARAMS);
          let plan: Encounter | null = null;
          let vertices: Vec3[] = [];
          let ended = false;
          let remainingAtEnd = Number.NaN;
          let nearestNucleus = Number.POSITIVE_INFINITY;
          let nearestVertex = Number.POSITIVE_INFINITY;
          const rel = { x: 0, y: 0, z: 0 };
          for (let i = 0; i < 1e6; i++) {
            stepTravel(travel, 1 / 60);
            const encounter = travel.autopilot.encounter;
            if (plan === null) {
              if (encounter === null) continue;
              // A copy: the measurement goes on after the autopilot has let go of the encounter.
              plan = structuredClone(encounter.plan);
              const geometry = cometGlowGeometry(p, encounter.plan);
              const position = geometry.getAttribute('position');
              vertices = Array.from({ length: Math.ceil(position.count / 4) }, (_, k) => ({ x: position.getX(4 * k), y: position.getY(4 * k), z: position.getZ(4 * k) }));
              geometry.dispose();
            }
            const remaining = encounterRemaining(plan, travel.ship.position);
            if (!ended && encounter === null) {
              ended = true;
              remainingAtEnd = remaining;
            }
            if (remaining < -plan.radius) break;
            encounterOffset(plan, travel.ship.position, rel);
            nearestNucleus = Math.min(nearestNucleus, len(rel));
            // Every step from the end of the encounter on (and every fourth before it).
            if (ended || i % 4 === 0) for (const v of vertices) nearestVertex = Math.min(nearestVertex, Math.hypot(rel.x + v.x, rel.y + v.y, rel.z + v.z));
          }
          const closest = p.radius * p.passFactor;
          const label = `level ${level}, aspect ${aspect.toFixed(2)}, seed ${p.seed}`;
          expect(plan, label).not.toBeNull();
          expect(encounterRemaining(plan!, travel.ship.position), label).toBeLessThan(-plan!.radius);
          if (ended && remainingAtEnd > 0) endedEarly++;
          expect(nearestNucleus, label).toBeGreaterThanOrEqual(0.95 * closest);
          expect(nearestNucleus, label).toBeGreaterThan(p.radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
          expect(nearestVertex, label).toBeGreaterThan(0.9 * (closest - p.radius));
          worstNucleus = Math.min(worstNucleus, nearestNucleus / closest);
          worstVertex = Math.min(worstVertex, nearestVertex / (closest - p.radius));
          checked++;
        }
      }
    }
    expect(checked).toBe(SHIP_SPEED_LEVELS.length * aspects.length * 6);
    // Every one of them left the screen, and so ended, short of the closest approach: the case measured.
    expect(endedEarly).toBe(checked);
    expect(worstNucleus).toBeGreaterThan(0.95);
    expect(worstVertex).toBeGreaterThan(0.9);
  }, 120_000);
});

describe('comet flybys never whip by', () => {
  const levels = SHIP_SPEED_LEVELS.map((cruiseSpeed, level) => ({ level, cruiseSpeed }));

  /**
   * The remaining distance at every step of one comet encounter flown at `level`, and the ship's speed
   * at the closest approach. Flown to the despawn distance (no view): the profile any comet is flown
   * with while it is on screen.
   */
  function trace(level: number, dt: number): { remaining: number[]; speedAtClosest: number } {
    const travel = createTravel(cometsOnly(level, { cometFor: () => ({ radius: 30 }), view: null }), DEFAULT_SHIP_PARAMS);
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

  /** Peak bearing rate, °/s, of a point `lateral` from the path and `along` ahead of the nucleus along it. */
  function peakFor(remaining: readonly number[], dt: number, lateral: number, along: number): number {
    let peak = 0;
    for (let i = 1; i < remaining.length; i++) {
      const rate = Math.abs(Math.atan2(lateral, remaining[i]! + along) - Math.atan2(lateral, remaining[i - 1]! + along)) / dt;
      peak = Math.max(peak, (rate * 180) / Math.PI);
    }
    return peak;
  }

  it.each(levels)(
    'at speed level $level ($cruiseSpeed u/s) neither the nucleus nor any point of a tail of 2,000 seeded comets sweeps past faster in angle than the planet guard (5.1°/s)',
    ({ level }) => {
      // As for planets and asteroids: the speed profile depends only on the remaining distance, so
      // one flown trace gives every point's bearing over time.
      const dt = 1 / 60;
      const { remaining, speedAtClosest } = trace(level, dt);
      let worstNucleus = 0;
      let worstTail = 0;
      for (const [n, p] of SEEDED.entries()) {
        const closest = p.radius * p.passFactor;
        worstNucleus = Math.max(worstNucleus, peakFor(remaining, dt, closest, 0));
        if (n % 20 !== 0) continue;
        for (const tail of [p.ion, p.dust]) {
          for (let i = 1; i <= 10; i++) {
            const a = cometTailPoint(tail, i / 10);
            worstTail = Math.max(worstTail, peakFor(remaining, dt, Math.hypot(closest + a[1], a[2]), a[0]));
          }
        }
      }
      // Measured at the default and top levels: at most about 3.1°/s for the nucleus (passed at the
      // minimum speed, at least 110 off) and 4.3°/s for a tail (the dust tail's far end, which the ship
      // passes about 430 short of the closest approach, still slowing down, but about 500 off the
      // path); about 2.1°/s and 1.5°/s at the slowest level. So a tail sweeps past faster than the
      // nucleus; COMET_SLOWDOWN_DISTANCE is what keeps it under the guard: with a planet's (520) the
      // tails swept past at up to 7.5°/s.
      const label = JSON.stringify({ worstNucleus, worstTail });
      expect(worstNucleus, label).toBeLessThanOrEqual(BEARING_GUARD_DEG_PER_S);
      expect(worstTail, label).toBeLessThanOrEqual(BEARING_GUARD_DEG_PER_S);
      if (level >= SHIP_DEFAULT_SPEED_LEVEL) {
        expect(worstTail, label).toBeGreaterThan(worstNucleus);
        expect(speedAtClosest).toBeGreaterThanOrEqual(COMET_MIN_SPEED);
        expect(speedAtClosest).toBeLessThan(COMET_MIN_SPEED * 1.5);
      }
    },
    60_000,
  );
});

/**
 * Screen coverage and fill of a comet's glow seen from `ship` looking along -Z (the planned heading)
 * at aspect `aspect` (the vertical field of view as the engine sets it, `cameraFovDeg`): every
 * front-facing triangle of the glow mesh, clipped to the near plane and projected, rasterised at
 * the centres of a grid of about 15,000 samples. Coverage is the share of samples any glow fragment
 * covers; fill, the glow fragments per sample (what the GPU shades for it per pixel of the view).
 */
function glowCoverage(position: ArrayLike<number>, index: ArrayLike<number>, nucleus: Vec3, aspect: number): { coverage: number; fill: number } {
  const fov = (cameraFovDeg(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT) * Math.PI) / 180;
  const tanV = Math.tan(fov / 2);
  const tanH = tanV * aspect;
  const H = Math.round(Math.sqrt(15000 / aspect));
  const W = Math.round(H * aspect);
  const counts = new Uint16Array(W * H);
  const near = CAMERA_NEAR;
  const view = (i: number): [number, number, number] => [position[3 * i]! + nucleus.x, position[3 * i + 1]! + nucleus.y, position[3 * i + 2]! + nucleus.z];
  for (let k = 0; k < index.length; k += 3) {
    let poly = [view(index[k]!), view(index[k + 1]!), view(index[k + 2]!)];
    // Clip to z ≤ -near (in front of the camera).
    if (poly.every((v) => v[2] > -near)) continue;
    if (poly.some((v) => v[2] > -near)) {
      const out: [number, number, number][] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        const aIn = a[2] <= -near;
        const bIn = b[2] <= -near;
        if (aIn) out.push(a);
        if (aIn !== bIn) {
          const t = (-near - a[2]) / (b[2] - a[2]);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, -near]);
        }
      }
      poly = out;
    }
    const ndc = poly.map((v) => [v[0] / (-v[2] * tanH), v[1] / (-v[2] * tanV)] as const);
    // Front faces wind counter-clockwise on screen; the rest are culled.
    let area = 0;
    for (let i = 0; i < ndc.length; i++) {
      const a = ndc[i]!;
      const b = ndc[(i + 1) % ndc.length]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (!(area > 0)) continue;
    // Sample space: x from 0 to W, y from 0 to H (y up).
    const pts = ndc.map(([x, y]) => [((x + 1) / 2) * W, ((y + 1) / 2) * H] as const);
    for (let f = 1; f + 1 < pts.length; f++) {
      const a = pts[0]!;
      const b = pts[f]!;
      const c = pts[f + 1]!;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const e0 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
          const e1 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
          const e2 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
          if (e0 >= 0 && e1 >= 0 && e2 > 0) counts[y * W + x]!++;
        }
      }
    }
  }
  let covered = 0;
  let fragments = 0;
  for (const c of counts) {
    if (c > 0) covered++;
    fragments += c;
  }
  return { coverage: covered / counts.length, fill: fragments / counts.length };
}

describe('comet GPU cost: screen coverage and fill', () => {
  it('a unit triangle and a full-screen pair rasterise to the expected coverage', () => {
    // Two triangles covering the whole view at z = -10, front-facing; and the same wound backward.
    const z = -10;
    const h = Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180) * 10;
    const w = h * (16 / 9);
    const quad = [-w, -h, z, w, -h, z, w, h, z, -w, h, z];
    const full = glowCoverage(quad, [0, 1, 2, 0, 2, 3], { x: 0, y: 0, z: 0 }, 16 / 9);
    expect(full.coverage).toBeCloseTo(1, 2);
    expect(full.fill).toBeCloseTo(1, 2);
    expect(glowCoverage(quad, [0, 2, 1, 0, 3, 2], { x: 0, y: 0, z: 0 }, 16 / 9).coverage).toBe(0);
    // Behind the camera: nothing.
    expect(glowCoverage(quad.map((v, i) => (i % 3 === 2 ? 10 : v)), [0, 1, 2, 0, 2, 3], { x: 0, y: 0, z: 0 }, 16 / 9).coverage).toBe(0);
  });

  it('over 40 seeded comets at 4:3, 16:9 and 21:9, from the spawn to the end of the encounter, the glow never fills the view', () => {
    // docs/PLAN.md section 6, Variety: a comet's tail must never cover the view so that the scene is
    // hidden. The glow is additive, so it hides nothing behind it; this bounds how much of the view
    // it brightens and how many fragments it costs, at every moment the encounter shows it.
    const aspects = [4 / 3, 16 / 9, VIEW_WIDEST_ASPECT];
    const remainings = [2400, 2000, 1600, 1300, 1000, 800, 650, 500, 400, 320, 250, 200, 150, 100, 60, 30, 0, -30, -60, -100];
    const worst = { coverage: 0, fill: 0, at: '' };
    const atClosest = { coverage: 0, fill: 0 };
    const atSpawn = { coverage: 0 };
    const peaks: number[] = [];
    const random = mulberry32(0xc0fe);
    for (let n = 0; n < 40; n++) {
      const p = cometParams(Math.floor(random() * 2 ** 32));
      const encounter = plannedComet(p);
      const geometry = cometGlowGeometry(p, encounter.plan);
      const position = geometry.getAttribute('position').array;
      const index = geometry.getIndex()!.array;
      let peak = 0;
      for (const remaining of remainings) {
        const ship = { x: 0, y: 0, z: -(COMET_ENCOUNTER_DISTANCE - remaining) };
        const shipState = { position: ship, heading: encounter.plan.direction } as Parameters<typeof encounterViewMargin>[1];
        expect(encounterRemaining(encounter.plan, ship)).toBeCloseTo(remaining, 6);
        const nucleus = encounterOffset(encounter.plan, ship, { x: 0, y: 0, z: 0 });
        for (const aspect of aspects) {
          // Only while the encounter still shows the comet on that screen (it ends once the comet is off it).
          if (encounterViewMargin(encounter, shipState, cameraFrustum(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT)) > 0) continue;
          const { coverage, fill } = glowCoverage(position, index, nucleus, aspect);
          if (fill > worst.fill) worst.fill = fill;
          if (coverage > worst.coverage) {
            worst.coverage = coverage;
            worst.at = `seed ${p.seed}, remaining ${remaining}, aspect ${aspect.toFixed(2)}`;
          }
          if (aspect === 16 / 9) peak = Math.max(peak, coverage);
          if (remaining === 0) {
            atClosest.coverage = Math.max(atClosest.coverage, coverage);
            atClosest.fill = Math.max(atClosest.fill, fill);
          }
          if (remaining === 2400) atSpawn.coverage = Math.max(atSpawn.coverage, coverage);
        }
      }
      peaks.push(peak);
      geometry.dispose();
    }
    // Measured: coverage at most about 16% (at 21:9, 100 short of the closest approach), 12% at 16:9
    // (the median comet's peak about 8%); fill at most about 0.19; under 2% at the spawn, and nothing
    // at the closest approach.
    const label = JSON.stringify({ worst, atClosest, atSpawn, peak16x9: { p50: quantile(peaks, 0.5), max: Math.max(...peaks) } });
    expect(worst.fill, label).toBeLessThanOrEqual(COMET_MAX_FILL);
    expect(worst.coverage, label).toBeLessThan(0.25);
    expect(quantile(peaks, 0.5), label).toBeLessThan(0.12);
    expect(atSpawn.coverage, label).toBeLessThan(0.02);
    expect(atClosest.coverage, label).toBeLessThan(0.01);
    expect(atClosest.fill, label).toBeLessThan(0.01);
  }, 120_000);
});

describe('Comet', () => {
  const p = SEEDED[11]!;

  it('draws the nucleus with the rocky surface program and the glow with the halo program, sharing one fade and one light', () => {
    const encounter = plannedComet(p);
    const comet = new Comet(p, encounter.plan);
    expect(comet.object.children).toEqual([comet.nucleus, comet.glow]);
    const [rocky, , halo] = planetProgramMaterials();
    for (const [mesh, program] of [
      [comet.nucleus, rocky!],
      [comet.glow, halo!],
    ] as const) {
      expect(mesh.material.vertexShader).toBe(program.vertexShader);
      expect(mesh.material.fragmentShader).toBe(program.fragmentShader);
      expect(mesh.material.defines).toEqual(program.defines);
      expect(mesh.material.side).toBe(program.side);
      expect(mesh.material.uniforms.uOpacity).toBe(comet.uniforms.uOpacity);
      expect(mesh.material.uniforms.uLightDir).toBe(comet.uniforms.uLightDir);
    }
    expect(comet.nucleus.renderOrder).toBe(SURFACE_RENDER_ORDER);
    expect(comet.nucleus.material.depthWrite).toBe(true);
    expect(comet.glow.renderOrder).toBe(ATMOSPHERE_RENDER_ORDER);
    expect(comet.glow.material.depthWrite).toBe(false);
    expect(comet.glow.material.uniforms.uRing!.value).toBe(2);
    expect(comet.nucleus.scale.x).toBe(p.nucleus.radius);
    // The light is the comet's sun in this encounter's frame, and the tails point straight away from it.
    const light = cometLightDirection(encounter.plan, { x: 0, y: 0, z: 0 });
    expect(comet.uniforms.uLightDir.value.distanceTo(new Vector3(light.x, light.y, light.z))).toBeLessThan(1e-9);
    for (const direction of [comet.tailDirections.ion, comet.tailDirections.dust]) {
      expect(direction.dot(comet.uniforms.uLightDir.value)).toBeCloseTo(-1, 9);
    }
    expect((comet.glow.material.uniforms.uIonDir!.value as Vector3).dot(comet.uniforms.uLightDir.value)).toBeCloseTo(-1, 9);
    expect((comet.glow.material.uniforms.uDustDir!.value as Vector3).dot(comet.uniforms.uLightDir.value)).toBeCloseTo(-1, 9);
    // In the default frame (along -Z, to the right): the sun is ahead (-Z), toward the path (-X) and up.
    const sun = cometLightDirection(DEFAULT_PLANET_FRAME, { x: 0, y: 0, z: 0 });
    expect(sun.z).toBeLessThan(0);
    expect(sun.x).toBeLessThan(0);
    expect(sun.y).toBeGreaterThan(0);
    comet.dispose();
    for (const m of planetProgramMaterials()) m.dispose();
  });

  it('tumbles the nucleus slowly about its axis, and fades nucleus and glow together', () => {
    const comet = new Comet(p);
    const at0 = comet.nucleus.quaternion.clone();
    comet.update(10);
    const turn = 2 * Math.acos(Math.min(1, Math.abs(at0.dot(comet.nucleus.quaternion))));
    const expected = (p.nucleus.tumbleSpeed * 10) % (2 * Math.PI);
    expect(Math.min(turn, 2 * Math.PI - turn)).toBeCloseTo(Math.min(expected, 2 * Math.PI - expected), 6);
    comet.setFade(0);
    expect(comet.object.visible).toBe(false);
    comet.setFade(0.4);
    expect(comet.object.visible).toBe(true);
    expect(comet.nucleus.material.uniforms.uOpacity!.value).toBe(0.4);
    expect(comet.glow.material.uniforms.uOpacity!.value).toBe(0.4);
    comet.setFade(3);
    expect(comet.uniforms.uOpacity.value).toBe(1);
    comet.dispose();
  });

  it('fades in and out with the encounter opacity in the encounter view, and frees both meshes', () => {
    const scene = new Scene();
    const view = new EncounterView(scene);
    const travel = createTravel(cometsOnly(SHIP_SPEED_LEVELS.length - 1, { interval: 1 }), DEFAULT_SHIP_PARAMS);
    let comet: Comet | null = null;
    let first = Number.NaN;
    let peak = 0;
    let frames = 0;
    let geometries = 0;
    let materials = 0;
    for (let i = 0; i < 1e5; i++) {
      stepTravel(travel, 1 / 20);
      view.sync(travel.autopilot);
      const encounter = travel.autopilot.encounter;
      if (encounter !== null) view.place(travel.autopilot, travel.ship, travel.autopilotParams.comet.profile);
      const current = view.getComet();
      if (current !== null && comet === null) {
        comet = current;
        for (const mesh of [current.nucleus, current.glow]) {
          mesh.geometry.addEventListener('dispose', () => geometries++);
          mesh.material.addEventListener('dispose', () => materials++);
        }
      }
      if (current !== null) {
        frames++;
        // The glow and the nucleus follow the autopilot's fade exactly.
        expect(current.glow.material.uniforms.uOpacity!.value).toBe(travel.autopilot.fade);
        expect(current.nucleus.material.uniforms.uOpacity!.value).toBe(travel.autopilot.fade);
        if (Number.isNaN(first)) first = travel.autopilot.fade;
        peak = Math.max(peak, travel.autopilot.fade);
      }
      if (comet !== null && encounter === null) break;
    }
    expect(comet).not.toBeNull();
    expect(frames).toBeGreaterThan(100);
    expect(first).toBeLessThan(0.01);
    expect(peak).toBe(1);
    // Freed when the encounter ends: both geometries and both materials, and nothing left in the scene.
    expect(view.getObject()).toBeNull();
    expect(geometries).toBe(2);
    expect(materials).toBe(2);
    expect(scene.children).toHaveLength(0);
    view.dispose();
  });

  it('dispose() frees both geometries and materials, once, and removes the comet from the scene', () => {
    const comet = new Comet(p);
    const scene = new Group();
    scene.add(comet.object);
    let geometries = 0;
    let materials = 0;
    for (const mesh of [comet.nucleus, comet.glow]) {
      mesh.geometry.addEventListener('dispose', () => geometries++);
      mesh.material.addEventListener('dispose', () => materials++);
    }
    comet.dispose();
    comet.dispose();
    expect(geometries).toBe(2);
    expect(materials).toBe(2);
    expect(scene.children).toHaveLength(0);
  });

  it('a comet whose spec does not bound its tails is drawn without them, at the planned radius', () => {
    const encounter: CometEncounter = { ...plannedComet(p), comet: { radius: 50 } };
    encounter.plan = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 50, COMET_ENCOUNTER_DISTANCE, 4, 0);
    const drawn = encounterCometParams(encounter);
    expect(drawn.tails).toBe(false);
    expect(drawn.radius).toBe(50);
    expect(drawn.passFactor).toBe(4);
    expect(drawn.nucleus.radius).toBeCloseTo((p.nucleus.radius * 50) / p.radius, 9);
    const comet = new Comet(drawn, encounter.plan);
    expect(comet.glow.geometry.getAttribute('position').count).toBe((COMET_COMA_SEGMENTS[0] + 1) * (COMET_COMA_SEGMENTS[1] + 1));
    comet.dispose();
    // Without bounds the out-of-view test uses the coma's sphere.
    const ship = { position: { x: 0, y: 0, z: 0 }, heading: { x: 0, y: 0, z: -1 } } as Parameters<typeof encounterViewMargin>[1];
    expect(encounterViewMargin(encounter, ship, DEFAULT_AUTOPILOT_PARAMS.view)).toBeLessThan(0);
  });
});
