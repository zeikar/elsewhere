/**
 * Planets (docs/PLAN.md section 6, Planets (Phase 2), Variety (Phase 4) and Performance): seeded
 * rocky planets, icy dwarfs and gas giants with procedural surfaces, basic lighting, an additive
 * atmospheric rim glow, and for some a ring system.
 *
 * - `planetParams(seed)` is pure: it derives the type, radius, palette, noise or band parameters,
 *   rotation and atmosphere from an encounter's appearance seed (`hash(baseSeed, encounterIndex)`),
 *   and from a second stream the Phase 4 variety: whether a rocky planet is an icy dwarf, the ring,
 *   and the pass factor `k`. Its result is a `PlanetSpec` (radius, `passFactor`, `extent`), so it
 *   can be passed straight to `AutopilotParams.planetFor`.
 * - `Planet` builds the meshes. Every planet reuses one module-level unit `SphereGeometry`, which is
 *   reference-counted: each planet holds it from its constructor until its `dispose()`, and the last
 *   planet to be disposed frees it (the next planet makes a new one). Each planet owns its materials
 *   and frees them in `dispose()`. Surfaces are fully procedural, so no textures are made.
 * - Surfaces are shaded per fragment in a `ShaderMaterial`: domain-warped fBm terrain with seas,
 *   polar ice and bump shading for rocky planets, and turbulent latitude bands with an optional oval
 *   storm for gas giants. Shader programs depend only on the type, so all planets of one type share
 *   one compiled program.
 * - The atmosphere is a slightly larger shell drawn additively. Its glow is computed analytically
 *   from how close each view ray passes to the planet, so it brightens toward the limb and fades out
 *   at the shell's edge, and it is brighter on the day side.
 * - A ring is a flat annulus (its own geometry, freed with the planet) in the planet's equatorial
 *   plane, with seeded ringlets, a main gap, two tones from the planet's palette, a lit and an unlit
 *   face, and the planet's shadow across it. A ringed planet's spin axis and ring are turned toward
 *   its encounter (`ringAxis`), so the ring is seen open on the approach and at the closest approach,
 *   never edge-on. It draws with the atmosphere's shader program (the halo program), so it adds no
 *   program: see `haloVertexShader`.
 * - `setFade(opacity)` drives one opacity uniform shared by the surface, the ring and the atmosphere
 *   (the Autopilot's fade); at 0 the planet is hidden.
 * - Draw order and depth, relative to the two star layers (the full render order is in
 *   Starfield.ts; contract for whoever adds planets to the scene): the far stars draw first of all
 *   (FAR_STARFIELD_RENDER_ORDER), so the surface paints over the far stars behind its disc. The
 *   surface writes depth and draws before the near starfield (renderOrder below
 *   STARFIELD_RENDER_ORDER), and the near starfield depth-tests without writing, so only the near
 *   stars behind the planet are hidden and those nearer than the planet still show in front of its
 *   disc. The atmosphere draws after the near starfield, additively, depth-tested and without depth
 *   writes. The surface writes depth while it fades too, so near stars behind a partly faded planet
 *   are hidden; fades happen while the planet is far beyond most of the star cube, so few stars are
 *   affected. A partly faded surface blends over the far stars, so they show through it as it fades.
 *   The ring draws after the surface and before the near starfield (RING_RENDER_ORDER), depth-tested,
 *   so the disc hides the ring's far side and the near side blends over the disc and the far stars;
 *   it writes depth (except in its gaps), so near stars behind it are hidden too. A ringed planet's
 *   atmosphere draws between its surface and its ring instead (RINGED_ATMOSPHERE_RENDER_ORDER), so
 *   the ring's near side blends over the glow, dimming it by the ring's opacity rather than hiding
 *   it; where the ring's far side shows past the limb, through the glow, the ring adds that glow
 *   back over itself (see `haloFragmentShader`).
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
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import {
  ENCOUNTER_CLEARANCE_MARGIN,
  PLANET_ATMOSPHERE_TINT,
  PLANET_GAS_RANGES,
  PLANET_GAS_SHARE,
  PLANET_ICY_RADIUS,
  PLANET_ICY_SHARE,
  PLANET_LIGHT_DIRECTION,
  PLANET_MIN_PASS_DISTANCE,
  PLANET_NOISE_OFFSET_RANGE,
  PLANET_PALETTE_TINT,
  PLANET_PASS_FACTOR_RANGE,
  PLANET_PASS_FACTOR_SKEW,
  PLANET_RING_RANGES,
  PLANET_RING_SEGMENTS,
  PLANET_RING_SHARE,
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

/**
 * A ring system (docs/PLAN.md section 9, Phase 4): a thin, flat annulus in the planet's equatorial
 * plane, with seeded ringlets, a main gap, colours and tilt. Lengths are in planet radii.
 */
