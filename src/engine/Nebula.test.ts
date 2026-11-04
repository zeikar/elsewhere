import { Quaternion, Scene, Vector3, type ShaderMaterial } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_FAR,
  DT_CAP_SECONDS,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_FLYBY_DISTANCE,
  NEBULA_DESPAWN_DISTANCE,
  NEBULA_ENCOUNTER_DISTANCE,
  NEBULA_FADE_OUT_DISTANCE,
  NEBULA_NEAR_FADE_DISTANCE,
  NEBULA_NEAR_FADE_MIN_DISTANCE,
  NEBULA_NOISE_OFFSET_RANGE,
  NEBULA_RANGES,
  NEBULA_SIDE_OFFSET_FACTOR,
  NEBULA_SLOWDOWN_DISTANCE,
  SHIP_SPEED_LEVELS,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  createTravel,
  encounterProfile,
  setCruiseSpeed,
  stepTravel,
  type AutopilotParams,
  type TravelState,
} from './Autopilot';
import { encounterOffset, planEncounter } from './encounter';
import { EncounterView, encounterNebulaParams } from './EncounterView';
import {
  DEFAULT_NEBULA_FRAME,
  NEBULA_RENDER_ORDER,
  Nebula,
  disposeNebulaGeometry,
  nebulaGeometry,
  nebulaGeometryRefs,
  nebulaLayerFade,
  nebulaLayerLayout,
  nebulaLayerPlaneDistance,
  nebulaParams,
  type NebulaParams,
} from './Nebula';
import type { Rgb } from './Planet';
import { hash } from './seed';
import { DEFAULT_SHIP_PARAMS, type Vec3 } from './Ship';
import { STARFIELD_RENDER_ORDER, Starfield } from './Starfield';

const SEEDS = Array.from({ length: 1000 }, (_, i) => hash(ENCOUNTER_BASE_SEED, i));
const CYCLE: TravelState[] = ['APPROACH', 'FLYBY', 'DEPARTURE', 'CRUISE'];

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

function expectWithin(value: number, range: readonly [number, number], label: string): void {
  expect(value, label).toBeGreaterThanOrEqual(range[0] - 1e-9);
  expect(value, label).toBeLessThanOrEqual(range[1] + 1e-9);
}

function expectRgb(rgb: Rgb, label: string): void {
  expect(rgb, label).toHaveLength(3);
  for (const c of rgb) expectWithin(c, [0, 1], label);
}

afterEach(() => {
  disposeNebulaGeometry();
  vi.restoreAllMocks();
});

describe('nebula config', () => {
  it('ranges are ordered and the encounter keeps clear of the core and inside the far plane', () => {
    for (const [key, [min, max]] of Object.entries(NEBULA_RANGES)) expect(min, key).toBeLessThanOrEqual(max);
    expect(NEBULA_RANGES.radius[0]).toBeGreaterThan(0);
    // The path passes the axis through the nebula centre at radius × k, so it stays out of the core
    // (with the clearance margin) and at least a core radius from the axis of every layer centre.
    expect(NEBULA_SIDE_OFFSET_FACTOR).toBeGreaterThanOrEqual(1 + ENCOUNTER_CLEARANCE_MARGIN);
    expect(NEBULA_SIDE_OFFSET_FACTOR - NEBULA_RANGES.layerOffset[1]).toBeGreaterThanOrEqual(1);
    // Even the smallest layer centred on the axis reaches across the path, so the ship flies
    // through faint wisps.
    expect(NEBULA_RANGES.layerSize[0]).toBeGreaterThan(NEBULA_SIDE_OFFSET_FACTOR);
    // Planned past the slowdown and the flyby threshold, so it starts at cruise speed in APPROACH.
    expect(NEBULA_ENCOUNTER_DISTANCE).toBeGreaterThanOrEqual(NEBULA_SLOWDOWN_DISTANCE);
    expect(NEBULA_ENCOUNTER_DISTANCE).toBeGreaterThan(ENCOUNTER_FLYBY_DISTANCE);
    // The farthest corner of the farthest layer stays inside the far plane at spawn.
    const r = NEBULA_RANGES.radius[1];
    const far = Math.hypot(
      NEBULA_ENCOUNTER_DISTANCE + r * NEBULA_RANGES.depthSpread[1] + r * NEBULA_RANGES.layerSize[1],
      r * (NEBULA_SIDE_OFFSET_FACTOR + NEBULA_RANGES.layerOffset[1] + NEBULA_RANGES.layerSize[1] * Math.SQRT2),
    );
    expect(far).toBeLessThan(CAMERA_FAR);
    // The encounter fades out only once every layer centre is behind the camera.
    expect(NEBULA_DESPAWN_DISTANCE - NEBULA_FADE_OUT_DISTANCE).toBeGreaterThan(0);
    expect(NEBULA_DESPAWN_DISTANCE).toBeGreaterThan(r * NEBULA_RANGES.depthSpread[1] + NEBULA_NEAR_FADE_MIN_DISTANCE);
    expect(NEBULA_NEAR_FADE_MIN_DISTANCE).toBeGreaterThan(0);
    expect(NEBULA_NEAR_FADE_DISTANCE).toBeGreaterThan(0);
  });
});

