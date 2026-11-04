/**
 * Planets (docs/PLAN.md section 6, Planets (Phase 2) and Performance): seeded rocky planets and gas
 * giants with procedural surfaces, basic lighting and an additive atmospheric rim glow.
 *
 * - `planetParams(seed)` is pure: it derives the type, radius, palette, noise or band parameters,
 *   rotation and atmosphere from an encounter's appearance seed (`hash(baseSeed, encounterIndex)`).
 *   Its result is a `PlanetSpec`, so it can be passed straight to `AutopilotParams.planetFor`.
 * - `Planet` builds the meshes. Every planet reuses one module-level unit `SphereGeometry`, which is
 *   only freed by `disposePlanetGeometry()` (the module-level teardown). Each planet owns its
 *   materials and frees them in `dispose()`. Surfaces are fully procedural, so no textures are made.
 * - Surfaces are shaded per fragment in a `ShaderMaterial`: domain-warped fBm terrain with seas,
 *   polar ice and bump shading for rocky planets, and turbulent latitude bands with an optional oval
 *   storm for gas giants. Shader programs depend only on the type, so all planets of one type share
 *   one compiled program.
 * - The atmosphere is a slightly larger shell drawn additively. Its glow is computed analytically
 *   from how close each view ray passes to the planet, so it brightens toward the limb and fades out
 *   at the shell's edge, and it is brighter on the day side.
 * - `setFade(opacity)` drives one opacity uniform shared by the surface and the atmosphere (the
 *   Autopilot's fade); at 0 the planet is hidden.
 * - Draw order and depth, relative to the starfield (contract for whoever adds planets to the scene):
 *   the surface writes depth and draws before the starfield (renderOrder below
 *   STARFIELD_RENDER_ORDER), and the starfield depth-tests without writing, so only the stars behind
 *   the planet are hidden and stars nearer than the planet still show in front of its disc. The
 *   atmosphere draws after the starfield, additively, depth-tested and without depth writes. The
 *   surface writes depth while it fades too, so stars behind a partly faded planet are hidden; fades
 *   happen while the planet is far beyond most of the star cube, so few stars are affected.
 *
 * Positions are relative to the ship (floating origin): the caller sets `object.position` to
 * `planet centre - ship position`, computed in float64 on the CPU.
 */