export interface PlanetRing {
  /** Inner edge. */
  inner: number;
  /** Outer edge; the planet's `extent`. */
  outer: number;
  /** Peak opacity of the densest ringlets. */
  opacity: number;
  /** Ringlet cycles across the ring's width. */
  bands: number;
  /** Offset into the ringlet noise. */
  bandOffset: number;
  /** Where the main gap lies across the ring (0 inner edge, 1 outer edge), and its width. */
  gap: number;
  gapWidth: number;
  /** Ring colours (sRGB): the dominant tone and the one it shades into. */
  colors: readonly [Rgb, Rgb];
  /** Tilt of the ring plane toward the approaching ship, in radians (`ringAxis`). */
  opening: number;
  /** Signed tilt of the ring plane about the path, in radians (`ringAxis`). */
  roll: number;
}

interface PlanetParamsBase extends PlanetSpec {
  /** The appearance seed these parameters were drawn from. */
  seed: number;
  /** Name of the palette family the colours were drawn from (for example `terran`, `icy` or `jovian`). */
  family: string;
  /** Planet radius in world units. */
  radius: number;
  /**
   * `k`: the encounter passes the centre at `radius × k` (PLANET_PASS_FACTOR_RANGE). Already clears
   * the ring, if any (`planetPassFactor` in Autopilot.ts would raise it otherwise).
   */
  passFactor: number;
  /**
   * Everything drawn for the planet lies within `radius × extent` of its centre: the ring's outer
   * edge, or the atmosphere shell (`1 + atmosphereThickness`) without a ring.
   */
  extent: number;
  /** The ring system, or `null` (most planets). */
  ring: PlanetRing | null;
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
  /**
   * Tilt of the spin axis away from world up, in radians. A ringed planet's spin axis is instead the
   * ring's axis, turned toward the encounter (`ringAxis`).
   */
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
  /** Atmosphere colours the family may have; each planet picks one (then tints it). */
  atmospheres: readonly number[];
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
  /** Atmosphere colours the family may have; each planet picks one (then tints it). */
  atmospheres: readonly number[];
}

/**
 * Rocky palette families, which `planetParams` picks from evenly. Icy dwarfs (ICY_FAMILY) are drawn
 * separately, at PLANET_ICY_SHARE.
 */
const ROCKY_FAMILIES: readonly RockyFamily[] = [
  {
    name: 'terran',
    palette: [0x123a66, 0x3e6a36, 0x80784a, 0xb9a88c],
    atmospheres: [0x5c9cff, 0x6ab8f0, 0x8aa8ff],
    seaLevel: [-0.02, 0.08],
    iceCap: [0.12, 0.3],
    specular: [0.3, 0.5],
    craters: [0, 0],
    atmosphereIntensity: [0.85, 1.1],
  },
  {
    name: 'desert',
    palette: [0x5e2e1b, 0x8f4b2c, 0xc2723f, 0xe4b385],
    atmospheres: [0xe8a27a, 0xf0c090],
    seaLevel: [-0.3, -0.16],
    iceCap: [0, 0.14],
    specular: [0, 0],
    craters: [0.15, 0.35],
    atmosphereIntensity: [0.4, 0.75],
  },
  {
    name: 'lunar',
    palette: [0x3b3936, 0x625e59, 0x8f8982, 0xc6c0b7],
    atmospheres: [0xa8b0c0],
    seaLevel: [-0.2, -0.06],
    iceCap: [0, 0],
    specular: [0, 0],
    craters: [0.45, 0.7],
    atmosphereIntensity: [0, 0],
  },
  {
    name: 'volcanic',
    palette: [0x2c120b, 0x2e2724, 0x51443c, 0x8c7768],
    atmospheres: [0xff9a5c, 0xffc070],
    seaLevel: [-0.22, -0.1],
    iceCap: [0, 0],
    specular: [0, 0.1],
    craters: [0.05, 0.2],
    atmosphereIntensity: [0.35, 0.65],
  },
  {
    name: 'sulphur',
    palette: [0x6a5320, 0xa8873a, 0xd5bf70, 0xf0e5b2],
    atmospheres: [0xf0d890, 0xd8e0a0],
    seaLevel: [-0.25, -0.12],
    iceCap: [0, 0.08],
    specular: [0, 0],
    craters: [0, 0],
    atmosphereIntensity: [0.25, 0.55],
  },
  // A water world: deep seas over most of the surface, scattered green-brown islands.
  {
    name: 'oceanic',
    palette: [0x0a2a5e, 0x2f6448, 0x6c7c4c, 0xb4ae90],
    atmospheres: [0x5aa0ff, 0x70d0f0],
    seaLevel: [0.1, 0.2],
    iceCap: [0.04, 0.18],
    specular: [0.38, 0.5],
    craters: [0, 0],
    atmosphereIntensity: [0.95, 1.2],
  },
  // Rust-red iron oxide dust over dark basalt, with a thin, pale atmosphere.
  {
    name: 'ferric',
    palette: [0x3a1a12, 0x7a3420, 0xa85a36, 0xd49c78],
    atmospheres: [0xf0b494, 0xd8b0b8],
    seaLevel: [-0.3, -0.18],
    iceCap: [0.03, 0.14],
    specular: [0, 0],
    craters: [0.2, 0.45],
    atmosphereIntensity: [0.15, 0.45],
  },
  // A jungle world: dark teal shallow seas, deep greens, ochre uplands.
  {
    name: 'verdant',
    palette: [0x0c3a48, 0x1f5226, 0x4f7a2e, 0xa0a26a],
    atmospheres: [0x8ad0ff, 0x9ae8c8],
    seaLevel: [-0.12, 0.02],
    iceCap: [0, 0.1],
    specular: [0.15, 0.35],
    craters: [0, 0],
    atmosphereIntensity: [0.8, 1.1],
  },
];

