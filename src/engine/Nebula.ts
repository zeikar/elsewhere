/**
 * Nebulae (docs/PLAN.md section 6, Nebulae (Phase 3) and Performance): a few layered planes, each
 * shaded with a cheap domain-warped fBm cloud, soft-blended over one another. No volumetric
 * raymarching.
 *
 * - `nebulaParams(seed)` is pure: it derives the palette, core radius, layer count and layout, and
 *   the noise parameters from an encounter's appearance seed (`hash(baseSeed, encounterIndex)`). Its
 *   result is a `NebulaSpec`, so it can be passed straight to `AutopilotParams.nebulaFor`.
 * - Layout: the nebula has its own frame, built from the encounter plan: local +Z along the planned
 *   path, +X toward the side the nebula sits on. Each layer is a square in a local XY plane (so it
 *   faces the ship as it approaches), tilted a little and spread in depth along the path, so the
 *   layers part with parallax as the ship nears them. `nebulaLayerLayout` gives each layer's centre
 *   and plane normal in world space.
 * - Near-camera fade: each layer's opacity eases to 0 as the camera nears its plane
 *   (`nebulaLayerFade`, like the stars' near fade), and a layer closer than
 *   NEBULA_NEAR_FADE_MIN_DISTANCE is not drawn, so flying through the layers never pops. The fragment
 *   shader also fades each fragment out as its layer is seen edge-on, so an oblique layer never shows
 *   as a hard sliver.
 * - Cost: the fragment shader computes its alpha (the fades above) first and discards a fragment
 *   below NEBULA_MIN_ALPHA before any noise, and a layer whose encounter fade × near fade is below it
 *   is not drawn at all. Both cut-offs are under half an 8-bit step, so they change no pixel.
 * - Draw order, blending and depth (the render-order contract in Planet.ts and Starfield.ts): the
 *   layers draw before the starfield (NEBULA_RENDER_ORDER, below STARFIELD_RENDER_ORDER), depth-tested
 *   and without depth writes. They blend as premultiplied "glow over": each layer adds its emission
 *   and dims what is behind it a little by its dust, and the transparent sort draws them back to
 *   front. The additive stars draw afterwards, so they stay visible over the nebula glow.
 * - Geometry is one module-level unit plane shared by every layer of every nebula, reference-counted
 *   like the planet sphere: each nebula holds it from its constructor until its `dispose()`, and the
 *   last one frees it. Each nebula owns its layer materials (one program for all of them) and frees
 *   them in `dispose()`. No textures.
 *
 * Positions are relative to the ship (floating origin): the caller sets `object.position` to
 * `nebula centre - ship position`, computed in float64 on the CPU, before `update`.
 */
import {
  AddEquation,
  Color,
  CustomBlending,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  Vector3,
} from 'three';
import {
  NEBULA_NEAR_FADE_DISTANCE,
  NEBULA_MIN_ALPHA,
  NEBULA_NEAR_FADE_MIN_DISTANCE,
  NEBULA_NOISE_OFFSET_RANGE,
  NEBULA_RANGES,
} from '../config';
import type { NebulaSpec } from './Autopilot';
import { smoothstep } from './encounter';
import { noiseChunk, type Rgb } from './Planet';
import { mulberry32 } from './seed';
import type { Vec3 } from './Ship';
import { STARFIELD_RENDER_ORDER } from './Starfield';

// ---------------------------------------------------------------------------------------------
// Seeded parameters (pure)
// ---------------------------------------------------------------------------------------------

export interface NebulaLayerParams {
  /**
   * Layer centre relative to the nebula centre, in the nebula frame and world units: x toward the
   * nebula's side of the path, y across, z along the path (negative is nearer the approaching ship).
   */
  offset: readonly [number, number, number];
  /** Half the side of the layer's square, in world units. */
  halfSize: number;
  /** Tilt about the layer's x and y axes, in radians (the plane normal leans this far off the path). */
  tilt: readonly [number, number];
  /** Rotation of the cloud pattern within the plane, in radians. */
  roll: number;
  /** Offset into the noise domain, so each layer has its own clouds. */
  noiseOffset: readonly [number, number, number];
  /** Emission strength: the nebula's `intensity` times a factor in NEBULA_RANGES.layerIntensityJitter. */
  intensity: number;
  /** Shift of this layer's colours toward the accent hue, in [0, 1]. */
  colorShift: number;
  /** Brightness of the core glow on this layer (strongest on layers near the centre's depth). */
  core: number;
}

