import { AdditiveBlending, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  DT_CAP_SECONDS,
  ENCOUNTER_BASE_SEED,
  FAR_STAR_BRIGHTNESS_MAX,
  GALAXY_COUNT_WEIGHTS,
  GALAXY_MIN_SEPARATION_DEG,
  GALAXY_SIZE_MAX_DEG,
  GALAXY_SIZE_MIN_DEG,
  SHIP_SPEED_LEVELS,
  STAR_CUBE_SIZE,
} from '../config';
import { DEFAULT_AUTOPILOT_PARAMS, createTravel, setCruiseSpeed, stepTravel } from './Autopilot';
import { FAR_STARFIELD_RENDER_ORDER, FAR_STAR_NDC_DEPTH } from './FarStarfield';
import {
  DEFAULT_GALAXY_OPTIONS,
  GALAXY_SEED_INDEX,
  Galaxies,
  galaxyAxes,
  galaxyCount,
  galaxySeed,
  galaxyViewCorner,
  generateGalaxies,
  type Galaxy,
} from './Galaxies';
import { NEBULA_RENDER_ORDER } from './Nebula';
import { ATMOSPHERE_RENDER_ORDER, SURFACE_RENDER_ORDER } from './Planet';
import { hash } from './seed';
import { DEFAULT_SHIP_PARAMS, type Vec3 } from './Ship';
import { STARFIELD_RENDER_ORDER } from './Starfield';

const DEG = Math.PI / 180;

/** A camera like the engine's: at the origin, looking along `heading`, matrices up to date. */
function engineCamera(heading: Readonly<Vec3>, fov = CAMERA_FOV_DEG, aspect = 16 / 9): PerspectiveCamera {
  const camera = new PerspectiveCamera(fov, aspect, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(0, 0, 0);
  camera.lookAt(heading.x, heading.y, heading.z);
  camera.updateMatrixWorld();
  return camera;
}

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/** Every quad corner of every galaxy in view space, from the rotation-only mirror. */
function viewCorners(galaxies: readonly Galaxy[], camera: PerspectiveCamera): Vec3[] {
  return galaxies.flatMap((g) => CORNERS.map(([cx, cy]) => galaxyViewCorner(g, cx, cy, camera.matrixWorldInverse, { x: 0, y: 0, z: 0 })));
}

function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.acos(Math.min(1, dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b))));
}

/** Seeds 0..n-1 spread over the uint32 range. */
function manySeeds(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.imul(i, 0x9e3779b1) >>> 0);
}

