/**
 * Distant galaxies: rare, faint backdrops on the far layer (docs/PLAN.md section 6, Variety).
 *
 * They are not encounters: they are part of the sky, like the far stars (FarStarfield.ts), and they
 * follow its rules.
 *
 * - A trip has a seeded handful of them (0–3, GALAXY_COUNT_WEIGHTS), generated from the trip seed by
 *   `generateGalaxies`, so a seed reproduces them. Each is a spiral (a core glow and two faint,
 *   logarithmic arms) or an elliptical (a core glow in a smooth oval falloff), with a seeded
 *   direction, size, tilt (the axis ratio of its disc), rotation on the sky, colour and, for a
 *   spiral, arm winding and phase.
 * - Each galaxy's direction is fixed for the trip. They sit where the heading drift sweeps the view
 *   (GALAXY_PLACEMENT_MARGIN_RAD), so each comes into view during a drift cycle, at least
 *   GALAXY_MIN_SEPARATION_DEG apart.
 * - All galaxies are instances of one quad (InstancedBufferGeometry + ShaderMaterial): one draw call.
 *   Each quad is laid out in direction space, around the galaxy's unit direction, along two tangent
 *   axes whose lengths are the tangents of its half-sizes. Its angular size is therefore a property
 *   of the sky, not of pixels: it stays right whatever the field of view (a narrower one at
 *   ultra-wide aspects, for one), the aspect or the canvas size, and needs no resize uniform.
 * - The vertex shader turns every corner into view space with the rotation part of the view matrix
 *   only (`mat3(viewMatrix)`), like the far stars: there is no ship position (or offset) uniform, and
 *   the ship's travel never moves them. `galaxyViewCorner` is its TypeScript mirror. Nothing changes
 *   over time (no time uniform), so there is nothing to turn off under reduced motion, and nothing
 *   is uploaded or allocated per frame.
 * - Render order: the far stars' (FAR_STARFIELD_RENDER_ORDER), additively, at the far stars' depth
 *   just inside the far plane (FAR_STAR_NDC_DEPTH), depth-tested and without depth writes. They draw
 *   first with the far stars, so planet surfaces draw over them and hide them, and nebula layers and
 *   the near dust blend over them. They never hide anything.
 * - With no galaxy in the trip the mesh is hidden (`visible` false), so it is never drawn or
 *   compiled and costs nothing. With some it adds one geometry, one program and one draw call at
 *   cruise. Its program, like the far stars', compiles on the first frame, at start-up: it is part of
 *   the scene for the whole run and never freed, so it compiles once (it is not an encounter program,
 *   which ProgramWarmup keeps across encounters).
 */
import { AdditiveBlending, BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, type Matrix4 } from 'three';
import {
  GALAXY_CORE_BRIGHTNESS_MAX,
  GALAXY_CORE_BRIGHTNESS_MIN,
  GALAXY_COUNT_WEIGHTS,
  GALAXY_DISC_BRIGHTNESS_MAX,
  GALAXY_DISC_BRIGHTNESS_MIN,
  GALAXY_MIN_SEPARATION_DEG,
  GALAXY_PLACEMENT_MARGIN_RAD,
  GALAXY_SIZE_MAX_DEG,
  GALAXY_SIZE_MIN_DEG,
  GALAXY_SPIRAL_SHARE,
  SHIP_PITCH_DRIFT_AMPLITUDE_RAD,
  SHIP_YAW_DRIFT_AMPLITUDE_RAD,
} from '../config';
import { FAR_STARFIELD_RENDER_ORDER, FAR_STAR_NDC_DEPTH, farStarViewDirection } from './FarStarfield';
import { hash, mulberry32 } from './seed';
import type { Vec3 } from './Ship';

export type GalaxyType = 'spiral' | 'elliptical';

export interface Galaxy {
  type: GalaxyType;
  /** Unit direction of its centre (fixed for the trip). */
  direction: Vec3;
  /** Angular diameter along the major axis, in radians. */
  size: number;
  /** Minor over major axis, in (0, 1]: the tilt of its disc (1 is face-on). */
  axisRatio: number;
  /** Angle of the major axis on the sky, in radians, from the tangent axis `t1` (see `galaxyAxes`). */
  rotation: number;
  /** Arm winding of a spiral: how many radians an arm turns per unit of ln r; the sign is its handedness. 0 for an elliptical. */
  winding: number;
  /** Arm phase of a spiral, in radians. */
  armPhase: number;
  /** Core glow radius, as a share of the disc radius. */
  coreRadius: number;
  /** Core rgb: colour tint × peak brightness. */
  coreColor: readonly [number, number, number];
  /** Disc (arms or oval falloff) rgb: colour tint × peak brightness. */
  discColor: readonly [number, number, number];
}