export interface NebulaParams extends NebulaSpec {
  /** The appearance seed these parameters were drawn from. */
  seed: number;
  /** Name of the palette family (for example `emission` or `reflection`). */
  family: string;
  /** Core radius in world units (the encounter radius). */
  radius: number;
  /**
   * Four colours (sRGB): deep (thin gas), main, accent (a second hue in patches, as where emission
   * and reflection mix) and highlight (the densest gas and the core).
   */
  palette: readonly [Rgb, Rgb, Rgb, Rgb];
  /** Base frequency of the cloud noise across a layer. */
  noiseScale: number;
  /** Cloud noise octaves (an integer). */
  octaves: number;
  /** Domain-warp strength. */
  warp: number;
  /** How much of each layer is cloud. */
  coverage: number;
  /** Brightness of the gas colour (each layer's `intensity` is this times a seeded jitter). */
  intensity: number;
  /** How much each layer dims what is behind it. */
  absorption: number;
  /** Brightness of the core glow. */
  core: number;
  /** Speed at which the clouds churn, in noise units per second. */
  churn: number;
  /** The layers, nearest (smallest `offset[2]`) first. */
  layers: readonly NebulaLayerParams[];
}

type Range = readonly [number, number];
type Hex4 = readonly [number, number, number, number];

interface NebulaFamily {
  name: string;
  /** Deep, main, accent, highlight. */
  palette: Hex4;
}

/** Palette families, after the common kinds of nebula colour. */
const FAMILIES: readonly NebulaFamily[] = [
  // Hydrogen-alpha emission: crimson and rose, with patches of blue reflection and a warm core.
  { name: 'emission', palette: [0x3a0820, 0xc0304e, 0x3a5ad0, 0xffc4a0] },
  // Dust scattering starlight: deep blue with violet patches and an icy core.
  { name: 'reflection', palette: [0x081a48, 0x2e6ad0, 0x7a4ad8, 0xc8e8ff] },
  // Doubly ionised oxygen: teal and seafoam, with rose hydrogen patches.
  { name: 'oxygen', palette: [0x04262e, 0x1a9c94, 0xc0406a, 0xd0fff4] },
  // Orion-like: magenta gas with blue patches around a blue-white core.
  { name: 'orion', palette: [0x14164a, 0xa83486, 0x2a8ad0, 0xc8e0ff] },
  // Violet with rose patches.
  { name: 'violet', palette: [0x1c0a3c, 0x7a3ac8, 0xd04a8a, 0xf2c8ff] },
  // Warm dust lit from within: amber with wine-red patches and a gold core.
  { name: 'ember', palette: [0x2c0c06, 0xc85a26, 0x8a2a50, 0xffe0a0] },
];

/** Salt mixed into the seed so the parameter stream differs from other values drawn from the seed. */
const PARAMS_SALT = 0x4eb1a5;

