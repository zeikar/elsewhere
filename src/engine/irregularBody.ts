/**
 * Irregular bodies (docs/PLAN.md section 6, Variety, and section 9, Phase 4): the pure geometry of a
 * small, lumpy, cratered body, shared by asteroid rocks (Asteroid.ts) and comet nuclei (Comet.ts).
 *
 * - `irregularBodyGeometry(shape)` builds one body: an icosphere with its duplicate vertices merged,
 *   stretched into a seeded ellipsoid, then displaced along each direction by low-frequency seeded
 *   lumps and a few bowl-shaped craters with raised rims (their factor softly floored at
 *   MIN_RELATIVE_RADIUS, so no pit reaches the centre), and scaled so its farthest vertex is at
 *   exactly 1. It is pure and deterministic, so the same shape always gives the same geometry.
 * - The shape's optional fields (`craterDepth`, `craterRim`, `lumpFrequency`) tune the look per kind
 *   of body; left out, they are the asteroid rocks' values, so an asteroid's geometry is exactly what
 *   it was before comets (checked against a pinned checksum in irregularBody.test.ts).
 * - The unit icospheres are made once per detail and kept: plain CPU arrays, no GPU resource.
 */
import { BufferAttribute, BufferGeometry, IcosahedronGeometry } from 'three';
import { mulberry32 } from './seed';

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
  /** A crater's depth at its centre, in radii per radian of its angular radius. Default: CRATER_DEPTH (the rocks'). */
  craterDepth?: number;
  /** Height of a crater's raised rim, relative to its depth. Default: CRATER_RIM (the rocks'). */
  craterRim?: number;
  /**
   * The lumps' frequency band, `[lowest, spread]`: wave `j` of LUMP_WAVES has the frequency
   * `lowest + spread × j / (LUMP_WAVES - 1)`, plus a seeded jitter of up to LUMP_FREQUENCY_JITTER.
   * Lower gives fewer, broader lobes. Default: LUMP_FREQUENCY (the rocks').
   */
  lumpFrequency?: readonly [number, number];
}

/** Lumps: plane waves across the body, `amplitude × sin(frequency × (d · direction) + phase)`. */
const LUMP_WAVES = 7;
/** Each lump wave's share of `lumpiness` falls off by this factor, so the first few shape the body. */
const LUMP_FALLOFF = 0.8;
/** The rocks' lump frequency band (see `IrregularBodyShape.lumpFrequency`): about one to three bulges across the body. */
export const LUMP_FREQUENCY: readonly [number, number] = [1.4, 2.2];
const LUMP_FREQUENCY_JITTER = 0.6;
/** The rocks' crater depth at the centre, in radii per radian of the crater's angular radius. */
export const CRATER_DEPTH = 0.45;
/** The rocks' crater rim height, relative to its depth, and how sharply a rim falls off around the edge. */
export const CRATER_RIM = 0.3;
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
export function randomUnit(random: () => number): { x: number; y: number; z: number } {
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
  const [lowest, spread] = shape.lumpFrequency ?? LUMP_FREQUENCY;
  const waves: Wave[] = [];
  for (let j = 0; j < LUMP_WAVES; j++) {
    const d = randomUnit(random);
    waves.push({
      ...d,
      // Low frequencies: by default about one to three bulges across the body.
      frequency: lowest + spread * (j / (LUMP_WAVES - 1)) + LUMP_FREQUENCY_JITTER * random(),
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
  const depth = shape.craterDepth ?? CRATER_DEPTH;
  const rimHeight = shape.craterRim ?? CRATER_RIM;
  const ellipsoid = 1 / Math.sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2);
  let h = 0;
  for (const w of waves) h += w.amplitude * Math.sin(w.frequency * (x * w.x + y * w.y + z * w.z) + w.phase);
  for (const k of craters) {
    const t = Math.acos(Math.min(1, Math.max(-1, x * k.x + y * k.y + z * k.z))) / k.size;
    // A bowl (-1 at the centre, 0 at the edge) and a raised rim around it.
    const bowl = t < 1 ? t * t - 1 : 0;
    const rim = rimHeight * Math.exp(-CRATER_RIM_SHARPNESS * (t - 1) * (t - 1));
    h += depth * k.size * (bowl + rim);
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
