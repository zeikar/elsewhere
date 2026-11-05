/**
 * Asteroids (docs/PLAN.md section 6, Variety, and section 9, Phase 4): a close pass by something
 * small and irregular, one rock or a small field of them.
 *
 * - `asteroidParams(seed)` is pure: it derives the family, the rocks (sizes, shapes, tumble and
 *   layout), the surface shading and the pass factor `k` from an encounter's appearance seed. Its
 *   result is an `AsteroidSpec` (the field's bounding `radius` and `passFactor`), so it can be passed
 *   straight to `AutopilotParams.asteroidFor`.
 * - The rocks are laid out in the encounter's own frame (along the planned path, toward the side the
 *   field sits on, and up), so the plan knows each rock's distance from the path: the pass factor
 *   keeps the path out of the field's bounding sphere (`radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`)
 *   and every rock's centre at least ASTEROID_MIN_PASS_DISTANCE from it (`asteroidRockPassDistances`).
 * - Each rock is an irregular body (`irregularBodyGeometry` in irregularBody.ts, which comet nuclei
 *   share): a seeded, lumpy, cratered low-poly ellipsoid whose farthest vertex is at exactly 1.
 * - `Asteroid` builds the meshes: one per rock, each with its own geometry and material, all freed in
 *   `dispose()`. Every rock is shaded with the rocky planet surface program (`rockySurfaceMaterial`
 *   in Planet.ts: fBm terrain, small craters and bump shading, no sea, ice or atmosphere), so
 *   asteroids add no shader program, and ProgramWarmup's rocky holder keeps theirs compiled. Each
 *   rock tumbles slowly about a seeded axis; its centre never moves, so its bounding sphere holds it
 *   whatever the tumble.
 * - Draw order and depth are the rocky planet surface's (SURFACE_RENDER_ORDER, see Planet.ts):
 *   after the far stars, before the near starfield, writing depth, so the near stars behind a rock
 *   are hidden and those in front of it still show.
 *
 * Positions are relative to the ship (floating origin): the caller sets `object.position` to
 * `field centre - ship position`, computed in float64 on the CPU.
 */
import { Color, Group, Mesh, SRGBColorSpace, Vector3, type BufferGeometry, type ShaderMaterial } from 'three';
import {
  ASTEROID_DETAIL,
  ASTEROID_FIELD_SHARE,
  ASTEROID_MIN_PASS_DISTANCE,
  ASTEROID_PASS_EXTRA,
  ASTEROID_RANGES,
  ENCOUNTER_CLEARANCE_MARGIN,
  PLANET_LIGHT_DIRECTION,
  PLANET_NOISE_OFFSET_RANGE,
} from '../config';
import type { AsteroidSpec } from './Autopilot';
import { irregularBodyGeometry, randomUnit, type IrregularBodyShape } from './irregularBody';
import { DEFAULT_PLANET_FRAME, SURFACE_RENDER_ORDER, jitterPalette, rockySurfaceMaterial, type PlanetFrame, type Rgb } from './Planet';
import { hash, mulberry32 } from './seed';
import type { Vec3 } from './Ship';

// ---------------------------------------------------------------------------------------------
// Seeded parameters (pure)
// ---------------------------------------------------------------------------------------------

/** One rock of an asteroid encounter. */
export interface AsteroidRock {
  /**
   * Centre relative to the field centre, in world units, in the encounter's frame: along the planned
   * path (positive ahead), toward the side the field sits on (away from the path), and up
   * (`side × direction`).
   */
  offset: readonly [number, number, number];
  /** Bounding radius in world units: every vertex lies within it, whatever the tumble. */
  radius: number;
  /** The rock's shape (`irregularBodyGeometry`). */
  shape: IrregularBodyShape;
  /** Unit tumble axis, in world space. */
  tumbleAxis: readonly [number, number, number];
  /** Tumble speed, in radians per second, and the starting angle, in radians. */
  tumbleSpeed: number;
  tumblePhase: number;
  /** Offset into the surface noise, so every rock of a field has its own surface. */
  noiseOffset: readonly [number, number, number];
}

export interface AsteroidParams extends AsteroidSpec {
  /** The appearance seed these parameters were drawn from. */
  seed: number;
  /** Name of the family the colours were drawn from (for example `carbonaceous`). */
  family: string;
  /** Bounding radius of the whole field about its centre: every rock lies within it. */
  radius: number;
  /** `k`: the encounter passes the field centre at `radius × k` (see the module comment). */
  passFactor: number;
  /** The rocks, the main rock first (at the field centre). One rock, or a field of several. */
  rocks: readonly AsteroidRock[];
  /** Four surface colours (sRGB), as for a rocky planet: unused (no sea), lowland, upland, highland. */
  palette: readonly [Rgb, Rgb, Rgb, Rgb];
  /** Surface shading, as for a rocky planet (PLANET_ROCKY_RANGES): the terrain noise and the small craters. */
  noiseScale: number;
  octaves: number;
  warp: number;
  relief: number;
  craters: number;
}