/**
 * Icy dwarfs (docs/PLAN.md section 9, Phase 4), Pluto-like: the basins are smooth, bright
 * nitrogen-ice plains (the "sea" of the rocky shader, flat and only faintly glossy), the lowlands dark
 * reddish-brown tholin patches, the uplands tan and the peaks frosted, with plenty of craters and a
 * faint blue haze or none. Small (PLANET_ICY_RADIUS).
 */
const ICY_FAMILY: RockyFamily = {
  name: 'icy',
  palette: [0xd4cbbb, 0x4e3226, 0xa88a6c, 0xe2dcd2],
  atmospheres: [0x9ab8f0, 0xb0c8f8],
  seaLevel: [-0.1, 0.06],
  iceCap: [0, 0.12],
  specular: [0.04, 0.12],
  craters: [0.25, 0.55],
  atmosphereIntensity: [0, 0.35],
};

const GAS_FAMILIES: readonly GasFamily[] = [
  { name: 'jovian', palette: [0x9a6a46, 0xe6d6bc, 0xc49a6c, 0xb5502e], atmospheres: [0xf2d8b0, 0xe8c8a8] },
  { name: 'saturnian', palette: [0xb3955a, 0xefe2bd, 0xd2bb85, 0xf6edd2], atmospheres: [0xf6e6be, 0xe8e0c8] },
  { name: 'neptunian', palette: [0x1f3c8a, 0x4f80d6, 0x9ec0f2, 0xe8f0ff], atmospheres: [0x7fb0ff, 0x90c8ff] },
  { name: 'uranian', palette: [0x4d9caf, 0x9cd9e1, 0x6bbccb, 0xdaf4f6], atmospheres: [0xa8e8f0, 0x98d8e8] },
  { name: 'violet', palette: [0x4a2e6e, 0xa47fca, 0x7a5aa6, 0xe4cef2], atmospheres: [0xc9a8f0, 0xe0b0e8] },
  { name: 'ember', palette: [0x4c1a10, 0xb2502c, 0xe08a4c, 0xffd08a], atmospheres: [0xff9a60, 0xffb878] },
  { name: 'emerald', palette: [0x1c4a3a, 0x7cc0a0, 0x4a8c70, 0xd8f0e0], atmospheres: [0x9ae8c8, 0xb0f0e0] },
  { name: 'rose', palette: [0x6a2c3a, 0xe2aaa8, 0xb86a72, 0xf6dcd0], atmospheres: [0xf0b8c0, 0xffd0c8] },
  { name: 'umber', palette: [0x3a2414, 0x8c6a48, 0x6a4a2e, 0xcc9c68], atmospheres: [0xd8b090, 0xe8c8a0] },
];

/** Names of the rocky (icy dwarfs last) and gas palette families. */
export const ROCKY_FAMILY_NAMES: readonly string[] = [...ROCKY_FAMILIES, ICY_FAMILY].map((f) => f.name);
export const GAS_FAMILY_NAMES: readonly string[] = GAS_FAMILIES.map((f) => f.name);

/** The rocky families' sub-ranges, so tests can check they lie inside PLANET_ROCKY_RANGES. */
export const ROCKY_FAMILY_RANGES: readonly Readonly<Record<'seaLevel' | 'iceCap' | 'specular' | 'craters' | 'atmosphereIntensity', Range>>[] =
  [...ROCKY_FAMILIES, ICY_FAMILY].map(({ seaLevel, iceCap, specular, craters, atmosphereIntensity }) => ({
    seaLevel,
    iceCap,
    specular,
    craters,
    atmosphereIntensity,
  }));

/** Salt mixed into the seed so the parameter stream differs from other values drawn from the seed. */
const PARAMS_SALT = 0x91a2e7;
/**
 * Salt of the second stream, for the Phase 4 variety (icy dwarfs, rings, the pass factor). A stream
 * of its own, so every Phase 3 value is drawn exactly as before.
 */
const VARIETY_SALT = 0x7a41e7;

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
  const t = 2 * PLANET_PALETTE_TINT;
  const tint = [1 + (random() - 0.5) * t, 1 + (random() - 0.5) * t, 1 + (random() - 0.5) * t];
  const brightness = 0.92 + random() * 0.16;
  const shift = (hex: number): Rgb => {
    const [r, g, b] = hexToRgb(hex);
    return [clamp01(r * (tint[0] ?? 1) * brightness), clamp01(g * (tint[1] ?? 1) * brightness), clamp01(b * (tint[2] ?? 1) * brightness)];
  };
  return [shift(palette[0]), shift(palette[1]), shift(palette[2]), shift(palette[3])];
}

