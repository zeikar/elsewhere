/**
 * Far stars: the fixed backdrop of the sky (docs/PLAN.md section 6, Starfield).
 *
 * The near starfield (Starfield.ts) is dust and near stars in a wrapped cube around the camera: it
 * streams past with the ship's travel and gives the sense of speed. This is the other layer, stars
 * at effectively infinite distance, so the planets and nebulae have a stable reference to be seen
 * against.
 *
 * - Each star is a fixed, seeded direction on the unit sphere, an instance of one quad
 *   (InstancedBufferGeometry + ShaderMaterial, like the near layer; no Points or Lines).
 * - The vertex shader turns the direction into view space with the rotation part of the view matrix
 *   only (`mat3(viewMatrix)`), so the far stars turn with the camera and nothing else: there is no
 *   ship position (or offset) uniform at all, and the ship's travel never moves them (no parallax).
 *   `farStarViewDirection` is its TypeScript mirror.
 * - Stars are always round dots of a fixed pixel size (no streaks, no growth, no distance dimming),
 *   multiplied by the applied DPR (a uniform, updated on resize).
 * - They are brighter than the near dust, with a heavier bright tail so a few stand out, and a subtle
 *   colour temperature (blue-white, white, yellow-white, yellow, orange: FAR_STAR_TINTS), so they
 *   read as the sky. The brightness never changes over time (no twinkle), so there is nothing to
 *   turn off under reduced motion.
 * - Nothing is uploaded or allocated per frame; there is no per-frame update at all.
 * - Render order (the contract in Starfield.ts): the far layer draws first of everything
 *   (FAR_STARFIELD_RENDER_ORDER), additively, just inside the far plane, depth-tested and without
 *   depth writes, so it never hides anything. Planet surfaces draw over it and hide the stars behind
 *   them, and nebula layers blend over it.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  type Matrix4,
} from 'three';
import {
  FAR_STAR_BASE_SIZE_PX,
  FAR_STAR_BRIGHTNESS_EXPONENT,
  FAR_STAR_BRIGHTNESS_MAX,
  FAR_STAR_BRIGHTNESS_MIN,
  FAR_STAR_COUNT,
  FAR_STAR_SEED,
  FAR_STAR_SIZE_MAX,
  FAR_STAR_SIZE_MIN,
} from '../config';
import type { RenderSize } from './renderSize';
import { mulberry32 } from './seed';
import type { Vec3 } from './Ship';
import { STARFIELD_RENDER_ORDER, resizeUniformValues } from './Starfield';

export interface FarStarfieldOptions {
  count: number;
  /** Star width in CSS pixels before the per-star size factor. */
  baseSizePx: number;
  sizeMin: number;
  sizeMax: number;
  /** Brightness = brightnessMin + (brightnessMax - brightnessMin) × u^brightnessExponent, u uniform. */
  brightnessMin: number;
  brightnessMax: number;
  brightnessExponent: number;
  seed: number;
}

export const DEFAULT_FAR_STARFIELD_OPTIONS: Readonly<FarStarfieldOptions> = {
  count: FAR_STAR_COUNT,
  baseSizePx: FAR_STAR_BASE_SIZE_PX,
  sizeMin: FAR_STAR_SIZE_MIN,
  sizeMax: FAR_STAR_SIZE_MAX,
  brightnessMin: FAR_STAR_BRIGHTNESS_MIN,
  brightnessMax: FAR_STAR_BRIGHTNESS_MAX,
  brightnessExponent: FAR_STAR_BRIGHTNESS_EXPONENT,
  seed: FAR_STAR_SEED,
};

/**
 * The far layer's render order: below everything else (planet surfaces and nebula layers draw at
 * STARFIELD_RENDER_ORDER - 1), so it is drawn first and everything else draws over it.
 */
export const FAR_STARFIELD_RENDER_ORDER = STARFIELD_RENDER_ORDER - 2;

