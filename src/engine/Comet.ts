/**
 * Comets (docs/PLAN.md section 6, Variety, and section 9, Phase 4): a small, dark, irregular nucleus
 * in a soft glowing coma, with a straight bluish ion tail and a broader, curved, yellowish dust tail,
 * both pointing away from the comet's sun.
 *
 * - `cometParams(seed)` is pure: it derives the family, the nucleus (size, shape, tumble and dark
 *   surface), the coma, both tails, the pass factor `k` and the out-of-view bounds from an
 *   encounter's appearance seed. Its result is a `CometSpec` (the coma `radius`, `passFactor` and
 *   `bounds`), so it can be passed straight to `AutopilotParams.cometFor`.
 * - Everything is laid out in the encounter's own frame (along the planned path, toward the side the
 *   comet sits on, and up: `side × direction`, as for asteroid rocks), so the plan knows where every
 *   part lies. The sun is ahead of the comet, toward the path and a little up (COMET_ENCOUNTER_LIGHT,
 *   `CometParams.sun`); the ion tail points straight away from it, and the dust tail starts away from
 *   it and curves aside (`cometTailPoint`), never toward the path or ahead. So both tails' axes only
 *   move away from the path from the nucleus on, which passes at least COMET_MIN_PASS_DISTANCE from
 *   it, and no part of either tube comes nearer the path than the coma's edge
 *   (`cometTailClearance`, checked in Comet.test.ts): the camera never meets the nucleus, the coma or
 *   a tail.
 * - `Comet` builds two meshes, both freed in `dispose()`: the nucleus, an irregular body
 *   (`irregularBodyGeometry`, irregularBody.ts) shaded with the rocky planet surface program in dark
 *   tones and tumbling slowly, and the glow, one additive mesh (`cometGlowGeometry`: a sphere for the
 *   coma and an open tube along each tail) drawn with the planets' halo program
 *   (`cometGlowMaterial` in Planet.ts), so comets add no shader program and ProgramWarmup's rocky and
 *   atmosphere holders keep theirs compiled. Each glow fragment adds the light of the gas along its
 *   view ray, so the glow is soft from every side and each piece is shaded about once per pixel it
 *   covers.
 * - `setFade(opacity)` drives one opacity uniform shared by the nucleus and the glow (the
 *   Autopilot's fade); at 0 the comet is hidden.
 * - Draw order and depth: the nucleus is drawn like a rocky planet's surface (SURFACE_RENDER_ORDER,
 *   writing depth), and the glow like an atmosphere (ATMOSPHERE_RENDER_ORDER: after the near
 *   starfield, additive, depth-tested and writing no depth), so the nucleus hides the glow behind it
 *   and the glow adds over the stars and the nucleus in front of it.
 *
 * Positions are relative to the ship (floating origin): the caller sets `object.position` to
 * `nucleus - ship position`, computed in float64 on the CPU.
 */
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, SRGBColorSpace, SphereGeometry, Vector2, Vector3, Vector4, type ShaderMaterial } from 'three';
import {
  COMET_BOUND_RINGS,
  COMET_COMA_SEGMENTS,
  COMET_ENCOUNTER_LIGHT,
  COMET_MIN_PASS_DISTANCE,
  COMET_NUCLEUS_CRATER_DEPTH,
  COMET_NUCLEUS_CRATER_RIM,
  COMET_NUCLEUS_DETAIL,
  COMET_NUCLEUS_LUMP_FREQUENCY,
  COMET_PASS_EXTRA,
  COMET_RANGES,
  COMET_TAIL_SEGMENTS,
  COMET_TAIL_SIDES,
  ENCOUNTER_CLEARANCE_MARGIN,
  PLANET_NOISE_OFFSET_RANGE,
} from '../config';
import type { CometBound, CometSpec } from './Autopilot';
import { irregularBodyGeometry, randomUnit, type IrregularBodyShape } from './irregularBody';
import {
  ATMOSPHERE_RENDER_ORDER,
  DEFAULT_PLANET_FRAME,
  SURFACE_RENDER_ORDER,
  cometGlowMaterial,
  jitterPalette,
  rockySurfaceMaterial,
  type PlanetFrame,
  type Rgb,
} from './Planet';
import { hash, mulberry32 } from './seed';
import type { Vec3 } from './Ship';