import {
  AdditiveBlending,
  Color,
  FrontSide,
  Group,
  Mesh,
  NormalBlending,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import {
  PLANET_GAS_RANGES,
  PLANET_GAS_SHARE,
  PLANET_LIGHT_DIRECTION,
  PLANET_NOISE_OFFSET_RANGE,
  PLANET_ROCKY_RANGES,
  PLANET_ROTATION_PHASE_RANGE,
  PLANET_SPHERE_SEGMENTS,
} from '../config';
import type { PlanetSpec } from './Autopilot';
import { mulberry32 } from './seed';
import type { Vec3 } from './Ship';
import { STARFIELD_RENDER_ORDER } from './Starfield';

// ---------------------------------------------------------------------------------------------
// Seeded parameters (pure)
// ---------------------------------------------------------------------------------------------

export type PlanetType = 'rocky' | 'gas';

/** An sRGB colour with channels in [0, 1]. */
export type Rgb = readonly [number, number, number];

interface PlanetParamsBase extends PlanetSpec {
  /** The appearance seed these parameters were drawn from. */
  seed: number;
  /** Name of the palette family the colours were drawn from (for example `terran` or `jovian`). */
  family: string;
  /** Planet radius in world units. */
  radius: number;
  /**
   * Four surface colours (sRGB). Rocky: basin or sea, lowland, upland, highland. Gas: dark band,
   * light band, accent band, storm.
   */
  palette: readonly [Rgb, Rgb, Rgb, Rgb];
  /** Base frequency of the surface noise. */
  noiseScale: number;
  /** Number of noise octaves (an integer). */
  octaves: number;
  /** Offset into the noise domain, so each seed samples its own region of noise. */
  noiseOffset: readonly [number, number, number];
  /** Spin about the planet's axis, in radians per second. */
  rotationSpeed: number;
  /** Tilt of the spin axis away from world up, in radians. */
  axialTilt: number;
  /** Starting rotation angle, in radians. */
  rotationPhase: number;
  /** Atmosphere glow colour (sRGB). */
  atmosphereColor: Rgb;
  /** Atmosphere shell thickness, as a fraction of the radius. */
  atmosphereThickness: number;
  /** Atmosphere glow strength; 0 means airless and no glow is drawn. */
  atmosphereIntensity: number;
}

export interface RockyPlanetParams extends PlanetParamsBase {
  type: 'rocky';
  /** Domain-warp strength of the terrain noise. */
  warp: number;
  /** Terrain height below which the surface is flat basin or sea. */
  seaLevel: number;
  /** Fraction of the latitude, from each pole, covered by ice. */
  iceCap: number;
  /** Specular highlight strength on seas. */
  specular: number;
  /** Bump-shading strength of the terrain. */
  relief: number;
  /** Crater density: the chance that a cell of the crater lattice holds a crater. 0 means none. */
  craters: number;
}

export interface GasPlanetParams extends PlanetParamsBase {
  type: 'gas';
  /** Band cycles from pole to pole. */
  bandFrequency: number;
  /** Phase of the band pattern, in radians. */
  bandPhase: number;
  /** How far the turbulence pushes the bands around. */
  turbulence: number;
  /** Angular size of the oval storm; 0 means no storm. */
  stormSize: number;
  /** Storm latitude, in radians. */
  stormLatitude: number;
  /** Storm longitude, in radians. */
  stormLongitude: number;
}

export type PlanetParams = RockyPlanetParams | GasPlanetParams;

type Range = readonly [number, number];
type Hex4 = readonly [number, number, number, number];

interface RockyFamily {
  name: string;
  palette: Hex4;
  atmosphere: number;
  /** Sub-ranges inside PLANET_ROCKY_RANGES. */
  seaLevel: Range;
  iceCap: Range;
  specular: Range;
  craters: Range;
  atmosphereIntensity: Range;
}

interface GasFamily {
  name: string;
  palette: Hex4;
  atmosphere: number;
}

const ROCKY_FAMILIES: readonly RockyFamily[] = [
  {
    name: 'terran',
    palette: [0x123a66, 0x3e6a36, 0x80784a, 0xb9a88c],
    atmosphere: 0x5c9cff,
    seaLevel: [-0.02, 0.08],
    iceCap: [0.12, 0.3],
    specular: [0.3, 0.5],
    craters: [0, 0],
    atmosphereIntensity: [0.85, 1.1],
  },
  {
    name: 'desert',
    palette: [0x5e2e1b, 0x8f4b2c, 0xc2723f, 0xe4b385],
    atmosphere: 0xe8a27a,
    seaLevel: [-0.3, -0.16],
    iceCap: [0, 0.14],
    specular: [0, 0],
    craters: [0.15, 0.35],
    atmosphereIntensity: [0.4, 0.75],
  },
  {
    name: 'lunar',
    palette: [0x3b3936, 0x625e59, 0x8f8982, 0xc6c0b7],
    atmosphere: 0xa8b0c0,
    seaLevel: [-0.2, -0.06],
    iceCap: [0, 0],
    specular: [0, 0],
    craters: [0.45, 0.7],
    atmosphereIntensity: [0, 0],
  },
  {
    name: 'volcanic',
    palette: [0x2c120b, 0x2e2724, 0x51443c, 0x8c7768],
    atmosphere: 0xff9a5c,
    seaLevel: [-0.22, -0.1],
    iceCap: [0, 0],
    specular: [0, 0.1],
    craters: [0.05, 0.2],
    atmosphereIntensity: [0.35, 0.65],
  },
  {
    name: 'sulphur',
    palette: [0x6a5320, 0xa8873a, 0xd5bf70, 0xf0e5b2],
    atmosphere: 0xf0d890,
    seaLevel: [-0.25, -0.12],
    iceCap: [0, 0.08],
    specular: [0, 0],
    craters: [0, 0],
    atmosphereIntensity: [0.25, 0.55],
  },
];

const GAS_FAMILIES: readonly GasFamily[] = [
  { name: 'jovian', palette: [0x9a6a46, 0xe6d6bc, 0xc49a6c, 0xb5502e], atmosphere: 0xf2d8b0 },
  { name: 'saturnian', palette: [0xb3955a, 0xefe2bd, 0xd2bb85, 0xf6edd2], atmosphere: 0xf6e6be },
  { name: 'neptunian', palette: [0x1f3c8a, 0x4f80d6, 0x9ec0f2, 0xe8f0ff], atmosphere: 0x7fb0ff },
  { name: 'uranian', palette: [0x4d9caf, 0x9cd9e1, 0x6bbccb, 0xdaf4f6], atmosphere: 0xa8e8f0 },
  { name: 'violet', palette: [0x4a2e6e, 0xa47fca, 0x7a5aa6, 0xe4cef2], atmosphere: 0xc9a8f0 },
  { name: 'ember', palette: [0x4c1a10, 0xb2502c, 0xe08a4c, 0xffd08a], atmosphere: 0xff9a60 },
];

/** Salt mixed into the seed so the parameter stream differs from other values drawn from the seed. */
const PARAMS_SALT = 0x91a2e7;

function lerp(range: Range, t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

function pick<T>(items: readonly T[], t: number): T {
  const item = items[Math.min(items.length - 1, Math.floor(t * items.length))];
  if (item === undefined) throw new Error('pick: empty list');
  return item;
}

function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The family palette with a small seeded tint and brightness shift, so no two planets match exactly. */
function jitterPalette(palette: Hex4, random: () => number): [Rgb, Rgb, Rgb, Rgb] {
  const tint = [1 + (random() - 0.5) * 0.12, 1 + (random() - 0.5) * 0.12, 1 + (random() - 0.5) * 0.12];
  const brightness = 0.92 + random() * 0.16;
  const shift = (hex: number): Rgb => {
    const [r, g, b] = hexToRgb(hex);
    return [clamp01(r * (tint[0] ?? 1) * brightness), clamp01(g * (tint[1] ?? 1) * brightness), clamp01(b * (tint[2] ?? 1) * brightness)];
  };
  return [shift(palette[0]), shift(palette[1]), shift(palette[2]), shift(palette[3])];
}

/**
 * Seeded planet parameters for an appearance seed (a uint32, normally `hash(baseSeed, index)`).
 * Deterministic, and every numeric value lies inside the ranges in config.ts.
 */
export function planetParams(seed: number): PlanetParams {
  const random = mulberry32((seed ^ PARAMS_SALT) >>> 0);
  // Burn a few values so nearby seeds decorrelate quickly.
  random();
  random();
  const type: PlanetType = random() < PLANET_GAS_SHARE ? 'gas' : 'rocky';
  const ranges = type === 'gas' ? PLANET_GAS_RANGES : PLANET_ROCKY_RANGES;
  const radius = lerp(ranges.radius, random());
  const noiseScale = lerp(ranges.noiseScale, random());
  const octaves = Math.min(ranges.octaves[1], ranges.octaves[0] + Math.floor(random() * (ranges.octaves[1] - ranges.octaves[0] + 1)));
  const noiseOffset = [
    lerp(PLANET_NOISE_OFFSET_RANGE, random()),
    lerp(PLANET_NOISE_OFFSET_RANGE, random()),
    lerp(PLANET_NOISE_OFFSET_RANGE, random()),
  ] as const;
  const rotationSpeed = lerp(ranges.rotationSpeed, random());
  const axialTilt = lerp(ranges.axialTilt, random());
  const rotationPhase = lerp(PLANET_ROTATION_PHASE_RANGE, random()) % (2 * Math.PI);
  const atmosphereThickness = lerp(ranges.atmosphereThickness, random());
  const base = { seed, radius, noiseScale, octaves, noiseOffset, rotationSpeed, axialTilt, rotationPhase, atmosphereThickness };

  if (type === 'gas') {
    const g = PLANET_GAS_RANGES;
    const family = pick(GAS_FAMILIES, random());
    const palette = jitterPalette(family.palette, random);
    // About a third of gas giants have no storm.
    const stormRoll = random();
    const stormSize = stormRoll < 0.35 ? 0 : lerp([g.stormSize[1] * 0.45, g.stormSize[1]], random());
    return {
      ...base,
      type,
      family: family.name,
      palette,
      atmosphereColor: hexToRgb(family.atmosphere),
      atmosphereIntensity: lerp(g.atmosphereIntensity, random()),
      bandFrequency: lerp(g.bandFrequency, random()),
      bandPhase: lerp(g.bandPhase, random()),
      turbulence: lerp(g.turbulence, random()),
      stormSize,
      stormLatitude: lerp(g.stormLatitude, random()),
      stormLongitude: lerp(g.stormLongitude, random()),
    };
  }

  const r = PLANET_ROCKY_RANGES;
  const family = pick(ROCKY_FAMILIES, random());
  const palette = jitterPalette(family.palette, random);
  return {
    ...base,
    type,
    family: family.name,
    palette,
    atmosphereColor: hexToRgb(family.atmosphere),
    atmosphereIntensity: lerp(family.atmosphereIntensity, random()),
    warp: lerp(r.warp, random()),
    seaLevel: lerp(family.seaLevel, random()),
    iceCap: lerp(family.iceCap, random()),
    specular: lerp(family.specular, random()),
    relief: lerp(r.relief, random()),
    craters: lerp(family.craters, random()),
  };
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

/*
 * 3D simplex noise: "webgl-noise" by Ian McEwan and Stefan Gustavson (Ashima Arts), MIT licence,
 * https://github.com/ashima/webgl-noise. Returns values in about [-1, 1]. snoiseGrad() also returns
 * the analytic gradient of the same function; snoise() drops it (the compiler removes the unused
 * gradient code).
 */
const noiseChunk = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoiseGrad(vec3 v, out vec3 grad) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 px = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  // d/dv of 42 * sum(m^4 * dot(p, x)), with dm/dv = -2x and dx/dv = I.
  vec4 t = m2 * m * px;
  grad = 42.0 * (m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3
    - 8.0 * (t.x * x0 + t.y * x1 + t.z * x2 + t.w * x3));
  return 42.0 * dot(m4, px);
}

float snoise(vec3 v) {
  vec3 unused;
  return snoiseGrad(v, unused);
}

#define MAX_OCTAVES 6

// Fractional Brownian motion of simplex noise, normalised to about [-1, 1] (mostly within ±0.6).
float fbm(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    sum += amp * snoise(p);
    norm += amp;
    p = p * 2.03 + vec3(17.1, 3.7, 9.4);
    amp *= 0.5;
  }
  return sum / norm;
}
`;

const surfaceVertexShader = /* glsl */ `
varying vec3 vObject;
varying vec3 vWorld;
varying vec3 vNormalW;
// The model rotation's columns (object to world, without the scale); the same for every vertex.
varying vec3 vRotX;
varying vec3 vRotY;
varying vec3 vRotZ;

void main() {
  // The shared geometry is a unit sphere, so the object-space position is the surface direction;
  // the patterns are sampled from it and so turn with the planet.
  vObject = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalW = mat3(modelMatrix) * normal;
  vRotX = normalize(modelMatrix[0].xyz);
  vRotY = normalize(modelMatrix[1].xyz);
  vRotZ = normalize(modelMatrix[2].xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const surfaceFragmentShader = /* glsl */ `
uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform float uNoiseScale;
uniform vec3 uNoiseOffset;
uniform int uOctaves;
uniform vec3 uLightDir;
uniform float uOpacity;
uniform vec3 uAtmosphereColor;
uniform float uAtmosphereIntensity;
#ifdef PLANET_GAS
uniform float uBandFrequency;
uniform float uBandPhase;
uniform float uTurbulence;
uniform float uStormSize;
uniform float uStormLatitude;
uniform float uStormLongitude;
#else
uniform float uWarp;
uniform float uSeaLevel;
uniform float uIceCap;
uniform float uSpecular;
uniform float uRelief;
uniform float uCraters;
#endif

varying vec3 vObject;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vRotX;
varying vec3 vRotY;
varying vec3 vRotZ;

${noiseChunk}

const float PI = 3.141592653589793;

#ifndef PLANET_GAS
/** Cells per unit of the crater lattice. */
const float CRATER_SCALE = 7.0;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Impact craters: at most one per lattice cell (kept with probability uCraters), each a bowl with a
// raised rim. Returns a height offset, negative in the bowls, and its gradient.
float craters(vec3 p, out vec3 grad) {
  vec3 cell = floor(p);
  vec3 f = p - cell;
  float h = 0.0;
  grad = vec3(0.0);
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      for (int k = -1; k <= 1; k++) {
        vec3 o = vec3(float(i), float(j), float(k));
        vec3 r = hash33(cell + o);
        if (r.z >= uCraters) continue;
        vec3 c = o + 0.25 + 0.5 * hash33(cell + o + 19.7);
        float radius = 0.12 + 0.3 * r.x * r.x;
        vec3 fc = f - c;
        float dist = length(fc);
        float d = dist / radius;
        float bowl = d < 1.0 ? d * d - 1.0 : 0.0;
        float e = exp(-18.0 * (d - 1.0) * (d - 1.0));
        float rim = e * 0.4;
        h += (bowl + rim) * radius;
        // d/dd of (bowl + rim), times radius × dd/dp = fc / dist.
        float slope = (d < 1.0 ? 2.0 * d : 0.0) - 14.4 * (d - 1.0) * e;
        grad += slope * fc / max(dist, 1e-6);
      }
    }
  }
  return h;
}

// fbm() and its gradient. The gradient (used only for the bump shading) fades each octave out as
// its features shrink below a few pixels, so the relief does not sparkle when the planet is small:
// footprint is the pixel's size in the units of p. The height itself is fbm(p, octaves).
float fbmGrad(vec3 p, int octaves, float footprint, out vec3 grad) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  float freq = 1.0;
  grad = vec3(0.0);
  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    vec3 g;
    sum += amp * snoiseGrad(p, g);
    norm += amp;
    grad += (1.0 - smoothstep(0.2, 0.4, freq * footprint)) * amp * freq * g;
    p = p * 2.03 + vec3(17.1, 3.7, 9.4);
    amp *= 0.5;
    freq *= 2.03;
  }
  grad /= norm;
  return sum / norm;
}

// Terrain height at unit-sphere point p: domain-warped broad fBm, finer unwarped detail, and
// craters. Mostly within ±0.6. Also returns the height's gradient in object space (not yet projected
// onto the surface), computed analytically alongside the height, so the bump shading needs no extra
// terrain() calls. footprint is the pixel's size on the unit sphere; it filters the gradient only.
float terrain(vec3 p, float footprint, out vec3 grad) {
  vec3 q = p * uNoiseScale + uNoiseOffset;
  vec3 gw0;
  vec3 gw1;
  vec3 gw2;
  vec3 w = vec3(
    snoiseGrad(q * 0.6 + vec3(3.1, 7.4, 1.9), gw0),
    snoiseGrad(q * 0.6 + vec3(8.3, 2.8, 5.1), gw1),
    snoiseGrad(q * 0.6 + vec3(4.6, 9.7, 6.2), gw2));
  // Warp only the broad shapes: warping the fine octaves too would stretch them into fibres.
  vec3 gBroad;
  vec3 gFine;
  float h = fbmGrad(q + uWarp * w, 3, footprint * uNoiseScale, gBroad)
    + 0.4 * fbmGrad(q * 3.7 + 13.0, uOctaves - 2, footprint * uNoiseScale * 3.7, gFine);
  // Chain rule through the warp, d(q + uWarp w)/dq = I + uWarp × 0.6 × (rows gw0, gw1, gw2), and
  // through the scales of q.
  vec3 gq = gBroad + uWarp * 0.6 * (gBroad.x * gw0 + gBroad.y * gw1 + gBroad.z * gw2) + 0.4 * 3.7 * gFine;
  grad = uNoiseScale * gq;
  if (uCraters > 0.0) {
    vec3 gc;
    h += 0.55 * craters(p * CRATER_SCALE + uNoiseOffset.yzx, gc);
    // Crater rims are narrow: drop their relief once a pixel spans a good part of a small crater.
    grad += (1.0 - smoothstep(0.1, 0.3, footprint * CRATER_SCALE)) * 0.55 * CRATER_SCALE * gc;
  }
  return h;
}
#endif

void main() {
  vec3 p = normalize(vObject);
  vec3 ng = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 l = normalize(uLightDir);
  vec3 q = p * uNoiseScale + uNoiseOffset;
  vec3 n = ng;
  vec3 albedo;
  float specular = 0.0;

#ifdef PLANET_GAS
  float phi = asin(clamp(p.y, -1.0, 1.0));
  float lon = atan(p.z, p.x);
  // Oval storm, in a local frame stretched along the longitude.
  float dLon = mod(lon - uStormLongitude + PI, 2.0 * PI) - PI;
  vec2 d = vec2(dLon * cos(phi), phi - uStormLatitude);
  float stormOn = step(0.0001, uStormSize);
  float e = length(d / vec2(max(uStormSize, 1e-4) * 1.8, max(uStormSize, 1e-4)));
  float storm = stormOn * (1.0 - smoothstep(0.55, 1.0, e));
  float wake = stormOn * (1.0 - smoothstep(1.0, 2.2, e));

  // Turbulence: noise stretched along the longitude, so it smears into streaks like real jets.
  float t = fbm(vec3(q.x, q.y * 2.6, q.z), uOctaves);
  float t2 = snoise(vec3(q.x * 0.6, q.y * 7.0, q.z * 0.6) + 11.0);
  float y = phi / (0.5 * PI) + uTurbulence * 0.09 * t + 0.015 * t2;
  // Swirl the bands around the storm.
  y += wake * 0.05 * sin(e * 7.0 + atan(d.y, d.x) * 2.0) * uTurbulence;

  float f = uBandFrequency * PI;
  float b1 = sin(y * f + uBandPhase);
  float b2 = sin(y * f * 2.37 + 1.7 + 2.0 * uBandPhase);
  float b3 = sin(y * f * 0.53 + 0.4 + 3.0 * uBandPhase);
  float band = 0.5 + 0.5 * (0.6 * b1 + 0.25 * b2 + 0.15 * b3);
  albedo = mix(uColor0, uColor1, smoothstep(0.2, 0.8, band));
  albedo = mix(albedo, uColor2, smoothstep(0.5, 1.0, 0.5 + 0.5 * b2) * 0.55);
  // Fine streaks along the bands.
  float s = fbm(vec3(q.x * 1.3, q.y * 16.0, q.z * 1.3) + uNoiseOffset.zxy, 3);
  albedo *= 0.88 + 0.26 * s;
  // The storm: an oval of the storm colour with a light collar.
  float collar = stormOn * smoothstep(0.75, 0.95, e) * (1.0 - smoothstep(0.95, 1.25, e));
  albedo = mix(albedo, uColor1, collar * 0.45);
  albedo = mix(albedo, uColor3 * (0.85 + 0.15 * sin(e * 14.0)), storm * 0.85);
  // Darker, hazier poles.
  albedo *= mix(1.0, 0.72, smoothstep(0.78, 1.0, abs(p.y)));
#else
  // The pixel's footprint on the unit sphere filters the bump shading's gradient.
  vec3 heightGradient;
  float h = terrain(p, max(length(dFdx(p)), length(dFdy(p))), heightGradient);
  float fw = max(fwidth(h), 1e-4);
  float sea = 1.0 - smoothstep(uSeaLevel - fw, uSeaLevel + fw, h);
  float land = clamp((h - uSeaLevel) / (0.5 - uSeaLevel), 0.0, 1.0);
  // Large-scale colour variation so the lowlands are not one flat tone.
  float tone = snoise(q * 0.45 + 21.0);
  vec3 low = mix(uColor1, mix(uColor1, uColor2, 0.5), 0.5 + 0.5 * tone);
  albedo = mix(low, uColor2, smoothstep(0.06, 0.5, land));
  albedo = mix(albedo, uColor3, smoothstep(0.45, 0.95, land));
  // Fine grain.
  albedo *= 0.9 + 0.1 * snoise(q * 13.0);
  float depth = clamp((uSeaLevel - h) / 0.3, 0.0, 1.0);
  vec3 seaColor = mix(uColor0 * 1.3, uColor0 * 0.55, depth);
  albedo = mix(albedo, seaColor, sea);
  // Polar ice with a ragged edge.
  float lat = abs(p.y) + 0.07 * snoise(q * 2.2 + 5.0);
  float ice = step(0.0001, uIceCap) * smoothstep(1.0 - uIceCap, 1.0 - uIceCap + 0.04, lat);
  albedo = mix(albedo, vec3(0.85, 0.89, 0.94), ice);

  // Bump shading from the terrain gradient along the surface (the analytic gradient from terrain(),
  // with its radial part removed).
  vec3 gradient = heightGradient - p * dot(heightGradient, p);
  // Seas and ice are flat.
  float bumpiness = 0.045 * uRelief * (1.0 - sea) * (1.0 - ice);
  vec3 gradientW = gradient.x * vRotX + gradient.y * vRotY + gradient.z * vRotZ;
  n = normalize(ng - bumpiness * gradientW);
  specular = uSpecular * sea * (1.0 - ice);
#endif

  // Lighting: Lambert with a narrow, soft terminator. The day mask uses the geometric normal, so
  // bumps never light up the night side.
  float ndlGeo = dot(ng, l);
  float dayMask = smoothstep(-0.06, 0.14, ndlGeo);
  float diffuse = max(dot(n, l), 0.0) * dayMask;
  vec3 color = albedo * (diffuse + 0.008);
  vec3 hv = normalize(l + v);
  color += specular * pow(max(dot(ng, hv), 0.0), 70.0) * dayMask * vec3(1.0, 0.96, 0.88);
#ifdef PLANET_GAS
  // Limb darkening: the cloud tops are seen through more haze toward the edge. Slightly dimmer
  // overall, so the pale bands keep their contrast instead of washing out to white.
  color *= 0.9 * mix(0.55, 1.0, sqrt(max(dot(ng, v), 0.0)));
#endif
  // Atmospheric haze over the disc toward the limb, on the lit side.
  float rim = 1.0 - max(dot(ng, v), 0.0);
  float haze = pow(rim, 3.0) * uAtmosphereIntensity * smoothstep(-0.15, 0.45, ndlGeo);
  color = mix(color, uAtmosphereColor, clamp(haze * 0.75, 0.0, 1.0));

  gl_FragColor = vec4(color, uOpacity);
  #include <colorspace_fragment>
}
`;

const atmosphereVertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec3 vCenter;
varying float vShellRadius;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vCenter = modelMatrix[3].xyz;
  vShellRadius = length(modelMatrix[0].xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const atmosphereFragmentShader = /* glsl */ `
uniform vec3 uAtmosphereColor;
uniform float uAtmosphereIntensity;
uniform float uThickness;
uniform vec3 uLightDir;
uniform float uOpacity;

varying vec3 vWorld;
varying vec3 vCenter;
varying float vShellRadius;

void main() {
  // How close the view ray through this fragment passes to the planet centre, in planet radii:
  // 1 at the limb, 1 + thickness at the shell's edge.
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 oc = vCenter - cameraPosition;
  vec3 closest = cameraPosition + rd * dot(oc, rd);
  float planetRadius = vShellRadius / (1.0 + uThickness);
  float x = length(closest - vCenter) / planetRadius;

  float glow;
  if (x > 1.0) {
    // Outside the disc: dense near the limb, thinning out to nothing at the shell's edge.
    float s = clamp((x - 1.0) / uThickness, 0.0, 1.0);
    glow = exp(-4.0 * s) * (1.0 - s);
  } else {
    // Over the disc: a thin bright rim at the limb.
    glow = pow(x, 10.0);
  }
  // Brighter on the day side, wrapping a little past the terminator as scattered light does.
  vec3 toLimb = normalize(closest - vCenter + 1e-5);
  float day = smoothstep(-0.3, 0.55, dot(toLimb, normalize(uLightDir)));
  vec3 color = uAtmosphereColor * glow * day * uAtmosphereIntensity * uOpacity;
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------------------------

let sharedGeometry: SphereGeometry | null = null;

/** The unit sphere every planet (and its atmosphere shell) draws with. Created on first use. */
export function planetGeometry(): SphereGeometry {
  sharedGeometry ??= new SphereGeometry(1, PLANET_SPHERE_SEGMENTS[0], PLANET_SPHERE_SEGMENTS[1]);
  return sharedGeometry;
}

/**
 * Module-level teardown: frees the shared sphere geometry. Planets still alive keep a reference to
 * the disposed geometry, so call it only once every planet has been disposed. A planet created
 * afterwards gets a fresh geometry.
 */
export function disposePlanetGeometry(): void {
  sharedGeometry?.dispose();
  sharedGeometry = null;
}

// ---------------------------------------------------------------------------------------------
// Planet
// ---------------------------------------------------------------------------------------------

/** Converts an sRGB colour to a Three.js (linear working space) colour. */
function toColor(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

export interface PlanetUniforms {
  [name: string]: { value: unknown };
  uColor0: { value: Color };
  uColor1: { value: Color };
  uColor2: { value: Color };
  uColor3: { value: Color };
  uNoiseScale: { value: number };
  uNoiseOffset: { value: Vector3 };
  uOctaves: { value: number };
  /** Direction toward the light, in world space (shared with the atmosphere). */
  uLightDir: { value: Vector3 };
  /** Fade (shared with the atmosphere). */
  uOpacity: { value: number };
  uAtmosphereColor: { value: Color };
  uAtmosphereIntensity: { value: number };
  uThickness: { value: number };
}

/**
 * Render order. The surface draws before the starfield and writes depth, so the depth-tested stars
 * are hidden only where they are behind it. The additive atmosphere draws after the starfield.
 */
export const SURFACE_RENDER_ORDER = STARFIELD_RENDER_ORDER - 1;
export const ATMOSPHERE_RENDER_ORDER = STARFIELD_RENDER_ORDER + 1;

export class Planet {
  readonly params: Readonly<PlanetParams>;
  /**
   * Root object to add to the scene. Its position is the planet centre relative to the ship, and its
   * scale is the radius times `setScale`'s factor.
   */
  readonly object = new Group();
  readonly uniforms: PlanetUniforms;
  private readonly tilt = new Group();
  private readonly surface: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly atmosphere: Mesh<SphereGeometry, ShaderMaterial> | null;
  private disposed = false;

  constructor(params: Readonly<PlanetParams>, lightDirection: Readonly<Vec3> = PLANET_LIGHT_DIRECTION) {
    this.params = params;
    const geometry = planetGeometry();
    const [c0, c1, c2, c3] = params.palette;
    this.uniforms = {
      uColor0: { value: toColor(c0) },
      uColor1: { value: toColor(c1) },
      uColor2: { value: toColor(c2) },
      uColor3: { value: toColor(c3) },
      uNoiseScale: { value: params.noiseScale },
      uNoiseOffset: { value: new Vector3(...params.noiseOffset) },
      uOctaves: { value: params.octaves },
      uLightDir: { value: new Vector3(lightDirection.x, lightDirection.y, lightDirection.z).normalize() },
      uOpacity: { value: 1 },
      uAtmosphereColor: { value: toColor(params.atmosphereColor) },
      uAtmosphereIntensity: { value: params.atmosphereIntensity },
      uThickness: { value: params.atmosphereThickness },
    };
    const u = this.uniforms;

    const typeUniforms =
      params.type === 'gas'
        ? {
            uBandFrequency: { value: params.bandFrequency },
            uBandPhase: { value: params.bandPhase },
            uTurbulence: { value: params.turbulence },
            uStormSize: { value: params.stormSize },
            uStormLatitude: { value: params.stormLatitude },
            uStormLongitude: { value: params.stormLongitude },
          }
        : {
            uWarp: { value: params.warp },
            uSeaLevel: { value: params.seaLevel },
            uIceCap: { value: params.iceCap },
            uSpecular: { value: params.specular },
            uRelief: { value: params.relief },
            uCraters: { value: params.craters },
          };

    const surfaceMaterial = new ShaderMaterial({
      uniforms: {
        uColor0: u.uColor0,
        uColor1: u.uColor1,
        uColor2: u.uColor2,
        uColor3: u.uColor3,
        uNoiseScale: u.uNoiseScale,
        uNoiseOffset: u.uNoiseOffset,
        uOctaves: u.uOctaves,
        uLightDir: u.uLightDir,
        uOpacity: u.uOpacity,
        uAtmosphereColor: u.uAtmosphereColor,
        uAtmosphereIntensity: u.uAtmosphereIntensity,
        ...typeUniforms,
      },
      defines: params.type === 'gas' ? { PLANET_GAS: 1 } : {},
      vertexShader: surfaceVertexShader,
      fragmentShader: surfaceFragmentShader,
      side: FrontSide,
      // Transparent so the fade blends it over the background. Drawn before the starfield and writes
      // depth, so the stars behind it fail their depth test (see SURFACE_RENDER_ORDER).
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: true,
    });
    this.surface = new Mesh(geometry, surfaceMaterial);
    this.surface.renderOrder = SURFACE_RENDER_ORDER;
    this.tilt.rotation.z = params.axialTilt;
    this.tilt.add(this.surface);
    this.object.add(this.tilt);

    if (params.atmosphereIntensity > 0) {
      const atmosphereMaterial = new ShaderMaterial({
        uniforms: {
          uAtmosphereColor: u.uAtmosphereColor,
          uAtmosphereIntensity: u.uAtmosphereIntensity,
          uThickness: u.uThickness,
          uLightDir: u.uLightDir,
          uOpacity: u.uOpacity,
        },
        vertexShader: atmosphereVertexShader,
        fragmentShader: atmosphereFragmentShader,
        side: FrontSide,
        transparent: true,
        blending: AdditiveBlending,
        depthTest: true,
        depthWrite: false,
      });
      this.atmosphere = new Mesh(geometry, atmosphereMaterial);
      this.atmosphere.scale.setScalar(1 + params.atmosphereThickness);
      this.atmosphere.renderOrder = ATMOSPHERE_RENDER_ORDER;
      this.object.add(this.atmosphere);
    } else {
      this.atmosphere = null;
    }

    this.object.scale.setScalar(params.radius);
    this.update(0);
  }

  /** Sets the opacity in [0, 1] (the Autopilot's fade). At 0 the planet is not drawn. */
  setFade(opacity: number): void {
    const o = Math.min(1, Math.max(0, opacity));
    this.uniforms.uOpacity.value = o;
    this.object.visible = o > 0;
  }

  /** Sets the size scale (the encounter's size scale): the drawn radius is `radius × scale`. */
  setScale(scale: number): void {
    this.object.scale.setScalar(this.params.radius * scale);
  }

  /** Sets the direction toward the light, in world space (normalised here). */
  setLightDirection(x: number, y: number, z: number): void {
    this.uniforms.uLightDir.value.set(x, y, z).normalize();
  }

  /** Turns the planet to its rotation at `time` seconds. Allocates nothing. */
  update(time: number): void {
    this.surface.rotation.y = this.params.rotationPhase + time * this.params.rotationSpeed;
  }

  /** Frees this planet's materials. The shared geometry stays until `disposePlanetGeometry()`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.surface.material.dispose();
    this.atmosphere?.material.dispose();
  }
}