/** Asteroid families, picked evenly. Palettes as a rocky planet's (the first, the sea, is unused). */
const ASTEROID_FAMILIES: readonly { name: string; palette: readonly [number, number, number, number] }[] = [
  // C-type: dark, sooty grey-brown.
  { name: 'carbonaceous', palette: [0x2a2724, 0x4a4540, 0x6c665e, 0x948c81] },
  // S-type: stony, tan and ochre.
  { name: 'stony', palette: [0x3a2e22, 0x6e5c46, 0x9c8463, 0xc9b190] },
  // M-type: metallic blue-grey.
  { name: 'metallic', palette: [0x2e3238, 0x585f68, 0x87909a, 0xbcc3cb] },
  // V-type: basaltic, reddish grey.
  { name: 'basaltic', palette: [0x33241e, 0x5c443a, 0x876858, 0xb0907e] },
];

/** Names of the asteroid families. */
export const ASTEROID_FAMILY_NAMES: readonly string[] = ASTEROID_FAMILIES.map((f) => f.name);

/** Salt mixed into the seed, so the asteroid stream differs from every other value drawn from it. */
const ASTEROID_PARAMS_SALT = 0xa5e7_01d5;
/** Shared by the planet shader: terrain below this is "sea"; below every height, so there is none. */
const NO_SEA_LEVEL = -0.7;
/** Smallest gap between two rocks of a field, as a fraction of the sum of their radii. */
const ROCK_GAP = 0.25;
/** Placement tries for a rock before it is made smaller (every this many), and in all. */
const SHRINK_EVERY = 8;
const MAX_TRIES = 200;

type Range = readonly [number, number];

