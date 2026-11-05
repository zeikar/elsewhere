/**
 * Starfield: the near layer of the sky, one instanced quad per star, speed-driven streaks, wrapping
 * and fading (docs/PLAN.md section 6, Starfield).
 *
 * The sky has two layers. This one is fine dust and near stars in a cube around the camera: they
 * stream past with the ship's travel and carry the sense of speed ("stars rush toward the camera",
 * docs/PLAN.md section 4). They are faint, small and nearly colourless dust, with an occasional
 * brighter mote, so they read as dimmer than the far stars and carry the speed mostly through the
 * length of their streaks. The other, FarStarfield.ts, is stars at infinity that only turn with the
 * camera: the fixed backdrop, drawn brighter and with a subtle colour temperature.
 *
 * - Each star is an instance of one quad (InstancedBufferGeometry + ShaderMaterial); no Points or
 *   Lines. The vertex shader projects the head and the tail (head + ship velocity × streak time) and
 *   builds a screen-space capsule joining them: width is the star size, and a still star (zero
 *   length) is a round dot. The fragment shader gives both ends soft round caps.
 * - The tail depends on the velocity only, so streaks follow translation and ignore rotation.
 * - Pixel sizes are multiplied by the applied DPR (a uniform, updated on resize).
 * - Star positions are fixed in a GPU buffer inside a cube of side L. The shader wraps them with
 *   mod(position - offset, L), where offset = ship position mod L is computed here in float64, so
 *   large travel coordinates never reach the GPU and nothing is uploaded or allocated per frame.
 * - Stars fade out near the cube boundary and right in front of the camera, so wrapping never makes
 *   a star pop in or out.
 * - Each star is drawn at its head's depth with depth testing on and depth writes off, so it never
 *   hides anything but is hidden by depth-writing scenery in front of it.
 *
 * Render order, for everything in the scene (all of it is in Three.js' transparent list, which draws
 * in ascending renderOrder):
 *
 * 1. FAR_STARFIELD_RENDER_ORDER (-2): the far stars, additive, just inside the far plane, no depth
 *    writes. Drawn first, so they never hide anything, and everything below draws over them.
 * 2. STARFIELD_RENDER_ORDER - 1 (-1): planet surfaces (SURFACE_RENDER_ORDER), which write depth and
 *    paint over the far stars behind them; and nebula layers (NEBULA_RENDER_ORDER), which blend over
 *    the far stars without writing depth. One encounter is in the scene at a time, so the two never
 *    meet.
 * 3. STARFIELD_RENDER_ORDER (0): this near layer, additive, depth-tested against the planet surface,
 *    so near stars behind a planet are hidden and those in front of it still show.
 * 4. STARFIELD_RENDER_ORDER + 1 (+1): planet atmospheres (ATMOSPHERE_RENDER_ORDER), additive.
 *
 * The CPU-side maths is exported as pure functions (with TS mirrors of the shader's wrap and fade)
 * so it can be tested without WebGL.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import {
  CAMERA_NEAR,
  STAR_BASE_SIZE_PX,
  STAR_BRIGHTNESS_MAX,
  STAR_BRIGHTNESS_MIN,
  STAR_COUNT,
  STAR_CUBE_SIZE,
  STAR_DIM_DISTANCE,
  STAR_EDGE_FADE_WIDTH,
  STAR_GROWTH_DISTANCE,
  STAR_MAX_GROWTH,
  STAR_MAX_STREAK_PX,
  STAR_MOTE_BRIGHTNESS_MAX,
  STAR_MOTE_FRACTION,
  STAR_NEAR_FADE_DISTANCE,
  STAR_SEED,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
  STAR_STREAK_TIME_SECONDS,
  STAR_TINT_STRENGTH,
} from '../config';
import type { RenderSize } from './renderSize';
import { mulberry32 } from './seed';
import type { ShipState, Vec3 } from './Ship';

export interface StarfieldOptions {
  count: number;
  /** Cube side L, in world units. */
  cubeSize: number;
  streakTime: number;
  /** Star width in CSS pixels before the per-star size factor. */
  baseSizePx: number;
  sizeMin: number;
  sizeMax: number;
  /** Dust brightness range (all but the motes), skewed toward brightnessMin. */
  brightnessMin: number;
  brightnessMax: number;
  /** Fraction of the stars that are brighter motes, from brightnessMax up to moteBrightnessMax. */
  moteFraction: number;
  moteBrightnessMax: number;
  /** How much of STAR_TINTS the stars keep: 0 is grey, 1 the full tint. */
  tintStrength: number;
  edgeFadeWidth: number;
  nearFadeDistance: number;
  dimDistance: number;
  growthDistance: number;
  maxGrowth: number;
  maxStreakPx: number;
  /** Camera near plane; streak tails are clipped to it. */
  near: number;
  seed: number;
}