/** One of the family's atmosphere colours, with a seeded per-channel tint (PLANET_ATMOSPHERE_TINT). */
function atmosphereColor(atmospheres: readonly number[], random: () => number): Rgb {
  const [r, g, b] = hexToRgb(pick(atmospheres, random()));
  const t = 2 * PLANET_ATMOSPHERE_TINT;
  return [clamp01(r * (1 + (random() - 0.5) * t)), clamp01(g * (1 + (random() - 0.5) * t)), clamp01(b * (1 + (random() - 0.5) * t))];
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
  const radiusRoll = random();
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

  // The Phase 4 variety, from its own stream: always the same draws, in the same order.
  const variety = mulberry32((seed ^ VARIETY_SALT) >>> 0);
  variety();
  const icy = type === 'rocky' && variety() < PLANET_ICY_SHARE;
  const ringed = variety() < PLANET_RING_SHARE[type];
  const passRoll = variety();
  const ringDraw = drawRing(variety);
  const icyDraw = drawRockyFamily(ICY_FAMILY, variety);

  const radius = lerp(icy ? PLANET_ICY_RADIUS : ranges.radius, radiusRoll);
  const base = { seed, radius, noiseScale, octaves, noiseOffset, rotationSpeed, axialTilt, rotationPhase, atmosphereThickness };
  /** The ring, extent and pass factor, once the palette is known (the ring takes its colours from it). */
  const shape = (palette: Hex4Rgb) => {
    const ring = ringed ? { ...ringDraw, colors: ringColors(type, palette) } : null;
    const extent = ring === null ? 1 + atmosphereThickness : ring.outer;
    return { ring, extent, passFactor: passFactorFor(radius, extent, passRoll) };
  };

  if (type === 'gas') {
    const g = PLANET_GAS_RANGES;
    const family = pick(GAS_FAMILIES, random());
    const palette = jitterPalette(family.palette, random);
    // About a third of gas giants have no storm.
    const stormRoll = random();
    const stormSize = stormRoll < 0.35 ? 0 : lerp([g.stormSize[1] * 0.45, g.stormSize[1]], random());
    const atmosphereIntensity = lerp(g.atmosphereIntensity, random());
    const bandFrequency = lerp(g.bandFrequency, random());
    const bandPhase = lerp(g.bandPhase, random());
    const turbulence = lerp(g.turbulence, random());
    const stormLatitude = lerp(g.stormLatitude, random());
    const stormLongitude = lerp(g.stormLongitude, random());
    return {
      ...base,
      ...shape(palette),
      type,
      family: family.name,
      palette,
      atmosphereColor: atmosphereColor(family.atmospheres, random),
      atmosphereIntensity,
      bandFrequency,
      bandPhase,
      turbulence,
      stormSize,
      stormLatitude,
      stormLongitude,
    };
  }

  const r = PLANET_ROCKY_RANGES;
  const family = pick(ROCKY_FAMILIES, random());
  const palette = jitterPalette(family.palette, random);
  const atmosphereIntensity = lerp(family.atmosphereIntensity, random());
  const warp = lerp(r.warp, random());
  const seaLevel = lerp(family.seaLevel, random());
  const iceCap = lerp(family.iceCap, random());
  const specular = lerp(family.specular, random());
  const relief = lerp(r.relief, random());
  const craters = lerp(family.craters, random());
  const atmosphere = atmosphereColor(family.atmospheres, random);
  // An icy dwarf keeps the terrain shape (noise, warp, relief) and replaces the family's look.
  const look = icy
    ? icyDraw
    : { family: family.name, palette, atmosphereColor: atmosphere, atmosphereIntensity, seaLevel, iceCap, specular, craters };
  return {
    ...base,
    ...shape(look.palette),
    type,
    ...look,
    warp,
    relief,
  };
}

type Hex4Rgb = readonly [Rgb, Rgb, Rgb, Rgb];

/** A rocky family's look, drawn from `random` in a fixed order. */
function drawRockyFamily(family: RockyFamily, random: () => number) {
  return {
    family: family.name,
    palette: jitterPalette(family.palette, random),
    atmosphereColor: atmosphereColor(family.atmospheres, random),
    atmosphereIntensity: lerp(family.atmosphereIntensity, random()),
    seaLevel: lerp(family.seaLevel, random()),
    iceCap: lerp(family.iceCap, random()),
    specular: lerp(family.specular, random()),
    craters: lerp(family.craters, random()),
  };
}

/** A ring's shape and tilt, drawn from `random` in a fixed order (its colours come from the palette). */
function drawRing(random: () => number): Omit<PlanetRing, 'colors'> {
  const g = PLANET_RING_RANGES;
  const inner = lerp(g.inner, random());
  const outer = inner + lerp(g.width, random());
  const opacity = lerp(g.opacity, random());
  const bands = lerp(g.bands, random());
  const bandOffset = lerp(g.bandOffset, random());
  const gap = lerp(g.gap, random());
  const gapWidth = lerp(g.gapWidth, random());
  const opening = lerp(g.opening, random());
  const roll = lerp(g.roll, random()) * (random() < 0.5 ? -1 : 1);
  return { inner, outer, opacity, bands, bandOffset, gap, gapWidth, opening, roll };
}