function lerp(range: Range, t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

function intIn(range: Range, t: number): number {
  return Math.min(range[1], range[0] + Math.floor(t * (range[1] - range[0] + 1)));
}

/** A rock's shape, tumble and surface offset, drawn from `random` in a fixed order. */
function drawRock(seed: number, offset: readonly [number, number, number], radius: number, detail: number, random: () => number): AsteroidRock {
  const g = ASTEROID_RANGES;
  const axisB = lerp(g.axisB, random());
  const axisC = Math.min(axisB, lerp(g.axisC, random()));
  const shape: IrregularBodyShape = {
    seed,
    detail,
    axes: [1, axisB, axisC],
    lumpiness: lerp(g.lumpiness, random()),
    craterCount: intIn(g.craterCount, random()),
    craterSize: g.craterSize,
  };
  const axis = randomUnit(random);
  return {
    offset,
    radius,
    shape,
    tumbleAxis: [axis.x, axis.y, axis.z],
    tumbleSpeed: lerp(g.tumbleSpeed, random()),
    tumblePhase: 2 * Math.PI * random(),
    noiseOffset: [lerp(PLANET_NOISE_OFFSET_RANGE, random()), lerp(PLANET_NOISE_OFFSET_RANGE, random()), lerp(PLANET_NOISE_OFFSET_RANGE, random())],
  };
}

/**
 * The lowest closest approach to the field centre that keeps the path clear: out of the field's
 * bounding sphere by the clearance margin (`radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`), and with
 * every rock's centre at least ASTEROID_MIN_PASS_DISTANCE from the path. A rock at `(side, up)` in the
 * encounter frame is `hypot(closest + side, up)` from the path.
 */
export function asteroidMinClosestDistance(rocks: readonly AsteroidRock[], radius: number): number {
  let closest = radius * (1 + ENCOUNTER_CLEARANCE_MARGIN);
  for (const rock of rocks) {
    const [, side, up] = rock.offset;
    closest = Math.max(closest, Math.sqrt(Math.max(0, ASTEROID_MIN_PASS_DISTANCE ** 2 - up * up)) - side);
  }
  return closest;
}

/**
 * Each rock's distance from the path, centre to path, in world units, with the field centre planned
 * `closestDistance` from it (`radius × k`).
 */
export function asteroidRockPassDistances(rocks: readonly AsteroidRock[], closestDistance: number): number[] {
  return rocks.map((rock) => Math.hypot(closestDistance + rock.offset[1], rock.offset[2]));
}

/**
 * Seeded asteroid parameters for an appearance seed (a uint32, normally `hash(baseSeed, index)`).
 * Deterministic, and every value lies inside the ranges in config.ts (a field's other rocks may be
 * made smaller than their range to fit; see `placeRock`).
 */
export function asteroidParams(seed: number): AsteroidParams {
  const random = mulberry32((seed ^ ASTEROID_PARAMS_SALT) >>> 0);
  // Burn a few values so nearby seeds decorrelate quickly.
  random();
  random();
  const g = ASTEROID_RANGES;
  const family = ASTEROID_FAMILIES[Math.min(ASTEROID_FAMILIES.length - 1, Math.floor(random() * ASTEROID_FAMILIES.length))]!;
  const palette = jitterPalette(family.palette, random);
  const field = random() < ASTEROID_FIELD_SHARE;
  const count = field ? intIn(g.fieldCount, random()) : 1;
  const mainRadius = lerp(g.radius, random());
  const reach = mainRadius * lerp(g.spread, random());
  const noiseScale = lerp(g.noiseScale, random());
  const octaves = intIn(g.octaves, random());
  const warp = lerp(g.warp, random());
  const relief = lerp(g.relief, random());
  const craters = lerp(g.craters, random());
  const passRoll = random();

  const rocks: AsteroidRock[] = [drawRock(hash(seed, 0), [0, 0, 0], mainRadius, ASTEROID_DETAIL.main, random)];
  for (let i = 1; i < count; i++) {
    const { offset, radius } = placeRock(rocks, mainRadius * lerp(g.satelliteRadius, random()), reach, random);
    rocks.push(drawRock(hash(seed, i), offset, radius, ASTEROID_DETAIL.satellite, random));
  }
  let radius = 0;
  for (const rock of rocks) radius = Math.max(radius, Math.hypot(...rock.offset) + rock.radius);
  const closest = asteroidMinClosestDistance(rocks, radius) * (1 + ASTEROID_PASS_EXTRA * passRoll * passRoll);
  return {
    seed,
    family: family.name,
    radius,
    passFactor: closest / radius,
    rocks,
    palette,
    noiseScale,
    octaves,
    warp,
    relief,
    craters,
  };
}

/**
 * Where a field's next rock goes: a seeded point in the box `±reach` along the path, `±0.75 reach`
 * toward the side and `±0.6 reach` up, at least ROCK_GAP clear of every rock placed so far. After
 * every SHRINK_EVERY tries that collide, the rock is made 10% smaller, so it soon fits (checked for
 * thousands of seeds in Asteroid.test.ts; past MAX_TRIES it would go at the end of the box).
 */
function placeRock(
  rocks: readonly AsteroidRock[],
  radius: number,
  reach: number,
  random: () => number,
): { offset: readonly [number, number, number]; radius: number } {
  let r = radius;
  let offset: readonly [number, number, number] = [reach, 0, 0];
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (attempt > 0 && attempt % SHRINK_EVERY === 0) r *= 0.9;
    offset = [(2 * random() - 1) * reach, (2 * random() - 1) * 0.75 * reach, (2 * random() - 1) * 0.6 * reach];
    const clear = rocks.every((rock) => {
      const gap = Math.hypot(offset[0] - rock.offset[0], offset[1] - rock.offset[1], offset[2] - rock.offset[2]);
      return gap >= (r + rock.radius) * (1 + ROCK_GAP);
    });
    if (clear) return { offset, radius: r };
  }
  return { offset: [reach, 0, 0], radius: r };
}

// ---------------------------------------------------------------------------------------------
// Asteroid
// ---------------------------------------------------------------------------------------------