export interface GalaxyOptions {
  /** Chance of 0, 1, 2, … galaxies (index = count). */
  countWeights: readonly number[];
  /** Angular diameter range along the major axis, in radians. */
  sizeMin: number;
  sizeMax: number;
  spiralShare: number;
  /** Largest |yaw| and |pitch| of a galaxy's direction from -Z, in radians. */
  yawRange: number;
  pitchRange: number;
  /** Smallest angle between two galaxies, in radians. */
  minSeparation: number;
  coreBrightnessMin: number;
  coreBrightnessMax: number;
  discBrightnessMin: number;
  discBrightnessMax: number;
}

const DEG = Math.PI / 180;

export const DEFAULT_GALAXY_OPTIONS: Readonly<GalaxyOptions> = {
  countWeights: GALAXY_COUNT_WEIGHTS,
  sizeMin: GALAXY_SIZE_MIN_DEG * DEG,
  sizeMax: GALAXY_SIZE_MAX_DEG * DEG,
  spiralShare: GALAXY_SPIRAL_SHARE,
  yawRange: SHIP_YAW_DRIFT_AMPLITUDE_RAD + GALAXY_PLACEMENT_MARGIN_RAD,
  pitchRange: SHIP_PITCH_DRIFT_AMPLITUDE_RAD + GALAXY_PLACEMENT_MARGIN_RAD,
  minSeparation: GALAXY_MIN_SEPARATION_DEG * DEG,
  coreBrightnessMin: GALAXY_CORE_BRIGHTNESS_MIN,
  coreBrightnessMax: GALAXY_CORE_BRIGHTNESS_MAX,
  discBrightnessMin: GALAXY_DISC_BRIGHTNESS_MIN,
  discBrightnessMax: GALAXY_DISC_BRIGHTNESS_MAX,
};

/**
 * Index of the trip seed's sequence that the galaxies take their seed from: `hash(tripSeed, this)`.
 * Encounter `i` uses index `i`, and no trip reaches this last uint32 index, so the galaxies never
 * share a seed with an encounter.
 */
export const GALAXY_SEED_INDEX = 0xffff_ffff;

/** Draws to try for each galaxy's direction before giving up on that galaxy (min separation). */
const PLACEMENT_TRIES = 32;

/** The galaxies' seed for a trip seed (a uint32). */
export function galaxySeed(tripSeed: number): number {
  return hash(tripSeed >>> 0, GALAXY_SEED_INDEX);
}

/** The count for `u`, uniform in [0, 1): each count covers a share of [0, 1) equal to its weight. */
export function galaxyCount(u: number, weights: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i]!;
    if (u < acc) return i;
  }
  return Math.max(0, weights.length - 1);
}

/** Core tint: a warm, old-star yellow-white. */
const CORE_TINT = [1.0, 0.9, 0.72] as const;
/** Disc tints: a spiral's young-star blue-white arms, an elliptical's warm halo. */
const SPIRAL_DISC_TINT = [0.72, 0.82, 1.0] as const;
const ELLIPTICAL_DISC_TINT = [1.0, 0.86, 0.66] as const;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A tint with a seeded lean toward warm (`lean` > 0) or cool (< 0), by at most 0.12 per channel,
 * keeping its brightest channel at 1, times `brightness`.
 */
function tinted(tint: readonly [number, number, number], lean: number, brightness: number): [number, number, number] {
  const r = tint[0] + 0.12 * lean;
  const g = tint[1];
  const b = tint[2] - 0.12 * lean;
  const peak = Math.max(r, g, b);
  return [(r / peak) * brightness, (g / peak) * brightness, (b / peak) * brightness];
}