function lerp(range: Range, t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function randomInt(range: Range, t: number): number {
  return Math.min(range[1], range[0] + Math.floor(t * (range[1] - range[0] + 1)));
}

/**
 * Seeded nebula parameters for an appearance seed (a uint32, normally `hash(baseSeed, index)`).
 * Deterministic, and every value lies inside the ranges in config.ts (NEBULA_RANGES).
 */
export function nebulaParams(seed: number): NebulaParams {
  const r = NEBULA_RANGES;
  const random = mulberry32((seed ^ PARAMS_SALT) >>> 0);
  random();
  random();
  const family = FAMILIES[Math.min(FAMILIES.length - 1, Math.floor(random() * FAMILIES.length))]!;
  // A small seeded tint, so no two nebulae of a family match exactly.
  const tint = [1 + (random() - 0.5) * 0.16, 1 + (random() - 0.5) * 0.16, 1 + (random() - 0.5) * 0.16] as const;
  const shift = (hex: number): Rgb => {
    const [cr, cg, cb] = hexToRgb(hex);
    return [clamp01(cr * tint[0]), clamp01(cg * tint[1]), clamp01(cb * tint[2])];
  };
  const [c0, c1, c2, c3] = family.palette;
  const palette = [shift(c0), shift(c1), shift(c2), shift(c3)] as const;

  const radius = lerp(r.radius, random());
  const layerCount = randomInt(r.layerCount, random());
  const layerSize = lerp(r.layerSize, random());
  const layerOffset = lerp(r.layerOffset, random()) * radius;
  const depthSpread = lerp(r.depthSpread, random()) * radius;
  const tiltMax = lerp(r.tilt, random());
  const noiseScale = lerp(r.noiseScale, random());
  const octaves = randomInt(r.octaves, random());
  const warp = lerp(r.warp, random());
  const coverage = lerp(r.coverage, random());
  const intensity = lerp(r.intensity, random());
  const absorption = lerp(r.absorption, random());
  const core = lerp(r.core, random());
  const churn = lerp(r.churn, random());

  const layers: NebulaLayerParams[] = [];
  const spacing = (2 * depthSpread) / layerCount;
  for (let i = 0; i < layerCount; i++) {
    // Stratified in depth, so the layers never bunch up: one per slot, jittered within its middle.
    const z = -depthSpread + (i + 0.5 + (random() - 0.5) * 0.6) * spacing;
    const angle = 2 * Math.PI * random();
    const lateral = layerOffset * Math.sqrt(random());
    // Layers well away from the centre's depth are a little larger, as the outer gas is thinner.
    const depthT = Math.abs(z) / depthSpread;
    const size = layerSize * (0.9 + 0.1 * depthT + 0.1 * random());
    const halfSize = radius * Math.min(r.layerSize[1], Math.max(r.layerSize[0], size));
    layers.push({
      offset: [Math.cos(angle) * lateral, Math.sin(angle) * lateral, z],
      halfSize,
      tilt: [(random() * 2 - 1) * tiltMax, (random() * 2 - 1) * tiltMax],
      roll: 2 * Math.PI * random(),
      noiseOffset: [
        lerp(NEBULA_NOISE_OFFSET_RANGE, random()),
        lerp(NEBULA_NOISE_OFFSET_RANGE, random()),
        lerp(NEBULA_NOISE_OFFSET_RANGE, random()),
      ],
      intensity: intensity * lerp(r.layerIntensityJitter, random()),
      colorShift: random(),
      core: core * Math.exp(-2.5 * depthT * depthT),
    });
  }

  return {
    seed,
    family: family.name,
    radius,
    palette,
    noiseScale,
    octaves,
    warp,
    coverage,
    intensity,
    absorption,
    core,
    churn,
    layers,
  };
}

// ---------------------------------------------------------------------------------------------
// Layout and near-camera fade (pure)
// ---------------------------------------------------------------------------------------------

/** The nebula's frame: the planned path direction and the unit side vector toward the nebula. */
export interface NebulaFrame {
  direction: Readonly<Vec3>;
  side: Readonly<Vec3>;
}

/** Default frame: a path along -Z with the nebula to the right (+X). */
export const DEFAULT_NEBULA_FRAME: NebulaFrame = { direction: { x: 0, y: 0, z: -1 }, side: { x: 1, y: 0, z: 0 } };

export interface NebulaLayerPlacement {
  /** Layer centre relative to the nebula centre, in world units and axes (before the size scale). */
  center: Vec3;
  /** Unit normal of the layer's plane, in world axes. */
  normal: Vec3;
}

/** The world-space axes of the nebula frame: x = side, z = direction, y = z × x (right-handed). */
function frameAxes(frame: Readonly<NebulaFrame>): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = frame.direction;
  const x = frame.side;
  return {
    x: { x: x.x, y: x.y, z: x.z },
    y: { x: z.y * x.z - z.z * x.y, y: z.z * x.x - z.x * x.z, z: z.x * x.y - z.y * x.x },
    z: { x: z.x, y: z.y, z: z.z },
  };
}

/**
 * Each layer's centre (relative to the nebula centre) and plane normal, in world space, for a nebula
 * placed in `frame`. The normal is the layer's local +Z after its tilt (Euler XYZ: x tilt, then y
 * tilt; the roll turns the pattern within the plane and leaves the normal alone).
 */