/** Converts an sRGB colour to a Three.js (linear working space) colour. */
function toColor(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

/**
 * Writes the world-space position of a rock at `offset` (in the encounter frame `frame`, see
 * `AsteroidRock.offset`) relative to the field centre into `out`, and returns it.
 */
export function rockPosition(offset: readonly [number, number, number], frame: Readonly<PlanetFrame>, out: Vec3): Vec3 {
  const { direction: d, side: s } = frame;
  // up = side × direction (as for planets: with a -Z heading and the field to the right, +Y).
  const ux = s.y * d.z - s.z * d.y;
  const uy = s.z * d.x - s.x * d.z;
  const uz = s.x * d.y - s.y * d.x;
  const [a, b, c] = offset;
  out.x = a * d.x + b * s.x + c * ux;
  out.y = a * d.y + b * s.y + c * uy;
  out.z = a * d.z + b * s.z + c * uz;
  return out;
}

/**
 * Makes the unit icospheres asteroid rocks are built from (ASTEROID_DETAIL), and builds and disposes
 * one field of seven rocks, so the frame that creates the first asteroid of a run neither makes them
 * nor runs the builder's code for the first time (measured under SwiftShader at 960×540, the work of
 * the frame that created a first field of seven rocks was 17–122 ms without this, and is 7–16 ms
 * with it, against 5–13 ms for a planet's: e2e/asteroid.spec.ts). The engine calls it at
 * start-up. It makes no GPU resource: the trial asteroid is never drawn or compiled, and its
 * geometries and materials are disposed at once.
 */
export function prepareAsteroids(): void {
  let seed = 0;
  while (asteroidParams(seed).rocks.length < ASTEROID_RANGES.fieldCount[1] && seed < 1000) seed++;
  new Asteroid(asteroidParams(seed)).dispose();
}

export class Asteroid {
  readonly params: Readonly<AsteroidParams>;
  /**
   * Root object to add to the scene. Its position is the field centre relative to the ship, and its
   * scale is `setScale`'s factor (the rocks are laid out in world units inside it).
   */
  readonly object = new Group();
  /** The rocks' meshes, in `params.rocks` order; each owns its geometry and material. */
  readonly rocks: readonly Mesh<BufferGeometry, ShaderMaterial>[];
  /** Fade and light direction, shared by every rock's material. */
  readonly uniforms: { uOpacity: { value: number }; uLightDir: { value: Vector3 } };
  private readonly axes: readonly Vector3[];
  private disposed = false;

  /** `frame` is the encounter's (its planned direction and side), which the rocks are laid out in. */
  constructor(
    params: Readonly<AsteroidParams>,
    lightDirection: Readonly<Vec3> = PLANET_LIGHT_DIRECTION,
    frame: Readonly<PlanetFrame> = DEFAULT_PLANET_FRAME,
  ) {
    this.params = params;
    this.uniforms = {
      uOpacity: { value: 1 },
      uLightDir: { value: new Vector3(lightDirection.x, lightDirection.y, lightDirection.z).normalize() },
    };
    const [c0, c1, c2, c3] = params.palette;
    const shared = {
      uColor0: { value: toColor(c0) },
      uColor1: { value: toColor(c1) },
      uColor2: { value: toColor(c2) },
      uColor3: { value: toColor(c3) },
      uNoiseScale: { value: params.noiseScale },
      uOctaves: { value: params.octaves },
      uLightDir: this.uniforms.uLightDir,
      uOpacity: this.uniforms.uOpacity,
      // Airless, dry and bare: no haze, sea, ice or gloss.
      uAtmosphereColor: { value: new Color(0, 0, 0) },
      uAtmosphereIntensity: { value: 0 },
      uWarp: { value: params.warp },
      uSeaLevel: { value: NO_SEA_LEVEL },
      uIceCap: { value: 0 },
      uSpecular: { value: 0 },
      uRelief: { value: params.relief },
      uCraters: { value: params.craters },
    };
    const position = { x: 0, y: 0, z: 0 };
    this.rocks = params.rocks.map((rock) => {
      const material = rockySurfaceMaterial({ ...shared, uNoiseOffset: { value: new Vector3(...rock.noiseOffset) } });
      const mesh = new Mesh(irregularBodyGeometry(rock.shape), material);
      rockPosition(rock.offset, frame, position);
      mesh.position.set(position.x, position.y, position.z);
      mesh.scale.setScalar(rock.radius);
      mesh.renderOrder = SURFACE_RENDER_ORDER;
      this.object.add(mesh);
      return mesh;
    });
    this.axes = params.rocks.map((rock) => new Vector3(...rock.tumbleAxis).normalize());
    this.update(0);
  }

  /** Sets the opacity in [0, 1] (the Autopilot's fade). At 0 the asteroid is not drawn. */
  setFade(opacity: number): void {
    const o = Math.min(1, Math.max(0, opacity));
    this.uniforms.uOpacity.value = o;
    this.object.visible = o > 0;
  }

  /** Sets the size scale (the encounter's size scale) of the whole field. */
  setScale(scale: number): void {
    this.object.scale.setScalar(scale);
  }

  /** Sets the direction toward the light, in world space (normalised here). */
  setLightDirection(x: number, y: number, z: number): void {
    this.uniforms.uLightDir.value.set(x, y, z).normalize();
  }

  /** Turns every rock to its tumble at `time` seconds. Allocates nothing. */
  update(time: number): void {
    const { rocks } = this.params;
    for (let i = 0; i < this.rocks.length; i++) {
      const rock = rocks[i]!;
      this.rocks[i]!.quaternion.setFromAxisAngle(this.axes[i]!, rock.tumblePhase + time * rock.tumbleSpeed);
    }
  }

  /** Frees every rock's geometry and material. Disposing twice is harmless. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    for (const rock of this.rocks) {
      rock.material.dispose();
      rock.geometry.dispose();
    }
  }
}