/**
 * Normalised-device depth the far stars are drawn at: just inside the far plane, behind anything
 * the camera can see, so they would fail the depth test against any depth-writing object even if
 * they were drawn after it.
 */
export const FAR_STAR_NDC_DEPTH = 0.999999;

// ---------------------------------------------------------------------------------------------
// Pure CPU-side maths
// ---------------------------------------------------------------------------------------------

/** A far-star colour tint and the share of the stars that get it. */
export interface FarStarTint {
  rgb: readonly [number, number, number];
  weight: number;
}

/**
 * The far stars' colour temperatures, coolest first, with their shares (the weights sum to 1).
 * Subtle, but stronger than the near dust's: every tint keeps its brightest channel at 1, so it
 * changes the hue and not the brightness.
 */
export const FAR_STAR_TINTS: readonly FarStarTint[] = [
  { rgb: [0.7, 0.8, 1.0], weight: 0.2 }, // blue-white
  { rgb: [1.0, 1.0, 1.0], weight: 0.3 }, // white
  { rgb: [1.0, 0.95, 0.82], weight: 0.2 }, // yellow-white
  { rgb: [1.0, 0.87, 0.62], weight: 0.17 }, // yellow
  { rgb: [1.0, 0.74, 0.48], weight: 0.13 }, // orange
];

/** The tint for `u`, uniform in [0, 1): each tint covers a share of [0, 1) equal to its weight. */
export function farStarTint(u: number): readonly [number, number, number] {
  let acc = 0;
  for (const tint of FAR_STAR_TINTS) {
    acc += tint.weight;
    if (u < acc) return tint.rgb;
  }
  return FAR_STAR_TINTS[FAR_STAR_TINTS.length - 1]!.rgb;
}

export interface FarStarData {
  /** Unit direction xyz per star. */
  directions: Float32Array;
  /** Size factor per star, in [sizeMin, sizeMax]. */
  sizes: Float32Array;
  /** rgb per star: colour tint × brightness. */
  colors: Float32Array;
}

/** Generates the fixed far-star layout: directions uniform on the unit sphere, sizes and colours. */
export function generateFarStars(options: Readonly<FarStarfieldOptions>): FarStarData {
  const { count, sizeMin, sizeMax, brightnessMin, brightnessMax, brightnessExponent } = options;
  const random = mulberry32(options.seed);
  const directions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: z uniform in [-1, 1], longitude uniform.
    const z = 2 * random() - 1;
    const phi = 2 * Math.PI * random();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    directions[i * 3] = r * Math.cos(phi);
    directions[i * 3 + 1] = r * Math.sin(phi);
    directions[i * 3 + 2] = z;
    // Mostly small stars with a few larger ones.
    const s = random();
    sizes[i] = sizeMin + (sizeMax - sizeMin) * s * s * s;
    // Mostly faint stars with a bright tail.
    const brightness = brightnessMin + (brightnessMax - brightnessMin) * random() ** brightnessExponent;
    const tint = farStarTint(random());
    colors[i * 3] = tint[0] * brightness;
    colors[i * 3 + 1] = tint[1] * brightness;
    colors[i * 3 + 2] = tint[2] * brightness;
  }
  return { directions, sizes, colors };
}

/**
 * TS mirror of the vertex shader's `mat3(viewMatrix) * direction`: the star's direction in view
 * space, from the rotation part of `viewMatrix` only (its translation is ignored). Writes into `out`
 * and returns it.
 */