export function nebulaLayerLayout(params: Readonly<NebulaParams>, frame: Readonly<NebulaFrame>): NebulaLayerPlacement[] {
  const axes = frameAxes(frame);
  const toWorld = (lx: number, ly: number, lz: number): Vec3 => ({
    x: axes.x.x * lx + axes.y.x * ly + axes.z.x * lz,
    y: axes.x.y * lx + axes.y.y * ly + axes.z.y * lz,
    z: axes.x.z * lx + axes.y.z * ly + axes.z.z * lz,
  });
  return params.layers.map((layer) => {
    const [a, b] = layer.tilt;
    // Rx(a) · Ry(b) · (0, 0, 1).
    const n = toWorld(Math.sin(b), -Math.cos(b) * Math.sin(a), Math.cos(b) * Math.cos(a));
    return { center: toWorld(layer.offset[0], layer.offset[1], layer.offset[2]), normal: n };
  });
}

/**
 * Distance from the camera (at the origin) to a layer's plane, given the nebula centre relative to
 * the camera (`object.position`), the size scale, and the layer's placement.
 */
export function nebulaLayerPlaneDistance(
  nebulaPosition: Readonly<Vec3>,
  scale: number,
  placement: Readonly<NebulaLayerPlacement>,
): number {
  const { center: c, normal: n } = placement;
  const x = nebulaPosition.x + scale * c.x;
  const y = nebulaPosition.y + scale * c.y;
  const z = nebulaPosition.z + scale * c.z;
  return Math.abs(x * n.x + y * n.y + z * n.z);
}

/**
 * Near-camera fade of a layer at `distance` from the camera to its plane: 1 from
 * `minDistance + width` on, easing (smoothstep, so continuous) down to exactly 0 at `minDistance`
 * and closer.
 */