/** `rgb` moved `amount` of the way toward its own grey (desaturated), then scaled by `scale`. */
function greyed(rgb: Rgb, amount: number, scale = 1): Rgb {
  const grey = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [
    clamp01((rgb[0] + (grey - rgb[0]) * amount) * scale),
    clamp01((rgb[1] + (grey - rgb[1]) * amount) * scale),
    clamp01((rgb[2] + (grey - rgb[2]) * amount) * scale),
  ];
}

/**
 * Ring colours from the planet's palette: muted versions of a gas giant's light and accent bands
 * (ice and dust, like Saturn's), or of a rocky world's highland and upland tones (rock and dust).
 */
function ringColors(type: PlanetType, palette: Hex4Rgb): readonly [Rgb, Rgb] {
  return type === 'gas'
    ? [greyed(palette[1], 0.45), greyed(palette[2], 0.45, 0.85)]
    : [greyed(palette[3], 0.55), greyed(palette[2], 0.5, 0.8)];
}

/**
 * The pass factor `k` for a planet of `radius` and `extent`, from a roll `u` in [0, 1):
 * `low × (max / low)^(u^PLANET_PASS_FACTOR_SKEW)`, log-uniform in `k` but skewed toward `low`, the
 * lowest `k` that keeps the closest approach at least PLANET_MIN_PASS_DISTANCE and clear of the
 * extent (`radius × extent × (1 + ENCOUNTER_CLEARANCE_MARGIN)`); `max` is the top of
 * PLANET_PASS_FACTOR_RANGE. The radii and ring sizes leave that interval non-empty.
 */
export function passFactorFor(radius: number, extent: number, roll: number): number {
  const [min, max] = PLANET_PASS_FACTOR_RANGE;
  const low = Math.min(max, Math.max(min, PLANET_MIN_PASS_DISTANCE / radius, extent * (1 + ENCOUNTER_CLEARANCE_MARGIN)));
  return low * (max / low) ** (roll ** PLANET_PASS_FACTOR_SKEW);
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

/*
 * 3D simplex noise: "webgl-noise" by Ian McEwan and Stefan Gustavson (Ashima Arts), MIT licence,
 * https://github.com/ashima/webgl-noise. Returns values in about [-1, 1]. snoiseGrad() also returns
 * the analytic gradient of the same function; snoise() drops it (the compiler removes the unused
 * gradient code). Shared with the nebula layers (Nebula.ts).
 */
export const noiseChunk = /* glsl */ `
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

/*
 * The halo program draws both the atmosphere shell and the ring (`uRing` picks which), so a ringed
 * planet needs no shader program of its own: the program count stays the same from start-up on, and
 * ProgramWarmup's atmosphere holder already keeps it compiled (see `planetProgramMaterials`). Three.js
 * keys a program on its sources, defines and a few material flags (side, among them), not on
 * blending or depth writes, so the two materials share it. Uniforms keep their values per program,
 * so every halo material sets `uRing` itself.
 */
const haloVertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec3 vCenter;
varying float vShellRadius;
// The mesh's local +Y in world space: the ring plane's normal (unused by the atmosphere).
varying vec3 vAxis;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vCenter = modelMatrix[3].xyz;
  vShellRadius = length(modelMatrix[0].xyz);
  vAxis = normalize(modelMatrix[1].xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const haloFragmentShader = /* glsl */ `
uniform vec3 uAtmosphereColor;
uniform float uAtmosphereIntensity;
uniform float uThickness;
uniform vec3 uLightDir;
uniform float uOpacity;
// 1 for the ring, 0 for the atmosphere.
uniform float uRing;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;
uniform float uRingBands;
uniform float uRingOffset;
uniform float uRingGap;
uniform float uRingGapWidth;
uniform vec3 uRingColor0;
uniform vec3 uRingColor1;

varying vec3 vWorld;
varying vec3 vCenter;
varying float vShellRadius;
varying vec3 vAxis;

const float PI = 3.141592653589793;

float hash11(float x) {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}

// Smooth 1D value noise in [0, 1].
float noise1(float x) {
  float i = floor(x);
  float f = x - i;
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// The ring: the mesh is a flat annulus scaled by the planet radius (vShellRadius), centred on it.
vec4 ring() {
  vec3 rel = vWorld - vCenter;
  float r = length(rel) / vShellRadius;
  float t = (r - uRingInner) / (uRingOuter - uRingInner);
  // The annulus's edges are chords; trim them to the true circles.
  if (t < 0.0 || t > 1.0) discard;
  // Ringlets: a few octaves of noise across the width, so the bands are irregular, sharpened.
  float x = t * uRingBands + uRingOffset;
  float n = 0.55 * noise1(x) + 0.3 * noise1(x * 2.7 + 13.1) + 0.15 * noise1(x * 7.9 + 4.2);
  float density = smoothstep(0.18, 0.82, n);
  // Denser toward the middle, soft at both edges, and the main gap.
  density *= mix(0.45, 1.0, sin(PI * t)) * smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.9, 1.0, t));
  density *= smoothstep(0.45, 1.0, abs(t - uRingGap) / uRingGapWidth);
  vec3 albedo = mix(uRingColor0, uRingColor1, noise1(t * 3.0 + uRingOffset * 0.37));
  albedo *= 0.75 + 0.5 * n;

  // Lit by the sun on one face. Seen from the other, light only filters through, more so where thin.
  vec3 l = normalize(uLightDir);
  vec3 axis = normalize(vAxis);
  vec3 v = normalize(cameraPosition - vWorld);
  float nl = dot(axis, l);
  float lit = 0.12 + 0.88 * abs(nl);
  if (nl * dot(axis, v) < 0.0) lit *= 0.5 * (1.0 - 0.6 * density);
  // The planet's shadow: the ray toward the sun passes within one radius of the centre.
  float along = -dot(rel, l);
  float miss = dot(rel, rel) - along * along;
  float radius2 = vShellRadius * vShellRadius;
  float shadow = along > 0.0 ? smoothstep(radius2 * 0.94, radius2 * 1.06, miss) : 1.0;
  vec3 color = albedo * lit * mix(0.03, 1.0, shadow);

  float alpha = density * uRingOpacity * uOpacity;
  // Fragments this faint change no 8-bit channel; dropping them keeps depth out of the gaps.
  if (alpha < 1.0 / 512.0) discard;
  return vec4(color, alpha);
}