export function farStarViewDirection(direction: Readonly<Vec3>, viewMatrix: Readonly<Matrix4>, out: Vec3): Vec3 {
  // Column-major, like GLSL: mat3(m) takes the upper-left 3×3.
  const e = viewMatrix.elements;
  const { x, y, z } = direction;
  out.x = e[0]! * x + e[4]! * y + e[8]! * z;
  out.y = e[1]! * x + e[5]! * y + e[9]! * z;
  out.z = e[2]! * x + e[6]! * y + e[10]! * z;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const vertexShader = /* glsl */ `
uniform vec2 uViewport;
uniform float uPixelSize;
uniform float uDepth;

// position.xy: a corner of the quad, each in {-1, 1}.
attribute vec3 aDirection;
attribute float aSize;
attribute vec3 aColor;

// Fragment position relative to the star centre, in device pixels.
varying vec2 vLocal;
varying float vRadius;
varying vec3 vColor;

void main() {
  // Mirrored by farStarViewDirection() in FarStarfield.ts. Rotation only: the stars are at infinity,
  // so the camera's position (and the ship's travel) never moves them.
  vec3 dir = mat3(viewMatrix) * aDirection;
  if (dir.z > -1e-3) {
    // Behind the camera (or at 90° to it, far outside any field of view): collapse the quad.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocal = vec2(0.0);
    vRadius = 0.0;
    vColor = vec3(0.0);
    return;
  }
  vec4 clip = projectionMatrix * vec4(dir, 1.0);
  vec2 halfViewport = 0.5 * uViewport;
  vec2 centerPx = clip.xy / clip.w * halfViewport;
  float radius = 0.5 * uPixelSize * aSize;
  // One device pixel of margin for the soft edge.
  vec2 local = position.xy * (radius + 1.0);
  gl_Position = vec4((centerPx + local) / halfViewport, uDepth, 1.0);
  vLocal = local;
  vRadius = radius;
  vColor = aColor;
}
`;

const fragmentShader = /* glsl */ `
varying vec2 vLocal;
varying float vRadius;
varying vec3 vColor;

void main() {
  // A round dot with a soft edge about one device pixel wide, like a still near star.
  float alpha = 1.0 - smoothstep(max(vRadius - 0.6, 0.0), vRadius + 0.6, length(vLocal));
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(vColor * alpha, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// FarStarfield
// ---------------------------------------------------------------------------------------------

export interface FarStarfieldUniforms {
  [name: string]: { value: unknown };
  uViewport: { value: Vector2 };
  uDpr: { value: number };
  uPixelSize: { value: number };
  uDepth: { value: number };
}

export class FarStarfield {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly uniforms: FarStarfieldUniforms;
  private readonly options: Readonly<FarStarfieldOptions>;

  constructor(options: Readonly<FarStarfieldOptions> = DEFAULT_FAR_STARFIELD_OPTIONS) {
    this.options = options;
    const stars = generateFarStars(options);

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aDirection', new InstancedBufferAttribute(stars.directions, 3));
    geometry.setAttribute('aSize', new InstancedBufferAttribute(stars.sizes, 1));
    geometry.setAttribute('aColor', new InstancedBufferAttribute(stars.colors, 3));
    geometry.instanceCount = options.count;

    this.uniforms = {
      uViewport: { value: new Vector2(1, 1) },
      uDpr: { value: 1 },
      uPixelSize: { value: options.baseSizePx },
      uDepth: { value: FAR_STAR_NDC_DEPTH },
    };

    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      // Behind everything and drawn first: never writes depth, so it never hides anything.
      depthTest: true,
      depthWrite: false,
    });

    this.mesh = new Mesh(geometry, material);
    this.mesh.renderOrder = FAR_STARFIELD_RENDER_ORDER;
    // Placed in the shader from the view rotation, so the geometry's bounds mean nothing.
    this.mesh.frustumCulled = false;
  }

  /** Applies a new render size: applied DPR, pixel size and drawing-buffer size. */
  setRenderSize(size: Readonly<RenderSize>): void {
    const values = resizeUniformValues(size, this.options.baseSizePx);
    this.uniforms.uDpr.value = values.dpr;
    this.uniforms.uPixelSize.value = values.pixelSize;
    this.uniforms.uViewport.value.set(values.viewportWidth, values.viewportHeight);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