/** A vector in the encounter frame: along the planned path, toward the comet's side, and up. */
export type FrameVector = readonly [number, number, number];

// ---------------------------------------------------------------------------------------------
// Seeded parameters (pure)
// ---------------------------------------------------------------------------------------------

/** One tail of a comet. Lengths in world units, directions in the encounter frame. */
export interface CometTail {
  /** Length parameter of the axis (`cometTailPoint`): the axis runs `length` along `direction`. */
  length: number;
  /** Half-width at the head and at the end. */
  headWidth: number;
  endWidth: number;
  /** Unit direction of the axis at the head: away from the sun (the ion tail exactly, the dust tail from there). */
  direction: FrameVector;
  /** Unit vector at right angles to `direction` that the axis curves toward. */
  bend: FrameVector;
  /** How far the axis turns toward `bend`: `length × (angle × t + curvature × t²)` at `t` (both 0 for a straight tail). */
  angle: number;
  curvature: number;
  /** Peak brightness on the axis (linear), before the encounter fade. */
  intensity: number;
  /** Colour (sRGB). */
  color: Rgb;
}

export interface CometNucleus {
  /** Bounding radius: every vertex lies within it, whatever the tumble. */
  radius: number;
  shape: IrregularBodyShape;
  /** Unit tumble axis (world space), speed (radians per second) and starting angle (radians). */
  tumbleAxis: readonly [number, number, number];
  tumbleSpeed: number;
  tumblePhase: number;
  /** Offset into the surface noise. */
  noiseOffset: readonly [number, number, number];
}

export interface CometParams extends CometSpec {
  /** The appearance seed these parameters were drawn from. */
  seed: number;
  /** Name of the family the coma and the tails' balance were drawn from (for example `dusty`). */
  family: string;
  /** Coma radius (the encounter radius): the glow fades to nothing there. */
  radius: number;
  /** `k`: the encounter passes the nucleus at `radius × k`. */
  passFactor: number;
  /** Spheres that hold the coma and every stretch of both tails (`cometBounds`). */
  bounds: readonly CometBound[];
  /** Unit direction toward the comet's sun, in the encounter frame (COMET_ENCOUNTER_LIGHT). */
  sun: FrameVector;
  nucleus: CometNucleus;
  /** Four surface colours (sRGB), as for a rocky planet: unused (no sea), lowland, upland, highland. Dark. */
  palette: readonly [Rgb, Rgb, Rgb, Rgb];
  /** Nucleus surface shading, as for a rocky planet. */
  noiseScale: number;
  octaves: number;
  warp: number;
  relief: number;
  craters: number;
  coma: { intensity: number; color: Rgb };
  ion: CometTail;
  dust: CometTail;
  /**
   * Whether the tails are drawn. Always for a seeded comet; `encounterCometParams` (EncounterView.ts)
   * leaves them out for a comet whose spec does not bound them, so they never outlast the encounter.
   */
  tails: boolean;
}

/**
 * Comet families, picked evenly: the coma's tint and the balance of the tails (each tail's
 * brightness is its range's draw times the family's factor, at most 1).
 */
const COMET_FAMILIES: readonly { name: string; coma: Rgb; ion: number; dust: number }[] = [
  // Gas-rich: a green-cyan coma (C₂ and CN glow) and a bright ion tail.
  { name: 'gassy', coma: [0.62, 1.0, 0.8], ion: 1, dust: 0.55 },
  // Dust-rich: a warm white coma and a bright dust tail.
  { name: 'dusty', coma: [1.0, 0.94, 0.82], ion: 0.5, dust: 1 },
  // Both tails alike, a pale blue-white coma.
  { name: 'balanced', coma: [0.84, 0.92, 1.0], ion: 0.85, dust: 0.85 },
];

/** Names of the comet families. */
export const COMET_FAMILY_NAMES: readonly string[] = COMET_FAMILIES.map((f) => f.name);