// The atmosphere's glow along the view ray through this fragment (linear colour, before the output
// encoding), for a planet of radius planetRadius. It depends on the ray alone, so the ring can
// compute the glow the atmosphere draws at the same pixel.
vec3 atmosphereGlow(float planetRadius) {
  // How close the ray passes to the planet centre, in planet radii: 1 at the limb, 1 + thickness at
  // the shell's edge.
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 oc = vCenter - cameraPosition;
  vec3 closest = cameraPosition + rd * dot(oc, rd);
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
  return uAtmosphereColor * glow * day * uAtmosphereIntensity * uOpacity;
}

void main() {
  if (uRing > 0.5) {
    gl_FragColor = ring();
    #include <colorspace_fragment>
    // The atmosphere drew before the ring (RINGED_ATMOSPHERE_RENDER_ORDER), so the ring blends over
    // its glow. The ring lies outside the atmosphere shell, so on this view ray the glow is all
    // behind the ring or all in front of it. Behind (the ring nearer than the planet centre along the
    // ray): blending over it is right. In front (the ring's far side, seen past the limb): the ring
    // adds the glow, as the atmosphere wrote it, to its own colour, so blended at alpha a it leaves
    // a × glow + (1 − a) × glow, the whole glow, over itself.
    if (uAtmosphereIntensity > 0.0 && dot(vWorld - vCenter, vWorld - cameraPosition) > 0.0) {
      gl_FragColor.rgb += linearToOutputTexel(vec4(atmosphereGlow(vShellRadius), 1.0)).rgb;
    }
    return;
  }
  gl_FragColor = vec4(atmosphereGlow(vShellRadius / (1.0 + uThickness)), 1.0);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------------------------

let sharedGeometry: SphereGeometry | null = null;
/** Number of live (not yet disposed) planets holding `sharedGeometry`. */
let sharedGeometryRefs = 0;

/**
 * The unit sphere every planet (and its atmosphere shell) draws with. Created on first use. Calling
 * this takes no reference; planets take theirs in the constructor (see `acquirePlanetGeometry`).
 */
export function planetGeometry(): SphereGeometry {
  sharedGeometry ??= new SphereGeometry(1, PLANET_SPHERE_SEGMENTS[0], PLANET_SPHERE_SEGMENTS[1]);
  return sharedGeometry;
}

/** Number of live planets currently holding the shared geometry. */
export function planetGeometryRefs(): number {
  return sharedGeometryRefs;
}

/** Takes a reference to the shared geometry (one per planet, in its constructor). */
function acquirePlanetGeometry(): SphereGeometry {
  const geometry = planetGeometry();
  sharedGeometryRefs++;
  return geometry;
}

/** Drops a planet's reference; the last one frees the geometry, so the next planet makes a new one. */
function releasePlanetGeometry(): void {
  sharedGeometryRefs = Math.max(0, sharedGeometryRefs - 1);
  if (sharedGeometryRefs === 0) disposeUnreferencedGeometry();
}

function disposeUnreferencedGeometry(): void {
  sharedGeometry?.dispose();
  sharedGeometry = null;
}

/**
 * Frees the shared sphere geometry if no live planet holds it (for example one made by
 * `planetGeometry()` alone); a no-op while any planet is alive, so it can never pull the geometry
 * out from under one. Planets free it themselves when the last one is disposed, so callers only
 * need this to clean up after `planetGeometry()` was called with no planet.
 */
export function disposePlanetGeometry(): void {
  if (sharedGeometryRefs === 0) disposeUnreferencedGeometry();
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
 * Render order. The surface draws after the far stars (painting over those behind it) and before the
 * near starfield, and writes depth, so the depth-tested near stars are hidden only where they are
 * behind it. The ring draws after the surface, depth-tested against it, so the planet hides the part
 * of the ring behind its disc and the part in front blends over the disc; it writes depth too, so the
 * near stars behind it are hidden as well. The additive atmosphere draws after the near starfield.
 *
 * A ringed planet's atmosphere draws between its surface and its ring instead
 * (RINGED_ATMOSPHERE_RENDER_ORDER), so the ring's depth never hides the glow: the ring's near side
 * blends over it, and its far side, seen past the limb through the glow, adds the glow back over
 * itself (see `haloFragmentShader`). The atmosphere is additive, depth-tested only against the
 * surface and writes no depth, so drawing it before the near starfield leaves the stars as they are.
 */
export const SURFACE_RENDER_ORDER = STARFIELD_RENDER_ORDER - 1;
export const RINGED_ATMOSPHERE_RENDER_ORDER = SURFACE_RENDER_ORDER + 0.25;
export const RING_RENDER_ORDER = SURFACE_RENDER_ORDER + 0.5;
export const ATMOSPHERE_RENDER_ORDER = STARFIELD_RENDER_ORDER + 1;

type Uniforms = ShaderMaterial['uniforms'];

/** The surface material of a planet of `type`. Its shader program depends only on the type. */
function createSurfaceMaterial(type: PlanetType, uniforms: Uniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    defines: type === 'gas' ? { PLANET_GAS: 1 } : {},
    vertexShader: surfaceVertexShader,
    fragmentShader: surfaceFragmentShader,
    side: FrontSide,
    // Transparent so the fade blends it over the background. Drawn after the far stars and before the
    // near starfield, and writes depth, so the near stars behind it fail their depth test (see
    // SURFACE_RENDER_ORDER).
    transparent: true,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: true,
  });
}