/** The trip's galaxies, from its trip seed. Deterministic: the same seed gives the same galaxies. */
export function generateGalaxies(tripSeed: number, options: Readonly<GalaxyOptions> = DEFAULT_GALAXY_OPTIONS): Galaxy[] {
  const random = mulberry32(galaxySeed(tripSeed));
  const count = galaxyCount(random(), options.countWeights);
  const galaxies: Galaxy[] = [];
  const cosSeparation = Math.cos(options.minSeparation);
  for (let i = 0; i < count; i++) {
    // A direction where the heading drift sweeps the view, clear of the galaxies before it.
    let direction: Vec3 | null = null;
    for (let t = 0; t < PLACEMENT_TRIES && direction === null; t++) {
      const yaw = options.yawRange * (2 * random() - 1);
      const pitch = options.pitchRange * (2 * random() - 1);
      // The heading convention (Ship.ts headingAt): yaw about +Y, pitch up, from -Z.
      const d = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
      const clear = galaxies.every((g) => g.direction.x * d.x + g.direction.y * d.y + g.direction.z * d.z < cosSeparation);
      if (clear) direction = d;
    }
    if (direction === null) break;
    const type: GalaxyType = random() < options.spiralShare ? 'spiral' : 'elliptical';
    const s = random();
    const size = lerp(options.sizeMin, options.sizeMax, s * s);
    // A spiral's disc is seen at an inclination up to 75° (axis ratio cos i); an elliptical is a
    // rounder oval.
    const axisRatio = type === 'spiral' ? Math.cos(75 * DEG * random()) : lerp(0.5, 1, random());
    const rotation = Math.PI * random();
    const handedness = random() < 0.5 ? -1 : 1;
    const winding = type === 'spiral' ? handedness * lerp(1.5, 3, random()) : 0;
    const armPhase = 2 * Math.PI * random();
    const coreRadius = type === 'spiral' ? lerp(0.1, 0.16, random()) : lerp(0.16, 0.24, random());
    const lean = 2 * random() - 1;
    const coreColor = tinted(CORE_TINT, lean, lerp(options.coreBrightnessMin, options.coreBrightnessMax, random()));
    const discTint = type === 'spiral' ? SPIRAL_DISC_TINT : ELLIPTICAL_DISC_TINT;
    const discColor = tinted(discTint, lean, lerp(options.discBrightnessMin, options.discBrightnessMax, random()));
    galaxies.push({ type, direction, size, axisRatio, rotation, winding, armPhase, coreRadius, coreColor, discColor });
  }
  return galaxies;
}

/**
 * A galaxy's quad axes in direction space: `u` along its major axis and `v` along its minor axis,
 * both tangent to the unit sphere at its direction, with lengths tan(size / 2) and that × axisRatio.
 * The quad's corners are `direction ± u ± v`. The tangent frame is `t1` = up × direction (up = +Y)
 * and `t2` = t1 × direction, rotated by `rotation`. Then u × v points back along -direction, toward
 * the camera, so the quad's triangles wind counter-clockwise on screen: it is a front face, which
 * the material's default back-face culling keeps.
 */
