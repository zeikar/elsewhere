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
 * - `irregularBodyGeometry(shape)` builds one rock: an icosphere with its duplicate vertices merged,
 *   stretched into a seeded ellipsoid, then displaced along each direction by low-frequency seeded
 *   lumps and a few bowl-shaped craters with raised rims (their factor softly floored at
 *   MIN_RELATIVE_RADIUS, so no pit reaches the centre), and scaled so its farthest vertex is at
 *   exactly 1. It is pure and deterministic, so the same shape always gives the same geometry, and is
 *   meant to be reused for any irregular body (a comet's nucleus, for one).
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
import { BufferAttribute, BufferGeometry, Color, Group, IcosahedronGeometry, Mesh, SRGBColorSpace, Vector3, type ShaderMaterial } from 'three';
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
import { DEFAULT_PLANET_FRAME, SURFACE_RENDER_ORDER, jitterPalette, rockySurfaceMaterial, type PlanetFrame, type Rgb } from './Planet';
import { hash, mulberry32 } from './seed';
import type { Vec3 } from './Ship';

// ---------------------------------------------------------------------------------------------
// Irregular bodies (pure geometry)
// ---------------------------------------------------------------------------------------------

/** The seeded shape of an irregular body (`irregularBodyGeometry`). Lengths are before the final scaling. */
export interface IrregularBodyShape {
  /** Seed of the lumps and craters (their directions, frequencies and phases). */
  seed: number;
  /** Icosphere detail (`IcosahedronGeometry`'s): 10 (detail + 1)² + 2 vertices, 20 (detail + 1)² triangles. */
  detail: number;
  /** Semi-axes of the ellipsoid the sphere is stretched into (the longest is 1): an elongated, potato-like shape. */
  axes: readonly [number, number, number];
  /** Largest total amplitude of the low-frequency lumps, as a fraction of the radius. */
  lumpiness: number;
  /** Number of craters. */
  craterCount: number;
  /** Range of the craters' angular radii on the body, in radians. */
  craterSize: readonly [number, number];
}

/** Lumps: plane waves across the body, `amplitude × sin(frequency × (d · direction) + phase)`. */
const LUMP_WAVES = 7;
/** Each lump wave's share of `lumpiness` falls off by this factor, so the first few shape the body. */
const LUMP_FALLOFF = 0.8;
/** A crater's depth at its centre, in radii per radian of its angular radius. */
const CRATER_DEPTH = 0.45;
/** Height of a crater's raised rim, relative to its depth, and how sharply it falls off around the edge. */
const CRATER_RIM = 0.3;
const CRATER_RIM_SHARPNESS = 12;
/**
 * Floor of the lumps-and-craters factor (`1 + h`, see `bodyRadius`), whatever the shape: overlapping
 * crater bowls on a deep lump could otherwise take a direction's radius to the centre or through it
 * (a folded, self-intersecting pit). Below SOFT_FLOOR_KNEE the factor eases smoothly (with a
 * continuous slope) toward the floor, so the floor leaves no crease, and nothing above the knee changes.
 */
export const MIN_RELATIVE_RADIUS = 0.35;
const SOFT_FLOOR_KNEE = 0.6;
/** Salt of the lump and crater stream, independent of the other draws from the shape's seed. */
const SHAPE_SALT = 0x5ba9e;

interface Wave {
  x: number;
  y: number;
  z: number;
  frequency: number;
  phase: number;
  amplitude: number;
}

interface Crater {
  x: number;
  y: number;
  z: number;
  /** Angular radius, in radians. */
  size: number;
}

/** A uniformly random unit vector from `random`. */
function randomUnit(random: () => number): { x: number; y: number; z: number } {
  const z = 2 * random() - 1;
  const a = 2 * Math.PI * random();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: r * Math.cos(a), y: r * Math.sin(a), z };
}

/** The lumps and craters of `shape`, drawn in a fixed order from its seed. */
function shapeFeatures(shape: Readonly<IrregularBodyShape>): { waves: Wave[]; craters: Crater[] } {
  const random = mulberry32((shape.seed ^ SHAPE_SALT) >>> 0);
  random();
  let weights = 0;
  for (let j = 0; j < LUMP_WAVES; j++) weights += LUMP_FALLOFF ** j;
  const waves: Wave[] = [];
  for (let j = 0; j < LUMP_WAVES; j++) {
    const d = randomUnit(random);
    waves.push({
      ...d,
      // Low frequencies: about one to three bulges across the body.
      frequency: 1.4 + 2.2 * (j / (LUMP_WAVES - 1)) + 0.6 * random(),
      phase: 2 * Math.PI * random(),
      amplitude: (shape.lumpiness * LUMP_FALLOFF ** j) / weights,
    });
  }
  const craters: Crater[] = [];
  const [low, high] = shape.craterSize;
  for (let k = 0; k < shape.craterCount; k++) {
    const d = randomUnit(random);
    // Skewed toward small craters.
    craters.push({ ...d, size: low + (high - low) * random() ** 1.3 });
  }
  return { waves, craters };
}