describe('nebulaParams', () => {
  it('is deterministic, and different seeds give different nebulae', () => {
    for (const seed of SEEDS.slice(0, 50)) expect(nebulaParams(seed)).toEqual(nebulaParams(seed));
    const families = new Set(SEEDS.map((s) => nebulaParams(s).family));
    expect(families.size).toBeGreaterThanOrEqual(5);
    expect(nebulaParams(SEEDS[0]!)).not.toEqual(nebulaParams(SEEDS[1]!));
  });

  it('keeps every value within the configured ranges over 1,000 seeds', () => {
    const r = NEBULA_RANGES;
    const counts = new Set<number>();
    for (const seed of SEEDS) {
      const p = nebulaParams(seed);
      const label = `seed ${seed}`;
      expect(p.seed).toBe(seed);
      expectWithin(p.radius, r.radius, `${label}: radius`);
      expectWithin(p.layers.length, r.layerCount, `${label}: layer count`);
      expect(Number.isInteger(p.layers.length)).toBe(true);
      counts.add(p.layers.length);
      expectWithin(p.noiseScale, r.noiseScale, `${label}: noiseScale`);
      expectWithin(p.octaves, r.octaves, `${label}: octaves`);
      expect(Number.isInteger(p.octaves)).toBe(true);
      expectWithin(p.warp, r.warp, `${label}: warp`);
      expectWithin(p.coverage, r.coverage, `${label}: coverage`);
      expectWithin(p.absorption, r.absorption, `${label}: absorption`);
      expectWithin(p.core, r.core, `${label}: core`);
      expectWithin(p.churn, r.churn, `${label}: churn`);
      expect(p.palette).toHaveLength(4);
      p.palette.forEach((c, i) => expectRgb(c, `${label}: palette[${i}]`));

      let prevDepth = Number.NEGATIVE_INFINITY;
      for (const [i, layer] of p.layers.entries()) {
        const l = `${label}: layer ${i}`;
        const [x, y, z] = layer.offset;
        expect(Math.hypot(x, y) / p.radius, `${l}: lateral offset`).toBeLessThanOrEqual(r.layerOffset[1] + 1e-9);
        expect(Math.abs(z) / p.radius, `${l}: depth`).toBeLessThanOrEqual(r.depthSpread[1] + 1e-9);
        // Nearest first, and never bunched up.
        expect(z, `${l}: depth order`).toBeGreaterThan(prevDepth);
        prevDepth = z;
        expectWithin(layer.halfSize / p.radius, r.layerSize, `${l}: half-size`);
        expect(Math.abs(layer.tilt[0]), `${l}: tilt x`).toBeLessThanOrEqual(r.tilt[1]);
        expect(Math.abs(layer.tilt[1]), `${l}: tilt y`).toBeLessThanOrEqual(r.tilt[1]);
        expectWithin(layer.roll, [0, 2 * Math.PI], `${l}: roll`);
        for (const o of layer.noiseOffset) expectWithin(o, NEBULA_NOISE_OFFSET_RANGE, `${l}: noise offset`);
        expectWithin(layer.intensity, [r.intensity[0] * 0.75, r.intensity[1] * 1.1], `${l}: intensity`);
        expectWithin(layer.colorShift, [0, 1], `${l}: colour shift`);
        expectWithin(layer.core, [0, p.core], `${l}: core`);
      }
    }
    // Every layer count in the range occurs.
    expect([...counts].sort()).toEqual(
      Array.from({ length: r.layerCount[1] - r.layerCount[0] + 1 }, (_, i) => r.layerCount[0] + i),
    );
  });

  it('plugs into the autopilot as nebulaFor: a nebula encounter is planned with the seeded core radius', () => {
    const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, interval: 0.5, nebulaShare: 1, nebulaFor: nebulaParams };
    const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
    for (let i = 0; i < 100 && travel.autopilot.encounter === null; i++) stepTravel(travel, 0.1);
    const encounter = travel.autopilot.encounter!;
    expect(encounter.kind).toBe('nebula');
    const expected = nebulaParams(hash(ENCOUNTER_BASE_SEED, 0));
    expect(encounter.kind === 'nebula' && encounter.nebula).toEqual(expected);
    expect(encounter.plan.radius).toBe(expected.radius);
    expect(encounter.plan.closestDistance).toBeCloseTo(expected.radius * NEBULA_SIDE_OFFSET_FACTOR, 9);
    expect(encounter.plan.spawnDistance).toBe(NEBULA_ENCOUNTER_DISTANCE);
  });
});