export function galaxyAxes(galaxy: Readonly<Galaxy>): { u: Vec3; v: Vec3 } {
  const d = galaxy.direction;
  // up = +Y, or +X for a direction too close to the poles for a stable cross product.
  const up = Math.abs(d.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let ex = up.y * d.z - up.z * d.y;
  let ey = up.z * d.x - up.x * d.z;
  let ez = up.x * d.y - up.y * d.x;
  const el = Math.hypot(ex, ey, ez);
  ex /= el;
  ey /= el;
  ez /= el;
  const nx = ey * d.z - ez * d.y;
  const ny = ez * d.x - ex * d.z;
  const nz = ex * d.y - ey * d.x;
  const c = Math.cos(galaxy.rotation);
  const s = Math.sin(galaxy.rotation);
  const a = Math.tan(galaxy.size / 2);
  const b = a * galaxy.axisRatio;
  return {
    u: { x: a * (c * ex + s * nx), y: a * (c * ey + s * ny), z: a * (c * ez + s * nz) },
    v: { x: b * (c * nx - s * ex), y: b * (c * ny - s * ey), z: b * (c * nz - s * ez) },
  };
}

/**
 * TS mirror of the vertex shader's `mat3(viewMatrix) * (aDirection + position.x * aAxisU +
 * position.y * aAxisV)`: the quad corner (`cx`, `cy` in {-1, 1}) in view space, from the rotation
 * part of `viewMatrix` only (its translation is ignored). Writes into `out` and returns it.
 */
export function galaxyViewCorner(
  galaxy: Readonly<Galaxy>,
  cx: number,
  cy: number,
  viewMatrix: Readonly<Matrix4>,
  out: Vec3,
): Vec3 {
  const { u, v } = galaxyAxes(galaxy);
  const d = galaxy.direction;
  const corner = { x: d.x + cx * u.x + cy * v.x, y: d.y + cx * u.y + cy * v.y, z: d.z + cx * u.z + cy * v.z };
  return farStarViewDirection(corner, viewMatrix, out);
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const vertexShader = /* glsl */ `
uniform float uDepth;

// position.xy: a corner of the quad, each in {-1, 1}.
attribute vec3 aDirection;
attribute vec3 aAxisU;
attribute vec3 aAxisV;
// x: spiral arms on (1) or off (0), y: winding, z: arm phase, w: core radius.
attribute vec4 aShape;
attribute vec3 aCoreColor;
attribute vec3 aDiscColor;

// Position in the galaxy's own (face-on) disc, whose edge is at length 1.
varying vec2 vLocal;
varying vec4 vShape;
varying vec3 vCoreColor;
varying vec3 vDiscColor;

void main() {
  // Mirrored by galaxyViewCorner() in Galaxies.ts. Rotation only: the galaxies are at infinity, so
  // the camera's position (and the ship's travel) never moves them.
  vec3 center = mat3(viewMatrix) * aDirection;
  if (center.z > -0.1) {
    // Behind the camera (or far outside any field of view): collapse the quad.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocal = vec2(0.0);
    vShape = vec4(0.0);
    vCoreColor = vec3(0.0);
    vDiscColor = vec3(0.0);
    return;
  }
  vec3 dir = mat3(viewMatrix) * (aDirection + position.x * aAxisU + position.y * aAxisV);
  vec4 clip = projectionMatrix * vec4(dir, 1.0);
  // At the far stars' depth, just inside the far plane.
  gl_Position = vec4(clip.xy, uDepth * clip.w, clip.w);
  vLocal = position.xy;
  vShape = aShape;
  vCoreColor = aCoreColor;
  vDiscColor = aDiscColor;
}
`;

const fragmentShader = /* glsl */ `
varying vec2 vLocal;
varying vec4 vShape;
varying vec3 vCoreColor;
varying vec3 vDiscColor;

void main() {
  float r = length(vLocal);
  if (r >= 1.0) discard;
  float arms = vShape.x;
  float coreRadius = vShape.w;
  // Fades to nothing at the quad's edge, so it has no visible outline.
  float edge = 1.0 - smoothstep(0.45, 1.0, r);
  float core = exp(-(r * r) / (coreRadius * coreRadius));
  // A spiral's exponential disc, or an elliptical's smoother oval falloff.
  float disc = mix(exp(-5.0 * r * r), exp(-3.5 * r), arms) * edge;
  // Two logarithmic arms (crests where 2 (theta + winding ln r) + phase = 0 mod 2 pi), brightening
  // the disc along them and darkening it between, from just outside the core.
  // atan(0, 0) is undefined in GLSL ES; the small x offset keeps the centre pixel defined.
  float theta = atan(vLocal.y, vLocal.x + 1e-6);
  float wave = 0.5 + 0.5 * cos(2.0 * (theta + vShape.y * log(max(r, 0.02))) + vShape.z);
  float armLight = mix(1.0, 0.2 + 1.6 * wave * wave, arms * smoothstep(0.05, 0.3, r));
  gl_FragColor = vec4(vCoreColor * core + vDiscColor * disc * armLight, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Galaxies
// ---------------------------------------------------------------------------------------------

export interface GalaxyUniforms {
  [name: string]: { value: unknown };
  uDepth: { value: number };
}

export class Galaxies {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly uniforms: GalaxyUniforms;
  /** The galaxies drawn (read-only view; do not modify). */
  readonly galaxies: readonly Galaxy[];

  constructor(galaxies: readonly Galaxy[]) {
    this.galaxies = galaxies;
    const n = galaxies.length;
    const directions = new Float32Array(n * 3);
    const axesU = new Float32Array(n * 3);
    const axesV = new Float32Array(n * 3);
    const shapes = new Float32Array(n * 4);
    const coreColors = new Float32Array(n * 3);
    const discColors = new Float32Array(n * 3);
    galaxies.forEach((g, i) => {
      const { u, v } = galaxyAxes(g);
      directions.set([g.direction.x, g.direction.y, g.direction.z], i * 3);
      axesU.set([u.x, u.y, u.z], i * 3);
      axesV.set([v.x, v.y, v.z], i * 3);
      shapes.set([g.type === 'spiral' ? 1 : 0, g.winding, g.armPhase, g.coreRadius], i * 4);
      coreColors.set(g.coreColor, i * 3);
      discColors.set(g.discColor, i * 3);
    });

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aDirection', new InstancedBufferAttribute(directions, 3));
    geometry.setAttribute('aAxisU', new InstancedBufferAttribute(axesU, 3));
    geometry.setAttribute('aAxisV', new InstancedBufferAttribute(axesV, 3));
    geometry.setAttribute('aShape', new InstancedBufferAttribute(shapes, 4));
    geometry.setAttribute('aCoreColor', new InstancedBufferAttribute(coreColors, 3));
    geometry.setAttribute('aDiscColor', new InstancedBufferAttribute(discColors, 3));
    geometry.instanceCount = n;

    this.uniforms = { uDepth: { value: FAR_STAR_NDC_DEPTH } };

    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      // With the far stars, behind everything and drawn first: never writes depth, so it never hides anything.
      depthTest: true,
      depthWrite: false,
    });

    this.mesh = new Mesh(geometry, material);
    this.mesh.renderOrder = FAR_STARFIELD_RENDER_ORDER;
    // Placed in the shader from the view rotation, so the geometry's bounds mean nothing.
    this.mesh.frustumCulled = false;
    // No galaxy, nothing to draw or compile.
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