export const DEFAULT_STARFIELD_OPTIONS: Readonly<StarfieldOptions> = {
  count: STAR_COUNT,
  cubeSize: STAR_CUBE_SIZE,
  streakTime: STAR_STREAK_TIME_SECONDS,
  baseSizePx: STAR_BASE_SIZE_PX,
  sizeMin: STAR_SIZE_MIN,
  sizeMax: STAR_SIZE_MAX,
  brightnessMin: STAR_BRIGHTNESS_MIN,
  brightnessMax: STAR_BRIGHTNESS_MAX,
  moteFraction: STAR_MOTE_FRACTION,
  moteBrightnessMax: STAR_MOTE_BRIGHTNESS_MAX,
  tintStrength: STAR_TINT_STRENGTH,
  edgeFadeWidth: STAR_EDGE_FADE_WIDTH,
  nearFadeDistance: STAR_NEAR_FADE_DISTANCE,
  dimDistance: STAR_DIM_DISTANCE,
  growthDistance: STAR_GROWTH_DISTANCE,
  maxGrowth: STAR_MAX_GROWTH,
  maxStreakPx: STAR_MAX_STREAK_PX,
  near: CAMERA_NEAR,
  seed: STAR_SEED,
};

// ---------------------------------------------------------------------------------------------
// Pure CPU-side maths
// ---------------------------------------------------------------------------------------------

/**
 * `value mod size` in [0, size), computed in float64. Works for negative and very large values
 * (JS `%` is exact; the second `%` folds the negative branch back into range).
 */
export function wrapCoordinate(value: number, size: number): number {
  const r = ((value % size) + size) % size;
  // (tiny negative) + size can round to exactly `size`.
  return r >= size ? 0 : r;
}

/** Writes `position mod size` per component into `out` and returns it. This is the shader's offset. */
export function computeWrapOffset(position: Readonly<Vec3>, size: number, out: Vec3): Vec3 {
  out.x = wrapCoordinate(position.x, size);
  out.y = wrapCoordinate(position.y, size);
  out.z = wrapCoordinate(position.z, size);
  return out;
}

/** GLSL `mod(x, y)` = x - y·floor(x / y). */
function glslMod(x: number, y: number): number {
  return x - y * Math.floor(x / y);
}

/**
 * TS mirror of the shader's wrap for one coordinate: the star's position relative to the camera,
 * `mod(star - offset, L) - L/2`, in [-L/2, L/2). `star` is the fixed buffer coordinate in [0, L).
 */
export function wrapStarCoordinate(star: number, offset: number, size: number): number {
  return glslMod(star - offset, size) - 0.5 * size;
}

/** GLSL `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export interface FadeParams {
  cubeSize: number;
  edgeFadeWidth: number;
  nearFadeDistance: number;
}

/**
 * TS mirror of the shader's `starFade`: 0 on the cube boundary and at the camera, 1 in the interior.
 * (x, y, z) is the wrapped position relative to the camera.
 */
export function starFade(x: number, y: number, z: number, params: Readonly<FadeParams>): number {
  const half = 0.5 * params.cubeSize;
  const toBoundary = half - Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  const edge = smoothstep(0, params.edgeFadeWidth, toBoundary);
  const near = smoothstep(0, params.nearFadeDistance, Math.hypot(x, y, z));
  return edge * near;
}

/**
 * TS mirror of the shader's distance dimming: brightness × 1 / (1 + (distance / dimDistance)²).
 * The far stars have none.
 */
export function starDim(distance: number, dimDistance: number): number {
  const r = distance / dimDistance;
  return 1 / (1 + r * r);
}

/** Uniform values that depend on the render size. */
export interface ResizeUniformValues {
  /** Applied DPR. */
  dpr: number;
  /** Base star width in device pixels: baseSizePx × applied DPR. */
  pixelSize: number;
  /** Drawing-buffer size in device pixels. */
  viewportWidth: number;
  viewportHeight: number;
}

export function resizeUniformValues(size: Readonly<RenderSize>, baseSizePx: number): ResizeUniformValues {
  return {
    dpr: size.dpr,
    pixelSize: baseSizePx * size.dpr,
    viewportWidth: size.width,
    viewportHeight: size.height,
  };
}

export interface StarData {
  /** xyz per star, in [0, cubeSize). */
  positions: Float32Array;
  /** Size factor per star, in [sizeMin, sizeMax]. */
  sizes: Float32Array;
  /** rgb per star: colour tint × brightness. */
  colors: Float32Array;
}

/**
 * Star colour tints, from blue-white through white to warm. The near layer keeps only
 * STAR_TINT_STRENGTH of them, so the dust is nearly neutral; the far layer has its own, stronger
 * tints (FAR_STAR_TINTS in FarStarfield.ts).
 */