describe('nebulaLayerFade', () => {
  it('is 0 up to the minimum distance, 1 from the end of the fade, monotonic and continuous', () => {
    const min = NEBULA_NEAR_FADE_MIN_DISTANCE;
    const end = min + NEBULA_NEAR_FADE_DISTANCE;
    expect(nebulaLayerFade(0)).toBe(0);
    expect(nebulaLayerFade(min)).toBe(0);
    expect(nebulaLayerFade(min * 0.5)).toBe(0);
    expect(nebulaLayerFade(end)).toBe(1);
    expect(nebulaLayerFade(end * 3)).toBe(1);
    let prev = nebulaLayerFade(0);
    const step = 0.01;
    // Smoothstep's steepest slope is 1.5 / width.
    const maxStep = (1.5 / NEBULA_NEAR_FADE_DISTANCE) * step + 1e-12;
    for (let d = step; d < end + 10; d += step) {
      const f = nebulaLayerFade(d);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f - prev).toBeLessThanOrEqual(maxStep);
      prev = f;
    }
  });
});

describe('nebulaLayerLayout', () => {
  it('matches the world placement of the layer meshes, for any planned frame', () => {
    const params = nebulaParams(SEEDS[3]!);
    const plan = planEncounter({ x: 5, y: -2, z: 9 }, { x: 0.3, y: 0.2, z: -0.93 }, params.radius, 2600, 1.7, 2.1);
    const nebula = new Nebula(params, plan);
    nebula.object.position.set(100, -40, -2000);
    nebula.setScale(0.8);
    nebula.object.updateMatrixWorld(true);
    const layout = nebulaLayerLayout(params, plan);
    expect(layout).toHaveLength(params.layers.length);
    const centre = new Vector3();
    const normal = new Vector3();
    for (const [i, layer] of nebula.layers.entries()) {
      const placement = layout[i]!;
      expect(layer.placement).toEqual(placement);
      layer.mesh.matrixWorld.decompose(centre, new Quaternion(), new Vector3());
      // Centre: nebula position + scale × the layout centre.
      expect(centre.x).toBeCloseTo(100 + 0.8 * placement.center.x, 6);
      expect(centre.y).toBeCloseTo(-40 + 0.8 * placement.center.y, 6);
      expect(centre.z).toBeCloseTo(-2000 + 0.8 * placement.center.z, 6);
      // Normal: the plane's local +Z in world space.
      normal.set(0, 0, 1).transformDirection(layer.mesh.matrixWorld);
      expect(normal.x).toBeCloseTo(placement.normal.x, 9);
      expect(normal.y).toBeCloseTo(placement.normal.y, 9);
      expect(normal.z).toBeCloseTo(placement.normal.z, 9);
      expect(len(placement.normal)).toBeCloseTo(1, 12);
      // The plane faces the path, leaning at most by the tilt.
      expect(Math.acos(dot(placement.normal, plan.direction))).toBeLessThanOrEqual(
        Math.SQRT2 * NEBULA_RANGES.tilt[1] + 1e-9,
      );
      // The distance helper is the distance from the origin to the layer's plane.
      const d = nebulaLayerPlaneDistance(nebula.object.position, 0.8, placement);
      expect(d).toBeCloseTo(Math.abs(centre.dot(normal)), 6);
    }
    nebula.dispose();
  });
});

/** Every layer material of a nebula. */
function materialsOf(nebula: Nebula): ShaderMaterial[] {
  return nebula.layers.map((l) => l.mesh.material);
}