/** The atmosphere shell's material: the halo program, additive. One shader program for every planet. */
function createAtmosphereMaterial(uniforms: Uniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...uniforms, uRing: { value: 0 } },
    vertexShader: haloVertexShader,
    fragmentShader: haloFragmentShader,
    side: FrontSide,
    transparent: true,
    blending: AdditiveBlending,
    depthTest: true,
    depthWrite: false,
  });
}

/**
 * The ring's material: the same halo program as the atmosphere (same sources, no defines, front
 * faces only), blended normally and writing depth (see RING_RENDER_ORDER). The ring geometry holds
 * both windings, so front faces alone show it from either side. It takes the atmosphere's uniforms
 * too, to add the glow in front of its far side (see RINGED_ATMOSPHERE_RENDER_ORDER).
 */
function createRingMaterial(uniforms: Uniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...uniforms, uRing: { value: 1 } },
    vertexShader: haloVertexShader,
    fragmentShader: haloFragmentShader,
    side: FrontSide,
    transparent: true,
    blending: NormalBlending,
    depthTest: true,
    depthWrite: true,
  });
}

/**
 * One material per planet shader program (the rocky surface, the gas surface and the halo, which
 * draws both the atmosphere and the ring), built exactly as planets build theirs but with no
 * uniforms, so each compiles to the program the planets use. For keeping those programs compiled
 * between encounters (see ProgramWarmup.ts); they are never drawn. The caller owns and disposes them.
 */
export function planetProgramMaterials(): ShaderMaterial[] {
  return [createSurfaceMaterial('rocky', {}), createSurfaceMaterial('gas', {}), createAtmosphereMaterial({})];
}

/**
 * A flat annulus from `inner` to `outer` in the XZ plane (normal +Y), with both windings, so a
 * front-face-only material draws it from either side. Positions, normals and uvs, like the sphere.
 */
export function ringGeometry(inner: number, outer: number, segments = PLANET_RING_SEGMENTS): RingGeometry {
  const geometry = new RingGeometry(inner, outer, segments, 1);
  geometry.rotateX(-Math.PI / 2);
  const index = geometry.getIndex();
  if (index !== null) {
    const front = Array.from(index.array as ArrayLike<number>);
    const back: number[] = [];
    for (let i = 0; i < front.length; i += 3) back.push(front[i]!, front[i + 2]!, front[i + 1]!);
    geometry.setIndex([...front, ...back]);
  }
  return geometry;
}

/** The plan frame a planet is oriented in: the planned direction and the side the planet sits on. */
export interface PlanetFrame {
  direction: Readonly<Vec3>;
  side: Readonly<Vec3>;
}

/** The frame of a planet ahead along -Z, to the right of the path (previews and tests). */
export const DEFAULT_PLANET_FRAME: PlanetFrame = { direction: { x: 0, y: 0, z: -1 }, side: { x: 1, y: 0, z: 0 } };