describe('galaxy generation', () => {
  it('is deterministic from the trip seed, and the default test seed has at least one galaxy', () => {
    const a = generateGalaxies(ENCOUNTER_BASE_SEED);
    const b = generateGalaxies(ENCOUNTER_BASE_SEED);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(1);
    // The documented test default trip: a 3° tilted spiral and a small elliptical.
    expect(a.map((g) => g.type)).toEqual(['spiral', 'elliptical']);
    // Another trip seed gives other galaxies.
    expect(generateGalaxies(ENCOUNTER_BASE_SEED + 1)).not.toEqual(a);
  });

  it('takes its seed from the trip seed, apart from every encounter seed', () => {
    expect(galaxySeed(ENCOUNTER_BASE_SEED)).toBe(hash(ENCOUNTER_BASE_SEED, GALAXY_SEED_INDEX));
    const encounterSeeds = new Set(Array.from({ length: 10_000 }, (_, i) => hash(ENCOUNTER_BASE_SEED, i)));
    expect(encounterSeeds.has(galaxySeed(ENCOUNTER_BASE_SEED))).toBe(false);
  });

  it('gives each trip 0–3 galaxies, in about the configured shares', () => {
    const seeds = manySeeds(4000);
    const counts = new Array<number>(GALAXY_COUNT_WEIGHTS.length).fill(0);
    for (const seed of seeds) counts[generateGalaxies(seed).length]!++;
    expect(counts.reduce((s, c) => s + c, 0)).toBe(seeds.length);
    GALAXY_COUNT_WEIGHTS.forEach((weight, n) => expect(counts[n]! / seeds.length).toBeCloseTo(weight, 1));
    expect(GALAXY_COUNT_WEIGHTS.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
    expect(GALAXY_COUNT_WEIGHTS.length - 1).toBe(3);
    // galaxyCount gives each count a share of [0, 1) equal to its weight.
    expect(galaxyCount(0, GALAXY_COUNT_WEIGHTS)).toBe(0);
    expect(galaxyCount(0.15, GALAXY_COUNT_WEIGHTS)).toBe(1);
    expect(galaxyCount(1 - 1e-15, GALAXY_COUNT_WEIGHTS)).toBe(3);
  });

  it('keeps every galaxy tiny, faint, apart from the others and where the heading drift sweeps the view', () => {
    const galaxies = manySeeds(1000).flatMap((seed) => {
      const set = generateGalaxies(seed);
      for (let i = 0; i < set.length; i++) {
        for (let j = 0; j < i; j++) {
          expect(angleBetween(set[i]!.direction, set[j]!.direction)).toBeGreaterThanOrEqual(GALAXY_MIN_SEPARATION_DEG * DEG - 1e-12);
        }
      }
      return set;
    });
    expect(galaxies.length).toBeGreaterThan(1000);
    const types = new Set(galaxies.map((g) => g.type));
    expect(types).toEqual(new Set(['spiral', 'elliptical']));
    for (const g of galaxies) {
      const d = g.direction;
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
      // Yaw and pitch from -Z (the heading convention) within the placement ranges.
      expect(Math.abs(Math.asin(d.y))).toBeLessThanOrEqual(DEFAULT_GALAXY_OPTIONS.pitchRange + 1e-12);
      expect(Math.abs(Math.atan2(d.x, -d.z))).toBeLessThanOrEqual(DEFAULT_GALAXY_OPTIONS.yawRange + 1e-12);
      // A few degrees across at most.
      expect(g.size).toBeGreaterThanOrEqual(GALAXY_SIZE_MIN_DEG * DEG);
      expect(g.size).toBeLessThanOrEqual(GALAXY_SIZE_MAX_DEG * DEG);
      expect(GALAXY_SIZE_MAX_DEG).toBeLessThanOrEqual(4);
      expect(g.axisRatio).toBeGreaterThan(0.2);
      expect(g.axisRatio).toBeLessThanOrEqual(1);
      expect(g.winding === 0).toBe(g.type === 'elliptical');
      // Faint: core and disc together peak well below the brightest far stars.
      const peak = Math.max(...g.coreColor.map((c, i) => c + g.discColor[i]!));
      expect(peak).toBeLessThan(0.75 * FAR_STAR_BRIGHTNESS_MAX);
      expect(Math.min(...g.coreColor, ...g.discColor)).toBeGreaterThan(0);
    }
    // Seeded sizes, tilts, rotations and colours: they vary.
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    expect(spread(galaxies.map((g) => g.size))).toBeGreaterThan(1.5 * DEG);
    expect(spread(galaxies.map((g) => g.axisRatio))).toBeGreaterThan(0.5);
    expect(spread(galaxies.map((g) => g.rotation))).toBeGreaterThan(2.5);
    expect(spread(galaxies.map((g) => g.coreColor[2] / g.coreColor[0]))).toBeGreaterThan(0.15);
  });
});

describe('galaxy quads', () => {
  const galaxies = manySeeds(200).flatMap((seed) => generateGalaxies(seed));

  it('span the galaxy’s angular size in direction space, whatever the field of view', () => {
    for (const g of galaxies) {
      const { u, v } = galaxyAxes(g);
      const d = g.direction;
      // Tangent to the sphere at the direction, and perpendicular to each other.
      expect(dot(u, d)).toBeCloseTo(0, 12);
      expect(dot(v, d)).toBeCloseTo(0, 12);
      expect(dot(u, v)).toBeCloseTo(0, 12);
      // The major axis spans `size` and the minor axis `size` squashed by the tilt, as angles.
      const plus = (s: number, a: Vec3) => ({ x: d.x + s * a.x, y: d.y + s * a.y, z: d.z + s * a.z });
      expect(angleBetween(plus(1, u), plus(-1, u))).toBeCloseTo(g.size, 12);
      expect(Math.tan(angleBetween(plus(1, v), d))).toBeCloseTo(Math.tan(g.size / 2) * g.axisRatio, 12);
      // u × v points back toward the camera: the quad is a front face (counter-clockwise on screen).
      expect(dot(cross(u, v), d)).toBeLessThan(0);
    }
    // Being angles, a narrower vertical field of view (as at ultra-wide aspects) magnifies a galaxy
    // on screen exactly as it magnifies the sky: its projected height grows by tan(30°) / tan(17.5°).
    const g = galaxies[0]!;
    const ndcHeight = (camera: PerspectiveCamera) => {
      const ys = viewCorners([g], camera).map((c) => new Vector3(c.x, c.y, c.z).applyMatrix4(camera.projectionMatrix).y);
      return Math.max(...ys) - Math.min(...ys);
    };
    const wide = ndcHeight(engineCamera(g.direction, 60, 16 / 9));
    const narrow = ndcHeight(engineCamera(g.direction, 35, 32 / 9));
    expect(narrow / wide).toBeCloseTo(Math.tan(30 * DEG) / Math.tan(17.5 * DEG), 9);
  });

  it('turn with the camera rotation', () => {
    const set = generateGalaxies(ENCOUNTER_BASE_SEED);
    const a = viewCorners(set, engineCamera({ x: 0, y: 0, z: -1 }));
    const b = viewCorners(set, engineCamera({ x: Math.sin(0.05), y: 0, z: -Math.cos(0.05) }));
    for (let i = 0; i < a.length; i++) {
      const angle = angleBetween(a[i]!, b[i]!);
      expect(angle).toBeGreaterThan(0);
      expect(angle).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('do not change under pure translation of the ship', () => {
    // The engine's simulation with the heading drift off: the ship only translates, at the top speed.
    const autopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, interval: 1e9 };
    setCruiseSpeed(autopilotParams, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
    const travel = createTravel(autopilotParams, { ...DEFAULT_SHIP_PARAMS, yawAmplitude: 0, pitchAmplitude: 0 });
    for (let i = 0; i < 20; i++) stepTravel(travel, DT_CAP_SECONDS);
    const set = generateGalaxies(ENCOUNTER_BASE_SEED);
    const ship = travel.ship;
    const before = viewCorners(set, engineCamera(ship.heading));
    const start = { ...ship.position };
    for (let i = 0; i < 600; i++) stepTravel(travel, DT_CAP_SECONDS);
    expect(Math.hypot(ship.position.x - start.x, ship.position.y - start.y, ship.position.z - start.z)).toBeGreaterThan(5 * STAR_CUBE_SIZE);

    // Camera at the origin (floating origin), and a camera actually moved to the ship's position:
    // the mirror reads the rotation only, so neither moves a corner by any amount. The GPU side is
    // guarded by the shader-source check below and the pixel e2e in e2e/starfield.spec.ts.
    const translated = engineCamera(ship.heading);
    translated.position.set(ship.position.x, ship.position.y, ship.position.z);
    translated.updateMatrixWorld();
    expect(viewCorners(set, engineCamera(ship.heading))).toEqual(before);
    expect(viewCorners(set, translated)).toEqual(before);
  });
});

describe('Galaxies', () => {
  it('draws every galaxy as an instance of one quad, with no ship-dependent or time uniform', () => {
    const set = generateGalaxies(ENCOUNTER_BASE_SEED);
    const layer = new Galaxies(set);
    const geometry = layer.mesh.geometry;
    // One geometry, one material (one program) and one mesh (one draw call) for all of them.
    expect(geometry.instanceCount).toBe(set.length);
    expect(geometry.getIndex()?.count).toBe(6);
    expect(geometry.getAttribute('position').count).toBe(4);
    for (const name of ['aDirection', 'aAxisU', 'aAxisV', 'aShape', 'aCoreColor', 'aDiscColor']) {
      expect(geometry.getAttribute(name).count, name).toBe(set.length);
    }
    expect(layer.mesh.children).toHaveLength(0);
    expect(layer.mesh.frustumCulled).toBe(false);
    expect(layer.mesh.visible).toBe(true);
    expect(Object.keys(layer.uniforms)).toEqual(['uDepth']);
    const vertex = layer.mesh.material.vertexShader;
    expect(vertex).toContain('mat3(viewMatrix) * aDirection');
    expect(vertex).toContain('mat3(viewMatrix) * (aDirection + position.x * aAxisU + position.y * aAxisV)');
    for (const name of ['modelViewMatrix', 'cameraPosition', 'modelMatrix']) expect(vertex).not.toContain(name);
    layer.dispose();
  });

  it('draws with the far stars, additively and without depth writes, so planets, nebulae and the dust draw over it', () => {
    const layer = new Galaxies(generateGalaxies(ENCOUNTER_BASE_SEED));
    const material = layer.mesh.material;
    expect(layer.mesh.renderOrder).toBe(FAR_STARFIELD_RENDER_ORDER);
    for (const order of [SURFACE_RENDER_ORDER, NEBULA_RENDER_ORDER, STARFIELD_RENDER_ORDER, ATMOSPHERE_RENDER_ORDER]) {
      expect(layer.mesh.renderOrder).toBeLessThan(order);
    }
    expect(material.transparent).toBe(true);
    expect(material.blending).toBe(AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);
    expect(layer.uniforms.uDepth.value).toBe(FAR_STAR_NDC_DEPTH);
    layer.dispose();
  });

  it('is hidden, so never drawn or compiled, when the trip has no galaxy', () => {
    const empty = manySeeds(200).find((seed) => generateGalaxies(seed).length === 0);
    expect(empty).toBeDefined();
    const layer = new Galaxies(generateGalaxies(empty!));
    expect(layer.mesh.geometry.instanceCount).toBe(0);
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });
});