export const STAR_TINTS: readonly (readonly [number, number, number])[] = [
  [0.72, 0.82, 1.0],
  [0.86, 0.91, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.95, 0.86],
  [1.0, 0.84, 0.68],
];

export type BrightnessParams = Pick<StarfieldOptions, 'brightnessMin' | 'brightnessMax' | 'moteFraction' | 'moteBrightnessMax'>;

/**
 * A star's brightness from `u`, uniform in [0, 1): increasing and continuous. The first
 * 1 - moteFraction of the range is dust, from brightnessMin to brightnessMax and skewed toward the
 * dim end (quadratic); the rest is the brighter motes, linear from brightnessMax to moteBrightnessMax.
 */
export function nearStarBrightness(u: number, params: Readonly<BrightnessParams>): number {
  const { brightnessMin, brightnessMax, moteFraction, moteBrightnessMax } = params;
  const dust = 1 - moteFraction;
  if (u < dust) {
    const t = u / dust;
    return brightnessMin + (brightnessMax - brightnessMin) * t * t;
  }
  return brightnessMax + (moteBrightnessMax - brightnessMax) * ((u - dust) / moteFraction);
}

/** Generates the fixed star layout: positions, size factors and colours. */
export function generateStars(options: Readonly<StarfieldOptions>): StarData {
  const { count, cubeSize, sizeMin, sizeMax, tintStrength } = options;
  const random = mulberry32(options.seed);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = random() * cubeSize;
    positions[i * 3 + 1] = random() * cubeSize;
    positions[i * 3 + 2] = random() * cubeSize;
    // Mostly small stars with a few larger ones.
    const s = random();
    sizes[i] = sizeMin + (sizeMax - sizeMin) * s * s * s;
    // Mostly faint dust, with a few brighter motes.
    const brightness = nearStarBrightness(random(), options);
    // Nearly neutral: a faint trace of the blue and warm tints.
    const tint = STAR_TINTS[Math.min(STAR_TINTS.length - 1, Math.floor(random() * STAR_TINTS.length))] ?? [1, 1, 1];
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = (1 + (tint[c]! - 1) * tintStrength) * brightness;
  }
  return { positions, sizes, colors };
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const vertexShader = /* glsl */ `
uniform vec3 uOffset;
uniform float uCubeSize;
uniform vec3 uVelocity;
uniform float uStreakTime;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uPixelSize;
uniform float uMaxStreakPx;
uniform float uEdgeFadeWidth;
uniform float uNearFadeDistance;
uniform float uDimDistance;
uniform float uGrowthDistance;
uniform float uMaxGrowth;
uniform float uNear;

// position.x: 0 at the head end of the quad, 1 at the tail end. position.y: -1 or 1 across it.
attribute vec3 aStar;
attribute float aSize;
attribute vec3 aColor;

// Fragment position in device pixels: x along the streak from the head, y across it.
varying vec2 vLocal;
varying float vLength;
varying float vRadius;
varying vec3 vColor;

// Mirrored by starFade() in Starfield.ts.
float starFade(vec3 rel) {
  vec3 a = abs(rel);
  float toBoundary = 0.5 * uCubeSize - max(a.x, max(a.y, a.z));
  float edge = smoothstep(0.0, uEdgeFadeWidth, toBoundary);
  float near = smoothstep(0.0, uNearFadeDistance, length(rel));
  return edge * near;
}

void main() {
  // Mirrored by wrapStarCoordinate() in Starfield.ts. Relative to the camera, in [-L/2, L/2).
  vec3 rel = mod(aStar - uOffset, uCubeSize) - 0.5 * uCubeSize;
  float fade = starFade(rel);

  vec4 headView = modelViewMatrix * vec4(rel, 1.0);
  vec4 tailView = modelViewMatrix * vec4(rel + uVelocity * uStreakTime, 1.0);
  float clipZ = -uNear * 1.001;

  if (fade <= 0.0 || headView.z > clipZ) {
    // Invisible or behind the camera: collapse the quad outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLocal = vec2(0.0);
    vLength = 0.0;
    vRadius = 0.0;
    vColor = vec3(0.0);
    return;
  }
  if (tailView.z > clipZ) {
    tailView = mix(headView, tailView, (clipZ - headView.z) / (tailView.z - headView.z));
  }

  vec4 headClip = projectionMatrix * headView;
  vec4 tailClip = projectionMatrix * tailView;
  vec2 halfViewport = 0.5 * uViewport;
  vec2 headPx = headClip.xy / headClip.w * halfViewport;
  vec2 tailPx = tailClip.xy / tailClip.w * halfViewport;
  vec2 seg = tailPx - headPx;
  float len = length(seg);
  vec2 dir = len > 1e-4 ? seg / len : vec2(1.0, 0.0);
  len = min(len, uMaxStreakPx * uDpr);

  float dist = length(rel);
  float growth = clamp(uGrowthDistance / max(dist, 1e-3), 1.0, uMaxGrowth);
  float radius = 0.5 * uPixelSize * aSize * growth;
  // One device pixel of margin for the soft edge.
  float extent = radius + 1.0;

  float along = mix(-extent, len + extent, position.x);
  float across = position.y * extent;
  vec2 px = headPx + dir * along + vec2(-dir.y, dir.x) * across;
  gl_Position = vec4(px / halfViewport, clamp(headClip.z / headClip.w, -1.0, 1.0), 1.0);

  vLocal = vec2(along, across);
  vLength = len;
  vRadius = radius;
  // Mirrored by starDim() in Starfield.ts.
  float dim = 1.0 / (1.0 + (dist / uDimDistance) * (dist / uDimDistance));
  vColor = aColor * fade * dim;
}
`;