describe('Nebula', () => {
  it('builds one plane per layer, sharing one geometry and one shader', () => {
    const params = nebulaParams(SEEDS[1]!);
    const nebula = new Nebula(params);
    expect(nebula.layers).toHaveLength(params.layers.length);
    const geometry = nebulaGeometry();
    const materials = materialsOf(nebula);
    for (const [i, layer] of nebula.layers.entries()) {
      expect(layer.mesh.geometry).toBe(geometry);
      expect(layer.mesh.parent).toBe(nebula.object);
      expect(layer.mesh.scale.x).toBeCloseTo(2 * params.layers[i]!.halfSize, 9);
      expect(layer.mesh.material.fragmentShader).toBe(materials[0]!.fragmentShader);
      // The encounter fade and the churn time are shared; the near fade is per layer.
      expect(layer.mesh.material.uniforms.uOpacity).toBe(nebula.opacity);
      expect(layer.mesh.material.uniforms.uLayerFade).toBe(layer.fade);
    }
    nebula.dispose();
  });

  it('draws before the starfield, soft-blended, depth-tested and without depth writes', () => {
    const nebula = new Nebula(nebulaParams(SEEDS[2]!));
    const starfield = new Starfield();
    expect(NEBULA_RENDER_ORDER).toBeLessThan(STARFIELD_RENDER_ORDER);
    for (const layer of nebula.layers) {
      const m = layer.mesh.material;
      expect(layer.mesh.renderOrder).toBe(NEBULA_RENDER_ORDER);
      // In the transparent list, so the layers sort back to front and the additive stars draw after.
      expect(m.transparent).toBe(true);
      expect(m.depthTest).toBe(true);
      expect(m.depthWrite).toBe(false);
    }
    expect(starfield.mesh.renderOrder).toBeGreaterThan(NEBULA_RENDER_ORDER);
    starfield.dispose();
    nebula.dispose();
  });

  it('setFade hides it at 0; update sets each layer near fade from its plane distance and hides it at 0', () => {
    const params = nebulaParams(SEEDS[4]!);
    const nebula = new Nebula(params, DEFAULT_NEBULA_FRAME);
    nebula.setFade(0);
    expect(nebula.object.visible).toBe(false);
    nebula.setFade(0.3);
    expect(nebula.opacity.value).toBe(0.3);
    expect(nebula.object.visible).toBe(true);
    nebula.setFade(4);
    expect(nebula.opacity.value).toBe(1);

    // Put the camera exactly on layer 0's plane: it is hidden; far away, every layer shows.
    const first = nebula.layers[0]!.placement;
    nebula.object.position.set(-first.center.x, -first.center.y, -first.center.z);
    nebula.update(12);
    expect(nebula.layers[0]!.fade.value).toBe(0);
    expect(nebula.layers[0]!.mesh.visible).toBe(false);
    nebula.object.position.set(0, 0, -NEBULA_ENCOUNTER_DISTANCE);
    nebula.update(12);
    for (const layer of nebula.layers) {
      expect(layer.fade.value).toBe(1);
      expect(layer.mesh.visible).toBe(true);
    }
    expect(materialsOf(nebula)[0]!.uniforms.uTime!.value).toBeCloseTo(12 * params.churn, 12);
    nebula.dispose();
  });

  it('dispose() frees its materials, and only the last live nebula frees the shared plane', () => {
    const geometry = nebulaGeometry();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const keeper = new Nebula(nebulaParams(SEEDS[5]!));
    const nebula = new Nebula(nebulaParams(SEEDS[6]!));
    expect(nebulaGeometryRefs()).toBe(2);
    const scene = new Scene();
    scene.add(nebula.object);
    const spies = materialsOf(nebula).map((m) => vi.spyOn(m, 'dispose'));
    nebula.dispose();
    nebula.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(nebula.object.parent).toBeNull();
    expect(nebulaGeometryRefs()).toBe(1);
    disposeNebulaGeometry();
    expect(geometryDispose).not.toHaveBeenCalled();
    keeper.dispose();
    expect(nebulaGeometryRefs()).toBe(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(nebulaGeometry()).not.toBe(geometry);
  });
});

describe('a simulated nebula encounter', () => {
  function nebulaTravel(level: number): AutopilotParams {
    const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, interval: 1, nebulaShare: 1, nebulaFor: nebulaParams };
    setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
    return params;
  }

  const cases = [1 / 60, 1 / 120, DT_CAP_SECONDS].flatMap((dt) => SHIP_SPEED_LEVELS.map((_, level) => ({ dt, level })));

  it.each(cases)(
    'every layer fades out continuously and is 0 before the camera is within the minimum of its plane (dt $dt, level $level)',
    ({ dt, level }) => {
      const params = nebulaTravel(level);
      const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
      const scene = new Scene();
      const view = new EncounterView(scene);
      const states: TravelState[] = [];
      let nebula: Nebula | null = null;
      let prevFades: number[] = [];
      let worstStep = 0;
      let minPlaneDistance = Number.POSITIVE_INFINITY;
      let minCentreClearance = Number.POSITIVE_INFINITY;
      const hiddenClose = new Set<number>();
      const rel = { x: 0, y: 0, z: 0 };
      const centre = new Vector3();
      const normal = new Vector3();
      for (let i = 0; i < 1e6 && states.filter((s) => s === 'CRUISE').length < 1; i++) {
        const before = travel.autopilot.state;
        stepTravel(travel, dt);
        view.sync(travel.autopilot);
        const encounter = travel.autopilot.encounter;
        view.place(travel.autopilot, travel.ship, encounterProfile(params, encounter?.kind ?? 'planet'));
        if (travel.autopilot.state !== before) states.push(travel.autopilot.state);
        const current = view.getNebula();
        if (current === null || encounter === null) continue;
        if (current !== nebula) {
          nebula = current;
          prevFades = current.layers.map((l) => l.fade.value);
        }
        minCentreClearance = Math.min(minCentreClearance, len(encounterOffset(encounter.plan, travel.ship.position, rel)));
        current.object.updateMatrixWorld(true);
        for (const [j, layer] of current.layers.entries()) {
          // Measured independently of the layout maths: from the mesh's own world matrix.
          centre.setFromMatrixPosition(layer.mesh.matrixWorld);
          normal.set(0, 0, 1).transformDirection(layer.mesh.matrixWorld);
          const d = Math.abs(centre.dot(normal));
          minPlaneDistance = Math.min(minPlaneDistance, d);
          const fade = layer.fade.value;
          if (d < NEBULA_NEAR_FADE_MIN_DISTANCE) {
            expect(fade).toBe(0);
            expect(layer.mesh.visible).toBe(false);
            hiddenClose.add(j);
          }
          worstStep = Math.max(worstStep, Math.abs(fade - prevFades[j]!));
          prevFades[j] = fade;
        }
      }
      expect(states).toEqual(CYCLE);
      expect(nebula).not.toBeNull();
      // The ship flies through every layer's plane (each comes within the minimum, hidden)...
      expect(minPlaneDistance).toBeLessThan(NEBULA_NEAR_FADE_MIN_DISTANCE);
      expect([...hiddenClose].sort()).toEqual(nebula!.layers.map((_, j) => j));
      // ...and the fades change gradually: the ship covers at most speed × dt per frame, and the
      // fade's steepest slope is 1.5 / width (plus a little for the layer tilts).
      const maxSpeed = Math.max(...SHIP_SPEED_LEVELS);
      expect(worstStep).toBeLessThan(((1.5 * maxSpeed * dt) / NEBULA_NEAR_FADE_DISTANCE) * 1.1);
      expect(worstStep).toBeLessThan(0.1);
      // Clear of the nebula core: the closest approach is the planned radius × k.
      const radius = nebula!.params.radius;
      expect(minCentreClearance).toBeGreaterThanOrEqual(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
      expect(minCentreClearance).toBeCloseTo(radius * NEBULA_SIDE_OFFSET_FACTOR, 0);
      view.dispose();
      expect(nebulaGeometryRefs()).toBe(0);
    },
  );
});

describe('nebula params for an encounter', () => {
  it('a planned radius other than the seeded one scales the whole layout', () => {
    const seed = SEEDS[7]!;
    const seeded: NebulaParams = nebulaParams(seed);
    const plan = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, seeded.radius * 2);
    const scaled = encounterNebulaParams({ kind: 'nebula', index: 7, seed, nebula: { radius: plan.radius }, plan });
    expect(scaled.radius).toBe(plan.radius);
    for (const [i, layer] of scaled.layers.entries()) {
      const original = seeded.layers[i]!;
      expect(layer.halfSize).toBeCloseTo(original.halfSize * 2, 9);
      expect(layer.offset[2]).toBeCloseTo(original.offset[2] * 2, 9);
    }
    const same = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, seeded.radius);
    expect(encounterNebulaParams({ kind: 'nebula', index: 7, seed, nebula: seeded, plan: same })).toEqual(seeded);
  });
});