/** The tails' colours (sRGB) before a small seeded jitter: ionised gas glows blue, dust reflects the sun. */
const ION_COLOR: Rgb = [0.45, 0.64, 1.0];
const DUST_COLOR: Rgb = [1.0, 0.84, 0.58];
/** The nucleus's palette (the first, the sea, is unused): soot-dark, a little brown. */
const NUCLEUS_PALETTE: readonly [number, number, number, number] = [0x121110, 0x26221f, 0x3a3530, 0x544c45];

/** Salt mixed into the seed, so the comet stream differs from every other value drawn from it. */
const COMET_PARAMS_SALT = 0xc0_3e7a11;
/** Shared by the planet shader: terrain below this is "sea"; below every height, so there is none. */
const NO_SEA_LEVEL = -0.7;

type Range = readonly [number, number];

function lerp(range: Range, t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

function intIn(range: Range, t: number): number {
  return Math.min(range[1], range[0] + Math.floor(t * (range[1] - range[0] + 1)));
}

function normalize(v: FrameVector): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: FrameVector, b: FrameVector): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The unit direction toward a comet's sun in the encounter frame (COMET_ENCOUNTER_LIGHT). */
export function cometSun(): FrameVector {
  const { ahead, inward, up } = COMET_ENCOUNTER_LIGHT;
  return normalize([ahead, -inward, up]);
}

/**
 * The point at `t` (0 at the head, 1 at the end) on `tail`'s axis, relative to the nucleus in the
 * encounter frame: `length × (t × direction + (angle × t + curvature × t²) × bend)`.
 */
export function cometTailPoint(tail: Readonly<CometTail>, t: number): [number, number, number] {
  const { length: l, direction: d, bend: b, angle, curvature } = tail;
  const lateral = angle * t + curvature * t * t;
  return [l * (t * d[0] + lateral * b[0]), l * (t * d[1] + lateral * b[1]), l * (t * d[2] + lateral * b[2])];
}

/** The unit tangent of `tail`'s axis at `t`. */
export function cometTailTangent(tail: Readonly<CometTail>, t: number): [number, number, number] {
  const { direction: d, bend: b, angle, curvature } = tail;
  const k = angle + 2 * curvature * t;
  return normalize([d[0] + k * b[0], d[1] + k * b[1], d[2] + k * b[2]]);
}

/** `tail`'s half-width at `t`: linear from its head to its end. */
export function cometTailWidth(tail: Readonly<CometTail>, t: number): number {
  return tail.headWidth + (tail.endWidth - tail.headWidth) * t;
}

/**
 * The vertices of `tail`'s tube, relative to the nucleus in the encounter frame: `segments + 1` rings
 * of `sides` vertices, from the head to the end, each a circle of the tail's half-width at right
 * angles to the axis (`x, y, z` per vertex, ring after ring). The glow geometry and the out-of-view
 * bounds are both made from these, so the bounds hold the drawn tube.
 */
export function cometTailRings(tail: Readonly<CometTail>, segments = COMET_TAIL_SEGMENTS, sides = COMET_TAIL_SIDES): Float64Array {
  const out = new Float64Array((segments + 1) * sides * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = cometTailPoint(tail, t);
    const tangent = cometTailTangent(tail, t);
    // The tangent is the direction plus a multiple of the bend, at right angles to it, so it is never
    // parallel to the bend.
    const n1 = normalize(cross(tangent, tail.bend));
    const n2 = cross(tangent, n1);
    const w = cometTailWidth(tail, t);
    for (let j = 0; j < sides; j++) {
      const theta = (2 * Math.PI * j) / sides;
      const c = Math.cos(theta) * w;
      const s = Math.sin(theta) * w;
      const o = 3 * (i * sides + j);
      out[o] = a[0] + c * n1[0] + s * n2[0];
      out[o + 1] = a[1] + c * n1[1] + s * n2[1];
      out[o + 2] = a[2] + c * n1[2] + s * n2[2];
    }
  }
  return out;
}

/** Each bound is this much larger (relative, and in world units), so float32 rounding of the drawn vertices never puts one outside. */
const BOUND_SLACK = 1e-5;

/**
 * The out-of-view bounds of a comet with coma radius `radius` and tails `tails`: the coma's sphere,
 * then for each tail one sphere per COMET_BOUND_RINGS tube segments, holding every vertex of the rings
 * at both ends of them and so every triangle between them (each lies within its vertices' convex
 * hull). Together they hold everything drawn for the comet: the nucleus lies inside the coma.
 */