export function nebulaLayerFade(
  distance: number,
  minDistance: number = NEBULA_NEAR_FADE_MIN_DISTANCE,
  width: number = NEBULA_NEAR_FADE_DISTANCE,
): number {
  return smoothstep(minDistance, minDistance + width, distance);
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const layerVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormalW;

void main() {
  // The shared geometry is a unit plane, so position.xy * 2 spans [-1, 1] across the layer.
  vUv = position.xy * 2.0;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalW = mat3(modelMatrix) * normal;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const layerFragmentShader = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uMain;
uniform vec3 uAccent;
uniform vec3 uHighlight;
uniform float uNoiseScale;
uniform int uOctaves;
uniform float uWarp;
uniform float uCoverage;
uniform float uAbsorption;
uniform float uTime;
uniform float uOpacity;
uniform float uLayerFade;
uniform float uIntensity;
uniform float uColorShift;
uniform float uCore;
uniform vec3 uNoiseOffset;

varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormalW;

const float MIN_ALPHA = ${NEBULA_MIN_ALPHA.toExponential()};

${noiseChunk}

void main() {
  float r0 = length(vUv);
  if (r0 >= 1.0) discard;
  // Seen edge-on, a layer fades out per fragment, so it never shows as a sliver. The combined alpha
  // needs no noise, so a fragment too faint to change any pixel (NEBULA_MIN_ALPHA) skips the noise.
  float facing = abs(dot(normalize(vWorld - cameraPosition), normalize(vNormalW)));
  float a = uOpacity * uLayerFade * smoothstep(0.08, 0.35, facing);
  if (a < MIN_ALPHA) discard;
  // 1 inside, easing to exactly 0 at the inscribed circle, so no layer ever shows its square's edge.
  float edge = 1.0 - smoothstep(0.7, 1.0, r0);

  vec3 q = vec3(vUv * uNoiseScale, uTime) + uNoiseOffset;
  // Low-frequency warp, also used to make the outline ragged and to place the dust and the accent hue.
  vec2 w = vec2(snoise(q * 0.55 + vec3(3.1, 7.4, 1.9)), snoise(q * 0.55 + vec3(8.3, 2.8, 5.1)));
  // Envelope: a ragged blob inside the edge.
  float r = length(vUv + 0.3 * w);
  float envelope = (1.0 - smoothstep(0.0, 0.95, r)) * edge;
  if (envelope <= 0.0) discard;

  vec3 qw = q + uWarp * vec3(w, 0.0);
  float n = fbm(qw, uOctaves);
  // Billowing cloud with soft, dark gaps.
  float cloud = smoothstep(-0.35, 0.5, n + (uCoverage - 0.6) * 0.6);
  float density = envelope * cloud * cloud;
  // Thin, brighter filaments along the ridges of the warped noise.
  float ridge = 1.0 - abs(snoise(qw * 1.7 + vec3(11.0, 5.0, 0.0)));
  float filaments = envelope * pow(ridge, 10.0) * smoothstep(0.15, 0.7, cloud);
  // Dark dust lanes where the warp field is high.
  float dust = envelope * smoothstep(0.2, 0.75, w.x * 0.6 + n * 0.9);

  // Colour: deep in thin gas, main in denser gas, the accent hue in broad patches, highlight in the
  // densest gas; darker in the dust lanes.
  vec3 gas = mix(uMain, uAccent, smoothstep(-0.15, 0.55, w.y + (uColorShift - 0.5) * 0.8) * 0.85);
  vec3 color = mix(uDeep, gas, smoothstep(0.0, 0.45, density));
  color = mix(color, uHighlight, smoothstep(0.6, 1.0, density) * 0.35);
  color *= uIntensity * (1.0 - 0.75 * dust);
  // How much of what is behind the gas and dust cover. Stacked layers settle toward their colour
  // instead of adding up to white.
  float cover = clamp(uAbsorption * (density + 0.5 * dust), 0.0, 1.0);
  // Additive glow on top: thin bright filaments and a soft core, ragged like the outline.
  vec3 glow = mix(gas, uHighlight, 0.4) * filaments * uIntensity * 0.08;
  glow += uHighlight * uCore * exp(-r * r * 10.0) * edge;

  // Premultiplied "over" (colours converted to the output space before premultiplying): the gas's
  // colour by its cover plus the glow, over what is behind dimmed by the cover.
  vec3 rgb = linearToOutputTexel(vec4(color, 1.0)).rgb * cover + linearToOutputTexel(vec4(glow, 1.0)).rgb;
  gl_FragColor = vec4(rgb * a, cover * a);
}
`;

// ---------------------------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------------------------

let sharedGeometry: PlaneGeometry | null = null;
/** Number of live (not yet disposed) nebulae holding `sharedGeometry`. */
let sharedGeometryRefs = 0;

/** The unit plane every nebula layer draws with. Created on first use; calling this takes no reference. */
export function nebulaGeometry(): PlaneGeometry {
  sharedGeometry ??= new PlaneGeometry(1, 1);
  return sharedGeometry;
}

/** Number of live nebulae currently holding the shared geometry. */
export function nebulaGeometryRefs(): number {
  return sharedGeometryRefs;
}

function releaseNebulaGeometry(): void {
  sharedGeometryRefs = Math.max(0, sharedGeometryRefs - 1);
  if (sharedGeometryRefs === 0) disposeNebulaGeometry();
}

/** Frees the shared plane if no live nebula holds it; a no-op while any nebula is alive. */
export function disposeNebulaGeometry(): void {
  if (sharedGeometryRefs !== 0) return;
  sharedGeometry?.dispose();
  sharedGeometry = null;
}

// ---------------------------------------------------------------------------------------------
// Nebula
// ---------------------------------------------------------------------------------------------

/**
 * Render order: before the starfield, so the additive stars draw over the nebula glow; layers sort
 * back to front among themselves. No depth writes (see the module comment).
 */
export const NEBULA_RENDER_ORDER = STARFIELD_RENDER_ORDER - 1;

function toColor(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

export interface NebulaLayer {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  /** World-space placement relative to the nebula centre (see `nebulaLayerLayout`). */
  readonly placement: NebulaLayerPlacement;
  /** This layer's near-camera fade, set by `update`. */
  readonly fade: { value: number };
}

export class Nebula {
  readonly params: Readonly<NebulaParams>;
  /** Root object to add to the scene. Its position is the nebula centre relative to the ship. */
  readonly object = new Group();
  readonly layers: readonly NebulaLayer[];
  /** The encounter fade, shared by every layer. */
  readonly opacity = { value: 1 };
  private readonly time = { value: 0 };
  private disposed = false;

  constructor(params: Readonly<NebulaParams>, frame: Readonly<NebulaFrame> = DEFAULT_NEBULA_FRAME) {
    this.params = params;
    sharedGeometryRefs++;
    const geometry = nebulaGeometry();
    const axes = frameAxes(frame);
    const basis = new Matrix4().makeBasis(
      new Vector3(axes.x.x, axes.x.y, axes.x.z),
      new Vector3(axes.y.x, axes.y.y, axes.y.z),
      new Vector3(axes.z.x, axes.z.y, axes.z.z),
    );
    this.object.quaternion.setFromRotationMatrix(basis);

    const [deep, main, accent, highlight] = params.palette;
    const shared = {
      uDeep: { value: toColor(deep) },
      uMain: { value: toColor(main) },
      uAccent: { value: toColor(accent) },
      uHighlight: { value: toColor(highlight) },
      uNoiseScale: { value: params.noiseScale },
      uOctaves: { value: params.octaves },
      uWarp: { value: params.warp },
      uCoverage: { value: params.coverage },
      uAbsorption: { value: params.absorption },
      uTime: this.time,
      uOpacity: this.opacity,
    };
    const placements = nebulaLayerLayout(params, frame);
    this.layers = params.layers.map((layer, i) => {
      const fade = { value: 1 };
      const material = new ShaderMaterial({
        uniforms: {
          ...shared,
          uLayerFade: fade,
          uIntensity: { value: layer.intensity },
          uColorShift: { value: layer.colorShift },
          uCore: { value: layer.core },
          uNoiseOffset: { value: new Vector3(...layer.noiseOffset) },
        },
        vertexShader: layerVertexShader,
        fragmentShader: layerFragmentShader,
        side: DoubleSide,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: CustomBlending,
        blendEquation: AddEquation,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
        blendEquationAlpha: AddEquation,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneMinusSrcAlphaFactor,
      });
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = NEBULA_RENDER_ORDER;
      mesh.position.set(layer.offset[0], layer.offset[1], layer.offset[2]);
      mesh.rotation.set(layer.tilt[0], layer.tilt[1], layer.roll);
      mesh.scale.setScalar(2 * layer.halfSize);
      this.object.add(mesh);
      return { mesh, placement: placements[i]!, fade };
    });
    this.update(0);
  }

  /**
   * Sets the encounter fade in [0, 1] (the Autopilot's fade). At 0 the nebula is not drawn, and a
   * layer whose fade × near fade is below NEBULA_MIN_ALPHA is not drawn (see `update`).
   */
  setFade(opacity: number): void {
    const o = Math.min(1, Math.max(0, opacity));
    this.opacity.value = o;
    this.object.visible = o > 0;
    this.updateLayerVisibility();
  }

  /** Sets the size scale about the nebula centre (1 for the nebula profile). */
  setScale(scale: number): void {
    this.object.scale.setScalar(scale);
  }

  /**
   * Churns the clouds to `time` seconds and sets each layer's near-camera fade from the current
   * `object.position` and scale. A layer whose encounter fade × near fade is below NEBULA_MIN_ALPHA
   * is not drawn: every one of its fragments would be discarded anyway. Allocates nothing.
   */
  update(time: number): void {
    this.time.value = time * this.params.churn;
    const position = this.object.position;
    const scale = this.object.scale.x;
    for (const layer of this.layers) {
      layer.fade.value = nebulaLayerFade(nebulaLayerPlaneDistance(position, scale, layer.placement));
    }
    this.updateLayerVisibility();
  }

  private updateLayerVisibility(): void {
    const opacity = this.opacity.value;
    for (const layer of this.layers) layer.mesh.visible = opacity * layer.fade.value >= NEBULA_MIN_ALPHA;
  }

  /** Frees the layer materials and drops this nebula's reference to the shared plane. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    for (const layer of this.layers) layer.mesh.material.dispose();
    releaseNebulaGeometry();
  }
}