/** `f` unchanged from SOFT_FLOOR_KNEE up, easing exponentially toward MIN_RELATIVE_RADIUS below it (always above it). */
function softFloor(f: number): number {
  if (f >= SOFT_FLOOR_KNEE) return f;
  const width = SOFT_FLOOR_KNEE - MIN_RELATIVE_RADIUS;
  return MIN_RELATIVE_RADIUS + width * Math.exp((f - SOFT_FLOOR_KNEE) / width);
}

/**
 * The body's radius along the unit direction `(x, y, z)`, before the final scaling: the ellipsoid's
 * radius there times (1 + the lumps + the craters), that factor softly floored at MIN_RELATIVE_RADIUS.
 */
function bodyRadius(x: number, y: number, z: number, shape: Readonly<IrregularBodyShape>, waves: readonly Wave[], craters: readonly Crater[]): number {
  const [a, b, c] = shape.axes;
  const ellipsoid = 1 / Math.sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2);
  let h = 0;
  for (const w of waves) h += w.amplitude * Math.sin(w.frequency * (x * w.x + y * w.y + z * w.z) + w.phase);
  for (const k of craters) {
    const t = Math.acos(Math.min(1, Math.max(-1, x * k.x + y * k.y + z * k.z))) / k.size;
    // A bowl (-1 at the centre, 0 at the edge) and a raised rim around it.
    const bowl = t < 1 ? t * t - 1 : 0;
    const rim = CRATER_RIM * Math.exp(-CRATER_RIM_SHARPNESS * (t - 1) * (t - 1));
    h += CRATER_DEPTH * k.size * (bowl + rim);
  }
  return ellipsoid * softFloor(1 + h);
}

/** An icosphere's merged unit vertex directions and triangle indices (CPU-side data only). */
interface UnitIcosphere {
  directions: Float64Array;
  index: Uint16Array;
}

/** The unit icospheres made so far, by detail; pure data, kept for the whole run. */
const icospheres = new Map<number, UnitIcosphere>();

/**
 * The unit icosphere of `detail` (`IcosahedronGeometry`'s, with its duplicate vertices merged so a
 * displaced surface stays closed and its normals smooth). Made on first use and kept: a few kB of
 * plain arrays per detail, no GPU resource, so building a rock (once per encounter) is only its
 * displacement and normals.
 */
function unitIcosphere(rawDetail: number): UnitIcosphere {
  const detail = Math.max(0, Math.min(40, Math.floor(rawDetail)));
  const cached = icospheres.get(detail);
  if (cached !== undefined) return cached;
  const ico = new IcosahedronGeometry(1, detail);
  const source = ico.getAttribute('position');
  const ids = new Map<string, number>();
  const directions: number[] = [];
  const index = new Uint16Array(source.count);
  for (let i = 0; i < source.count; i++) {
    const x = source.getX(i);
    const y = source.getY(i);
    const z = source.getZ(i);
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = directions.length / 3;
      ids.set(key, id);
      const l = Math.hypot(x, y, z);
      directions.push(x / l, y / l, z / l);
    }
    index[i] = id;
  }
  ico.dispose();
  const made = { directions: Float64Array.from(directions), index };
  icospheres.set(detail, made);
  return made;
}


/**
 * The body's radius along each of its geometry's vertex directions (in vertex order), before the
 * final scaling: at least MIN_RELATIVE_RADIUS times the ellipsoid's radius there. Pure.
 */
export function irregularBodyRadii(shape: Readonly<IrregularBodyShape>): Float64Array {
  const { directions } = unitIcosphere(shape.detail);
  const { waves, craters } = shapeFeatures(shape);
  const radii = new Float64Array(directions.length / 3);
  for (let i = 0; i < radii.length; i++) {
    radii[i] = bodyRadius(directions[3 * i]!, directions[3 * i + 1]!, directions[3 * i + 2]!, shape, waves, craters);
  }
  return radii;
}

/**
 * A seeded, noise-displaced low-poly sphere (an irregular rocky body): see the module comment. The
 * geometry is indexed, with `position`, smooth vertex `normal`s and `uv` (all zero; the attributes
 * of the planet sphere, so it draws with the planet programs), and its farthest vertex is exactly at
 * radius 1, so a mesh scaled by `r` lies within `r` of its centre whatever its rotation (the
 * triangles lie within their vertices' bounding sphere). Pure and deterministic. The caller owns the
 * geometry and disposes it.
 */
export function irregularBodyGeometry(shape: Readonly<IrregularBodyShape>): BufferGeometry {
  const { directions, index } = unitIcosphere(shape.detail);
  const radii = irregularBodyRadii(shape);
  const count = radii.length;
  const positions = new Float32Array(count * 3);
  let farthest = 0;
  for (let i = 0; i < count; i++) farthest = Math.max(farthest, radii[i]!);
  for (let i = 0; i < count; i++) {
    const r = radii[i]! / farthest;
    positions[3 * i] = directions[3 * i]! * r;
    positions[3 * i + 1] = directions[3 * i + 1]! * r;
    positions[3 * i + 2] = directions[3 * i + 2]! * r;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(index.slice(), 1));
  geometry.computeVertexNormals();
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  geometry.computeBoundingSphere();
  return geometry;
}

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