export function cometBounds(radius: number, tails: readonly Readonly<CometTail>[], segments = COMET_TAIL_SEGMENTS, sides = COMET_TAIL_SIDES): CometBound[] {
  const bounds: CometBound[] = [{ offset: [0, 0, 0], radius: radius * (1 + BOUND_SLACK) + BOUND_SLACK }];
  for (const tail of tails) {
    const rings = cometTailRings(tail, segments, sides);
    for (let first = 0; first < segments; first += COMET_BOUND_RINGS) {
      const last = Math.min(segments, first + COMET_BOUND_RINGS);
      const from = first * sides;
      const to = (last + 1) * sides;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let v = from; v < to; v++) {
        cx += rings[3 * v]!;
        cy += rings[3 * v + 1]!;
        cz += rings[3 * v + 2]!;
      }
      const n = to - from;
      cx /= n;
      cy /= n;
      cz /= n;
      let r = 0;
      for (let v = from; v < to; v++) r = Math.max(r, Math.hypot(rings[3 * v]! - cx, rings[3 * v + 1]! - cy, rings[3 * v + 2]! - cz));
      bounds.push({ offset: [cx, cy, cz], radius: r * (1 + BOUND_SLACK) + BOUND_SLACK });
    }
  }
  return bounds;
}

/**
 * The smallest distance from the planned path to any vertex of `tail`'s tube, for a nucleus planned
 * `closestDistance` from the path: a point at `(along, side, up)` from the nucleus is
 * `hypot(closestDistance + side, up)` from the path. The triangles lie between their vertices, and
 * every ring keeps away from the path, so this bounds the whole tube.
 */
export function cometTailClearance(tail: Readonly<CometTail>, closestDistance: number): number {
  const rings = cometTailRings(tail);
  let nearest = Number.POSITIVE_INFINITY;
  for (let v = 0; v < rings.length; v += 3) nearest = Math.min(nearest, Math.hypot(closestDistance + rings[v + 1]!, rings[v + 2]!));
  return nearest;
}

/**
 * Seeded comet parameters for an appearance seed (a uint32, normally `hash(baseSeed, index)`).
 * Deterministic, and every value lies inside the ranges in config.ts (a tail's brightness is its
 * range's draw times its family's factor, at most 1).
 */