/**
 * Writes the ring's axis (the normal of its plane, and the ringed planet's spin axis) in world space
 * into `out` and returns it, for a ring planned in `frame`. With `up = side × direction`, the axis is
 * `up` tilted toward the approaching ship by `opening` and about the path by `roll`:
 * `cos(opening) cos(roll) up − sin(opening) direction + cos(opening) sin(roll) side`, a unit vector.
 * A ring with neither tilt would lie in the plane of the path and be seen edge-on all along it;
 * `opening` opens it toward the approach and `roll` at the closest approach. The path crosses the
 * ring plane only `|tan(roll) / tan(opening)|` × the closest approach along the path from it, which
 * is beyond the ring whenever the closest approach is (`planetPassFactor`).
 */
export function ringAxis(ring: Readonly<Pick<PlanetRing, 'opening' | 'roll'>>, frame: Readonly<PlanetFrame>, out: Vec3): Vec3 {
  const { direction: d, side: s } = frame;
  const ux = s.y * d.z - s.z * d.y;
  const uy = s.z * d.x - s.x * d.z;
  const uz = s.x * d.y - s.y * d.x;
  const a = Math.cos(ring.opening) * Math.cos(ring.roll);
  const b = -Math.sin(ring.opening);
  const c = Math.cos(ring.opening) * Math.sin(ring.roll);
  const x = a * ux + b * d.x + c * s.x;
  const y = a * uy + b * d.y + c * s.y;
  const z = a * uz + b * d.z + c * s.z;
  const len = Math.hypot(x, y, z);
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

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
  /** The atmosphere shell, or `null` for an airless planet; it draws with the shared sphere. */
  readonly atmosphere: Mesh<SphereGeometry, ShaderMaterial> | null;
  /** The ring, or `null`; it owns its geometry. */
  readonly ring: Mesh<RingGeometry, ShaderMaterial> | null;
  private disposed = false;

  /**
   * `frame` orients a ringed planet toward its encounter (`ringAxis`); a planet without a ring tilts
   * its spin axis by `axialTilt` from world up and ignores it.
   */
  constructor(
    params: Readonly<PlanetParams>,
    lightDirection: Readonly<Vec3> = PLANET_LIGHT_DIRECTION,
    frame: Readonly<PlanetFrame> = DEFAULT_PLANET_FRAME,
  ) {
    this.params = params;
    const geometry = acquirePlanetGeometry();
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

    const surfaceMaterial = createSurfaceMaterial(params.type, {
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
    });
    this.surface = new Mesh(geometry, surfaceMaterial);
    this.surface.renderOrder = SURFACE_RENDER_ORDER;
    const ring = params.ring;
    if (ring === null) {
      this.tilt.rotation.z = params.axialTilt;
    } else {
      const axis = ringAxis(ring, frame, { x: 0, y: 0, z: 0 });
      this.tilt.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(axis.x, axis.y, axis.z)));
    }
    this.tilt.add(this.surface);
    this.object.add(this.tilt);

    if (ring !== null) {
      const [r0, r1] = ring.colors;
      const ringMaterial = createRingMaterial({
        uAtmosphereColor: u.uAtmosphereColor,
        uAtmosphereIntensity: u.uAtmosphereIntensity,
        uThickness: u.uThickness,
        uLightDir: u.uLightDir,
        uOpacity: u.uOpacity,
        uRingInner: { value: ring.inner },
        uRingOuter: { value: ring.outer },
        uRingOpacity: { value: ring.opacity },
        uRingBands: { value: ring.bands },
        uRingOffset: { value: ring.bandOffset },
        uRingGap: { value: ring.gap },
        uRingGapWidth: { value: ring.gapWidth },
        uRingColor0: { value: toColor(r0) },
        uRingColor1: { value: toColor(r1) },
      });
      this.ring = new Mesh(ringGeometry(ring.inner, ring.outer), ringMaterial);
      this.ring.renderOrder = RING_RENDER_ORDER;
      this.tilt.add(this.ring);
    } else {
      this.ring = null;
    }

    if (params.atmosphereIntensity > 0) {
      const atmosphereMaterial = createAtmosphereMaterial({
        uAtmosphereColor: u.uAtmosphereColor,
        uAtmosphereIntensity: u.uAtmosphereIntensity,
        uThickness: u.uThickness,
        uLightDir: u.uLightDir,
        uOpacity: u.uOpacity,
      });
      this.atmosphere = new Mesh(geometry, atmosphereMaterial);
      this.atmosphere.scale.setScalar(1 + params.atmosphereThickness);
      this.atmosphere.renderOrder = ring === null ? ATMOSPHERE_RENDER_ORDER : RINGED_ATMOSPHERE_RENDER_ORDER;
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

  /**
   * Frees this planet's materials and drops its reference to the shared geometry, which is freed
   * once no live planet holds it. Disposing twice is harmless.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.surface.material.dispose();
    this.atmosphere?.material.dispose();
    this.ring?.material.dispose();
    this.ring?.geometry.dispose();
    releasePlanetGeometry();
  }
}