const fragmentShader = /* glsl */ `
varying vec2 vLocal;
varying float vLength;
varying float vRadius;
varying vec3 vColor;

void main() {
  // Distance in device pixels to the head-tail segment: a capsule with round caps at both ends.
  float d = length(vec2(vLocal.x - clamp(vLocal.x, 0.0, vLength), vLocal.y));
  // Soft edge about one device pixel wide, so small stars stay crisp but never blocky.
  float alpha = 1.0 - smoothstep(max(vRadius - 0.6, 0.0), vRadius + 0.6, d);
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(vColor * alpha, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Starfield
// ---------------------------------------------------------------------------------------------

/**
 * The near starfield's render order (the full order is in the module comment). Depth-writing objects
 * that should hide the stars behind them use a lower value, so their depth is in the buffer when the
 * stars are depth-tested. The far stars (FarStarfield.ts) use a lower value still.
 */
export const STARFIELD_RENDER_ORDER = 0;

export interface StarfieldUniforms {
  [name: string]: { value: unknown };
  uOffset: { value: Vector3 };
  uCubeSize: { value: number };
  uVelocity: { value: Vector3 };
  uStreakTime: { value: number };
  uViewport: { value: Vector2 };
  uDpr: { value: number };
  uPixelSize: { value: number };
  uMaxStreakPx: { value: number };
  uEdgeFadeWidth: { value: number };
  uNearFadeDistance: { value: number };
  uDimDistance: { value: number };
  uGrowthDistance: { value: number };
  uMaxGrowth: { value: number };
  uNear: { value: number };
}

export class Starfield {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly uniforms: StarfieldUniforms;
  private readonly options: Readonly<StarfieldOptions>;
  /** Scratch float64 offset, reused every frame. */
  private readonly offset: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(options: Readonly<StarfieldOptions> = DEFAULT_STARFIELD_OPTIONS) {
    this.options = options;
    const stars = generateStars(options);

    const geometry = new InstancedBufferGeometry();
    // One quad: x = 0 (head end) / 1 (tail end), y = -1 / 1 across.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aStar', new InstancedBufferAttribute(stars.positions, 3));
    geometry.setAttribute('aSize', new InstancedBufferAttribute(stars.sizes, 1));
    geometry.setAttribute('aColor', new InstancedBufferAttribute(stars.colors, 3));
    geometry.instanceCount = options.count;

    this.uniforms = {
      uOffset: { value: new Vector3() },
      uCubeSize: { value: options.cubeSize },
      uVelocity: { value: new Vector3() },
      uStreakTime: { value: options.streakTime },
      uViewport: { value: new Vector2(1, 1) },
      uDpr: { value: 1 },
      uPixelSize: { value: options.baseSizePx },
      uMaxStreakPx: { value: options.maxStreakPx },
      uEdgeFadeWidth: { value: options.edgeFadeWidth },
      uNearFadeDistance: { value: options.nearFadeDistance },
      uDimDistance: { value: options.dimDistance },
      uGrowthDistance: { value: options.growthDistance },
      uMaxGrowth: { value: options.maxGrowth },
      uNear: { value: options.near },
    };

    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: AdditiveBlending,
      // Tested against depth written earlier in the frame (planet surfaces), never written.
      depthTest: true,
      depthWrite: false,
    });

    this.mesh = new Mesh(geometry, material);
    this.mesh.renderOrder = STARFIELD_RENDER_ORDER;
    // Positions are wrapped in the shader, so the geometry's bounds mean nothing.
    this.mesh.frustumCulled = false;
  }

  /** Per-frame update from the ship: wrap offset (float64 mod L) and velocity. Allocates nothing. */
  update(ship: Readonly<Pick<ShipState, 'position' | 'velocity'>>): void {
    const o = computeWrapOffset(ship.position, this.options.cubeSize, this.offset);
    this.uniforms.uOffset.value.set(o.x, o.y, o.z);
    const v = ship.velocity;
    this.uniforms.uVelocity.value.set(v.x, v.y, v.z);
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