export function cometParams(seed: number): CometParams {
  const random = mulberry32((seed ^ COMET_PARAMS_SALT) >>> 0);
  // Burn a few values so nearby seeds decorrelate quickly.
  random();
  random();
  const g = COMET_RANGES;
  const family = COMET_FAMILIES[Math.min(COMET_FAMILIES.length - 1, Math.floor(random() * COMET_FAMILIES.length))]!;
  const palette = jitterPalette(NUCLEUS_PALETTE, random);
  const jitter = (rgb: Rgb): Rgb => [rgb[0] * (0.94 + 0.12 * random()), rgb[1] * (0.94 + 0.12 * random()), Math.min(1, rgb[2] * (0.94 + 0.12 * random()))];

  // The nucleus.
  const nucleusRadius = lerp(g.nucleusRadius, random());
  const axisB = lerp(g.axisB, random());
  const axisC = Math.min(axisB, lerp(g.axisC, random()));
  const shape: IrregularBodyShape = {
    seed: hash(seed, 0),
    detail: COMET_NUCLEUS_DETAIL,
    axes: [1, axisB, axisC],
    lumpiness: lerp(g.lumpiness, random()),
    craterCount: intIn(g.craterCount, random()),
    craterSize: g.craterSize,
    craterDepth: COMET_NUCLEUS_CRATER_DEPTH,
    craterRim: COMET_NUCLEUS_CRATER_RIM,
    lumpFrequency: COMET_NUCLEUS_LUMP_FREQUENCY,
  };
  const axis = randomUnit(random);
  const nucleus: CometNucleus = {
    radius: nucleusRadius,
    shape,
    tumbleAxis: [axis.x, axis.y, axis.z],
    tumbleSpeed: lerp(g.tumbleSpeed, random()),
    tumblePhase: 2 * Math.PI * random(),
    noiseOffset: [lerp(PLANET_NOISE_OFFSET_RANGE, random()), lerp(PLANET_NOISE_OFFSET_RANGE, random()), lerp(PLANET_NOISE_OFFSET_RANGE, random())],
  };
  const noiseScale = lerp(g.noiseScale, random());
  const octaves = intIn(g.octaves, random());
  const warp = lerp(g.warp, random());
  const relief = lerp(g.relief, random());
  const craters = lerp(g.craters, random());

  // The coma and the tails.
  const radius = lerp(g.comaRadius, random());
  const coma = { intensity: lerp(g.comaIntensity, random()), color: jitter(family.coma) };
  const sun = cometSun();
  const away: FrameVector = [-sun[0], -sun[1], -sun[2]];
  // Outward: the frame's side axis (away from the path) at right angles to the anti-sun direction.
  // Trailing: at right angles to both the anti-sun direction and the side axis, back along the path.
  const sideDot = away[1];
  const outward = normalize([-sideDot * away[0], 1 - sideDot * away[1], -sideDot * away[2]]);
  const trailing = normalize(cross([0, 1, 0], away));
  const ion: CometTail = {
    length: lerp(g.ionLength, random()),
    headWidth: radius * lerp(g.ionHeadWidth, random()),
    endWidth: radius * lerp(g.ionEndWidth, random()),
    direction: away,
    bend: outward,
    angle: 0,
    curvature: 0,
    intensity: lerp(g.ionIntensity, random()) * family.ion,
    color: jitter(ION_COLOR),
  };
  const tilt = lerp(g.dustBendTilt, random());
  const dust: CometTail = {
    length: lerp(g.dustLength, random()),
    headWidth: radius * lerp(g.dustHeadWidth, random()),
    endWidth: radius * lerp(g.dustEndWidth, random()),
    direction: away,
    bend: normalize([
      Math.cos(tilt) * trailing[0] + Math.sin(tilt) * outward[0],
      Math.cos(tilt) * trailing[1] + Math.sin(tilt) * outward[1],
      Math.cos(tilt) * trailing[2] + Math.sin(tilt) * outward[2],
    ]),
    angle: lerp(g.dustAngle, random()),
    curvature: lerp(g.dustCurvature, random()),
    intensity: lerp(g.dustIntensity, random()) * family.dust,
    color: jitter(DUST_COLOR),
  };
  const passRoll = random();
  const closest = Math.max(COMET_MIN_PASS_DISTANCE, radius * (1 + ENCOUNTER_CLEARANCE_MARGIN)) * (1 + COMET_PASS_EXTRA * passRoll * passRoll);
  return {
    seed,
    family: family.name,
    radius,
    passFactor: closest / radius,
    bounds: cometBounds(radius, [ion, dust]),
    sun,
    nucleus,
    palette,
    noiseScale,
    octaves,
    warp,
    relief,
    craters,
    coma,
    ion,
    dust,
    tails: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** Writes the world-space vector of the encounter-frame vector `v` in `frame` into `out`, and returns it. */
export function frameToWorld(v: FrameVector, frame: Readonly<PlanetFrame>, out: Vec3): Vec3 {
  const { direction: d, side: s } = frame;
  // up = side × direction (as for planets and asteroids).
  const ux = s.y * d.z - s.z * d.y;
  const uy = s.z * d.x - s.x * d.z;
  const uz = s.x * d.y - s.y * d.x;
  const [a, b, c] = v;
  out.x = a * d.x + b * s.x + c * ux;
  out.y = a * d.y + b * s.y + c * uy;
  out.z = a * d.z + b * s.z + c * uz;
  return out;
}

/** Writes the direction toward the comet's sun in world space for `frame` into `out` (unit length), and returns it. */
export function cometLightDirection(frame: Readonly<PlanetFrame>, out: Vec3): Vec3 {
  return frameToWorld(cometSun(), frame, out);
}

/**
 * The glow mesh of a comet laid out in `frame` (see the module comment): the coma's sphere (radius
 * `params.radius`, `uv.y` 0) and, if `params.tails`, the ion tail's tube (`uv.y` 1) and the dust
 * tail's (`uv.y` 2), with `uv.x` the place along the tail (0 at the head, 1 at the end). Positions
 * are relative to the nucleus in world axes and world units; normals point out of each piece, and
 * every triangle winds counter-clockwise seen from outside, so the front faces cover each piece's
 * outline once. Attributes are the planet sphere's (`position`, `normal`, `uv`), so it draws with
 * the halo program the planets use. The caller owns the geometry and disposes it.
 */
export function cometGlowGeometry(params: Readonly<CometParams>, frame: Readonly<PlanetFrame> = DEFAULT_PLANET_FRAME): BufferGeometry {
  const sphere = new SphereGeometry(params.radius, COMET_COMA_SEGMENTS[0], COMET_COMA_SEGMENTS[1]);
  const spherePosition = sphere.getAttribute('position');
  const sphereNormal = sphere.getAttribute('normal');
  const sphereIndex = sphere.getIndex()!;
  const tails = params.tails ? [params.ion, params.dust] : [];
  const segments = COMET_TAIL_SEGMENTS;
  const sides = COMET_TAIL_SIDES;
  const tubeVertices = (segments + 1) * sides;
  const vertexCount = spherePosition.count + tails.length * tubeVertices;
  const indexCount = sphereIndex.count + tails.length * segments * sides * 6;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint16Array(indexCount);
  position.set(spherePosition.array as Float32Array);
  normal.set(sphereNormal.array as Float32Array);
  index.set(sphereIndex.array as ArrayLike<number>);
  sphere.dispose();

  const world = { x: 0, y: 0, z: 0 };
  let vertex = spherePosition.count;
  let at = sphereIndex.count;
  for (const [piece, tail] of tails.entries()) {
    const rings = cometTailRings(tail, segments, sides);
    const base = vertex;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const axis = cometTailPoint(tail, t);
      for (let j = 0; j < sides; j++) {
        const o = 3 * (i * sides + j);
        frameToWorld([rings[o]!, rings[o + 1]!, rings[o + 2]!], frame, world);
        position[3 * vertex] = world.x;
        position[3 * vertex + 1] = world.y;
        position[3 * vertex + 2] = world.z;
        frameToWorld([rings[o]! - axis[0], rings[o + 1]! - axis[1], rings[o + 2]! - axis[2]], frame, world);
        const l = Math.hypot(world.x, world.y, world.z);
        normal[3 * vertex] = world.x / l;
        normal[3 * vertex + 1] = world.y / l;
        normal[3 * vertex + 2] = world.z / l;
        uv[2 * vertex] = t;
        uv[2 * vertex + 1] = piece + 1;
        vertex++;
      }
    }
    // Two triangles per quad between rings i and i + 1, counter-clockwise seen from outside (each
    // ring goes round counter-clockwise about the tangent, which points from ring i to ring i + 1).
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < sides; j++) {
        const a = base + i * sides + j;
        const b = base + i * sides + ((j + 1) % sides);
        const c = a + sides;
        const d = b + sides;
        index[at++] = a;
        index[at++] = c;
        index[at++] = b;
        index[at++] = b;
        index[at++] = c;
        index[at++] = d;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------------------------
// Comet
// ---------------------------------------------------------------------------------------------

/** Converts an sRGB colour to a Three.js (linear working space) colour. */
function toColor(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

/**
 * Builds and disposes one comet, so the frame that creates the first comet of a run neither makes
 * the nucleus's unit icosphere (COMET_NUCLEUS_DETAIL) nor runs the builders' code for the first time
 * (as `prepareAsteroids` does for asteroids). The engine calls it at start-up. It makes no GPU
 * resource: the trial comet is never drawn or compiled, and its geometries and materials are
 * disposed at once.
 */
export function prepareComets(): void {
  new Comet(cometParams(0)).dispose();
}

export class Comet {
  readonly params: Readonly<CometParams>;
  /** Root object to add to the scene: at the nucleus, scaled by `setScale`'s factor. */
  readonly object = new Group();
  /** The nucleus (an irregular body, the rocky surface program). */
  readonly nucleus: Mesh<BufferGeometry, ShaderMaterial>;
  /** The coma and the tails (the halo program, additive). */
  readonly glow: Mesh<BufferGeometry, ShaderMaterial>;
  /** Fade and light direction, shared by the nucleus and the glow. */
  readonly uniforms: { uOpacity: { value: number }; uLightDir: { value: Vector3 } };
  /** The tails' unit directions at the head, in world space (the ion tail's is straight away from the sun). */
  readonly tailDirections: { ion: Vector3; dust: Vector3 };
  private readonly axis: Vector3;
  private disposed = false;

  /** `frame` is the encounter's (its planned direction and side), which the comet is laid out in. */
  constructor(params: Readonly<CometParams>, frame: Readonly<PlanetFrame> = DEFAULT_PLANET_FRAME) {
    this.params = params;
    const scratch = { x: 0, y: 0, z: 0 };
    const world = (v: FrameVector): Vector3 => {
      frameToWorld(v, frame, scratch);
      return new Vector3(scratch.x, scratch.y, scratch.z);
    };
    this.uniforms = { uOpacity: { value: 1 }, uLightDir: { value: world(params.sun).normalize() } };
    this.tailDirections = { ion: world(params.ion.direction), dust: world(params.dust.direction) };

    const [c0, c1, c2, c3] = params.palette;
    const surface = rockySurfaceMaterial({
      uColor0: { value: toColor(c0) },
      uColor1: { value: toColor(c1) },
      uColor2: { value: toColor(c2) },
      uColor3: { value: toColor(c3) },
      uNoiseScale: { value: params.noiseScale },
      uNoiseOffset: { value: new Vector3(...params.nucleus.noiseOffset) },
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
    });
    this.nucleus = new Mesh(irregularBodyGeometry(params.nucleus.shape), surface);
    this.nucleus.scale.setScalar(params.nucleus.radius);
    this.nucleus.renderOrder = SURFACE_RENDER_ORDER;

    const tail = (t: Readonly<CometTail>) => ({
      dir: world(t.direction),
      bend: world(t.bend),
      shape: new Vector4(t.length, t.angle, t.curvature, t.intensity),
      width: new Vector2(t.headWidth, t.endWidth),
      color: toColor(t.color),
    });
    const ion = tail(params.ion);
    const dust = tail(params.dust);
    const glow = cometGlowMaterial({
      uOpacity: this.uniforms.uOpacity,
      uLightDir: this.uniforms.uLightDir,
      uComaRadius: { value: params.radius },
      uComaIntensity: { value: params.coma.intensity },
      uComaColor: { value: toColor(params.coma.color) },
      uIonDir: { value: ion.dir },
      uIonBend: { value: ion.bend },
      uIonShape: { value: ion.shape },
      uIonWidth: { value: ion.width },
      uIonColor: { value: ion.color },
      uDustDir: { value: dust.dir },
      uDustBend: { value: dust.bend },
      uDustShape: { value: dust.shape },
      uDustWidth: { value: dust.width },
      uDustColor: { value: dust.color },
    });
    this.glow = new Mesh(cometGlowGeometry(params, frame), glow);
    this.glow.renderOrder = ATMOSPHERE_RENDER_ORDER;
    this.object.add(this.nucleus, this.glow);
    this.axis = new Vector3(...params.nucleus.tumbleAxis).normalize();
    this.update(0);
  }

  /** Sets the opacity in [0, 1] (the Autopilot's fade): the nucleus and the glow fade together. At 0 the comet is not drawn. */
  setFade(opacity: number): void {
    const o = Math.min(1, Math.max(0, opacity));
    this.uniforms.uOpacity.value = o;
    this.object.visible = o > 0;
  }

  /** Sets the size scale (the encounter's size scale) of the whole comet. */
  setScale(scale: number): void {
    this.object.scale.setScalar(scale);
  }

  /** Turns the nucleus to its tumble at `time` seconds. Allocates nothing. */
  update(time: number): void {
    const { nucleus } = this.params;
    this.nucleus.quaternion.setFromAxisAngle(this.axis, nucleus.tumblePhase + time * nucleus.tumbleSpeed);
  }

  /** Frees both geometries and both materials. Disposing twice is harmless. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    for (const mesh of [this.nucleus, this.glow]) {
      mesh.material.dispose();
      mesh.geometry.dispose();
    }
  }
}
