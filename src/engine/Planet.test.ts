import { FrontSide, Mesh, RingGeometry, type ShaderMaterial, Texture, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  PLANET_GAS_RANGES,
  PLANET_GAS_SHARE,
  PLANET_ICY_RADIUS,
  PLANET_ICY_SHARE,
  PLANET_MIN_PASS_DISTANCE,
  PLANET_NOISE_OFFSET_RANGE,
  PLANET_PASS_FACTOR_RANGE,
  PLANET_RING_RANGES,
  PLANET_RING_SHARE,
  PLANET_ROCKY_RANGES,
  PLANET_ROTATION_PHASE_RANGE,
} from '../config';
import { DEFAULT_AUTOPILOT_PARAMS, createAutopilotState, encounterSchedule, updateAutopilot } from './Autopilot';
import { planEncounter } from './encounter';
import {
  ATMOSPHERE_RENDER_ORDER,
  DEFAULT_PLANET_FRAME,
  GAS_FAMILY_NAMES,
  Planet,
  RINGED_ATMOSPHERE_RENDER_ORDER,
  RING_RENDER_ORDER,
  ROCKY_FAMILY_NAMES,
  ROCKY_FAMILY_RANGES,
  SURFACE_RENDER_ORDER,
  disposePlanetGeometry,
  passFactorFor,
  planetGeometry,
  atmosphereGeometry,
  planetGeometryRefs,
  planetParams,
  ringAxis,
  ringGeometry,
  type PlanetParams,
  type Rgb,
} from './Planet';
import { hash } from './seed';
import { createShipState } from './Ship';
import { STARFIELD_RENDER_ORDER, Starfield } from './Starfield';

const SEEDS = Array.from({ length: 1000 }, (_, i) => hash(ENCOUNTER_BASE_SEED, i));

/** Fields checked separately (not plain numbers within a type's range table). */
const NON_RANGE_FIELDS = new Set([
  'seed',
  'type',
  'family',
  'palette',
  'noiseOffset',
  'rotationPhase',
  'atmosphereColor',
  'passFactor',
  'extent',
  'ring',
]);

/** The first seeded planet of `type`; without a ring unless `ringed`. */
function firstOfType(type: PlanetParams['type'], ringed = false): PlanetParams {
  const seed = SEEDS.find((s) => planetParams(s).type === type && (planetParams(s).ring !== null) === ringed);
  if (seed === undefined) throw new Error(`no ${type} seed`);
  return planetParams(seed);
}

/** The first seeded icy dwarf. */
function firstIcy(): PlanetParams {
  const seed = SEEDS.find((s) => planetParams(s).family === 'icy' && planetParams(s).ring === null);
  if (seed === undefined) throw new Error('no icy seed');
  return planetParams(seed);
}

function expectRgb(rgb: Rgb, label: string): void {
  expect(rgb, label).toHaveLength(3);
  for (const c of rgb) {
    expect(c, label).toBeGreaterThanOrEqual(0);
    expect(c, label).toBeLessThanOrEqual(1);
  }
}

describe('planet config', () => {
  const minRadius = Math.min(PLANET_ROCKY_RANGES.radius[0], PLANET_GAS_RANGES.radius[0], PLANET_ICY_RADIUS[0]);
  const maxRadius = Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1], PLANET_ICY_RADIUS[1]);
  const maxOuter = PLANET_RING_RANGES.inner[1] + PLANET_RING_RANGES.width[1];

  it('ranges are ordered and the type shares leave room for both types', () => {
    for (const ranges of [PLANET_ROCKY_RANGES, PLANET_GAS_RANGES]) {
      for (const [key, [min, max]] of Object.entries(ranges)) {
        expect(min, key).toBeLessThanOrEqual(max);
      }
      expect(ranges.radius[0]).toBeGreaterThan(0);
      expect(Number.isInteger(ranges.octaves[0]) && Number.isInteger(ranges.octaves[1])).toBe(true);
    }
    expect(PLANET_GAS_SHARE).toBeGreaterThanOrEqual(0.25);
    expect(PLANET_GAS_SHARE).toBeLessThanOrEqual(0.75);
  });

  it('radii fit the encounter plan: far inside the spawn distance and the far plane', () => {
    // Its whole sphere, ring included, starts beyond the slowdown, so the encounter starts at cruise speed.
    expect(ENCOUNTER_DISTANCE - maxRadius * maxOuter).toBeGreaterThan(ENCOUNTER_SLOWDOWN_DISTANCE);
    expect(ENCOUNTER_DISTANCE + maxRadius * (PLANET_PASS_FACTOR_RANGE[1] + maxOuter)).toBeLessThan(CAMERA_FAR);
    // The placeholder radius the autopilot uses today lies inside the seeded range.
    expect(ENCOUNTER_PLANET_RADIUS).toBeGreaterThanOrEqual(minRadius);
    expect(ENCOUNTER_PLANET_RADIUS).toBeLessThanOrEqual(maxRadius);
  });

  /**
   * Projected diameter, in pixels at 1080p (a 1,080-pixel view height), of a sphere of radius `r` at
   * spawn whose centre is `D` ahead and `offset` to the side, drawn at its full size (the size scale
   * is 1 throughout), with the side offset taken as vertical, the worst case for the height.
   */
  const spawnPx = (r: number, offset: number, D = ENCOUNTER_DISTANCE) => {
    const centre = Math.hypot(D, offset);
    const half = Math.asin(r / centre);
    const offAxis = Math.atan2(offset, D);
    const tanHalfFov = Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180);
    return (1080 * (Math.tan(offAxis + half) - Math.tan(offAxis - half))) / (2 * tanHalfFov);
  };
  const quantile = (values: readonly number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))]!;

  it('at first appearance (the spawn) a median planet, atmosphere included, is at most 12 px across at 1080p and the largest at most 30 px', () => {
    // 20,000 seeded planets, each at its own k. Measured (px at 1080p, p10/p50/p90/max), with the
    // spawn at 8,000 (at 2,400 before #64: 15.6/37.7/81.5/99.0 for the disc, 15.8/38.5/104.8/226.3
    // with the ring):
    //   disc with its atmosphere  4.7/11.3/24.3/28.8
    //   with the ring, if any     4.7/11.5/31.2/66.7 (the 16% that are ringed: 16.1/36.3/53.3/66.7)
    const drawn = Array.from({ length: 20_000 }, (_, i) => planetParams(hash(ENCOUNTER_BASE_SEED, i)));
    const discs = drawn.map((p) => spawnPx(p.radius * (1 + p.atmosphereThickness), p.radius * p.passFactor));
    const whole = drawn.map((p) => spawnPx(p.radius * p.extent, p.radius * p.passFactor));
    const rings = drawn.filter((p) => p.ring !== null).map((p) => spawnPx(p.radius * p.extent, p.radius * p.passFactor));
    const stats = (v: number[]) => [quantile(v, 0.1), quantile(v, 0.5), quantile(v, 0.9), Math.max(...v)];
    const [, discMedian, , discMax] = stats(discs);
    expect(discMedian).toBeLessThanOrEqual(12);
    expect(discMax).toBeLessThanOrEqual(30);
    // Ring included, the median planet is still under 12 px (most have no ring).
    const [, wholeMedian, wholeP90] = stats(whole);
    expect(wholeMedian).toBeLessThanOrEqual(12);
    expect(wholeP90).toBeLessThanOrEqual(32);
    // Any configured planet: the largest radius, the thickest atmosphere, at the largest k, about 29 px.
    const kMax = PLANET_PASS_FACTOR_RANGE[1];
    const largest = spawnPx(maxRadius * (1 + PLANET_GAS_RANGES.atmosphereThickness[1]), maxRadius * kMax);
    expect(largest).toBeLessThanOrEqual(30);
    for (const disc of discs) expect(disc).toBeLessThanOrEqual(largest + 1e-9);
    // A ring is thin and translucent, and the widest is more than twice the largest disc across: the
    // widest ring around the largest planet spans at most its outer diameter (seen face-on), about
    // 70 px. Under 30 px it would need a spawn about 18,500 out, past CAMERA_FAR.
    const widest = spawnPx(maxRadius * maxOuter, maxRadius * kMax);
    expect(widest).toBeLessThanOrEqual(72);
    for (const ring of rings) expect(ring).toBeLessThanOrEqual(widest + 1e-9);
    expect(quantile(rings, 0.5)).toBeLessThanOrEqual(40);
    expect(spawnPx(maxRadius * maxOuter, maxRadius * kMax, 18_600)).toBeLessThanOrEqual(30);
    expect(spawnPx(maxRadius * maxOuter, maxRadius * kMax, 18_400)).toBeGreaterThan(30);
    expect(18_400).toBeGreaterThan(CAMERA_FAR);
  });

  it('the far stars and galaxies stay behind it: the whole planet, ring and side offset included, is inside CAMERA_FAR at the spawn', () => {
    // The far layers are drawn at infinity before anything else and write no depth, so whatever is
    // inside the far plane paints over them (e2e/planet.spec.ts checks it at the spawn distance).
    const kMax = PLANET_PASS_FACTOR_RANGE[1];
    expect(Math.hypot(ENCOUNTER_DISTANCE, maxRadius * kMax) + maxRadius * maxOuter).toBeLessThan(CAMERA_FAR * 0.95);
  });

  it('at the spawn the 24-bit depth buffer keeps a ring behind the disc at least two steps behind it, so it never shows through (CAMERA_NEAR)', () => {
    // Window depth of a point at view distance z (standard perspective, [0, 1]), in steps of a 24-bit
    // depth buffer. The ring lies at least `inner` radii from the centre and the disc in front of it
    // within 1, so where the ring passes behind the disc it is at least sqrt(inner² - 1) radii behind
    // the disc's front, which is at most at the centre's depth (at the limb). The atmosphere shell
    // and the ring's near side are always in front of the disc, so their order is kept anyway.
    const step = (z: number, near: number, far: number) => Math.floor((((far + near) / (far - near) - (2 * far * near) / ((far - near) * z)) * 0.5 + 0.5) * (2 ** 24 - 1));
    const smallest = Math.min(PLANET_ROCKY_RANGES.radius[0], PLANET_ICY_RADIUS[0], PLANET_GAS_RANGES.radius[0]);
    const gap = smallest * Math.sqrt(PLANET_RING_RANGES.inner[0] ** 2 - 1);
    expect(gap).toBeGreaterThan(10);
    const farthest = Math.hypot(ENCOUNTER_DISTANCE, maxRadius * PLANET_PASS_FACTOR_RANGE[1]);
    for (let z = ENCOUNTER_DISTANCE - 500; z <= farthest; z += 0.37) {
      expect(step(z + gap, CAMERA_NEAR, CAMERA_FAR) - step(z, CAMERA_NEAR, CAMERA_FAR)).toBeGreaterThanOrEqual(2);
    }
    // With the near plane at 0.1, as before #64, the steps there were about 38 units: the same gap
    // would often share a step with the disc, and the ring behind it would show through.
    expect(step(farthest + gap, 0.1, CAMERA_FAR) - step(farthest, 0.1, CAMERA_FAR)).toBeLessThanOrEqual(1);
  });

  it('the atmosphere shell stays inside the guaranteed clearance, so the camera never enters it', () => {
    for (const ranges of [PLANET_ROCKY_RANGES, PLANET_GAS_RANGES]) {
      expect(ranges.atmosphereThickness[0]).toBeGreaterThan(0);
      expect(1 + ranges.atmosphereThickness[1]).toBeLessThan(1 + ENCOUNTER_CLEARANCE_MARGIN);
    }
    expect(1 + ENCOUNTER_CLEARANCE_MARGIN).toBeLessThan(PLANET_PASS_FACTOR_RANGE[0]);
  });

  it('the pass factor range leaves room for every planet: the distance floor and the widest ring clearance', () => {
    const [kMin, kMax] = PLANET_PASS_FACTOR_RANGE;
    expect(kMin).toBe(1.6);
    expect(kMax).toBe(6);
    // The smallest planet can reach the distance floor, and the widest ring its clearance.
    expect(PLANET_MIN_PASS_DISTANCE / minRadius).toBeLessThanOrEqual(kMax);
    expect(maxOuter * (1 + ENCOUNTER_CLEARANCE_MARGIN)).toBeLessThanOrEqual(kMax);
    // A ring starts outside the thickest atmosphere.
    expect(PLANET_RING_RANGES.inner[0]).toBeGreaterThan(1 + PLANET_GAS_RANGES.atmosphereThickness[1]);
    // passFactorFor spans its interval, from the low end at roll 0 to kMax just below roll 1.
    expect(passFactorFor(100, 1.1, 0)).toBeCloseTo(kMin, 12);
    expect(passFactorFor(15, 1.1, 0)).toBeCloseTo(PLANET_MIN_PASS_DISTANCE / 15, 12);
    expect(passFactorFor(100, 2.5, 0)).toBeCloseTo(2.5 * (1 + ENCOUNTER_CLEARANCE_MARGIN), 12);
    expect(passFactorFor(100, 1.1, 1 - 1e-12)).toBeCloseTo(kMax, 9);
    for (const roll of [0.1, 0.5, 0.9]) expect(passFactorFor(100, 1.1, roll)).toBeLessThan(passFactorFor(100, 1.1, roll + 0.05));
  });
});

describe('planetParams', () => {
  it('is deterministic', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      expect(planetParams(seed)).toEqual(planetParams(seed));
      expect(planetParams(seed).seed).toBe(seed);
    }
    expect(planetParams(0)).toEqual(planetParams(0));
    expect(planetParams(0xffffffff)).toEqual(planetParams(0xffffffff));
  });

  it('different seeds give different planets', () => {
    const keys = new Set(SEEDS.map((s) => JSON.stringify(planetParams(s))));
    expect(keys.size).toBe(SEEDS.length);
  });

  it('across 1,000 seeds both types occur at reasonable shares (each at least 20%)', () => {
    const gas = SEEDS.filter((s) => planetParams(s).type === 'gas').length;
    const rocky = SEEDS.length - gas;
    expect(gas / SEEDS.length).toBeGreaterThanOrEqual(0.2);
    expect(rocky / SEEDS.length).toBeGreaterThanOrEqual(0.2);
    // And close to the configured share.
    expect(gas / SEEDS.length).toBeCloseTo(PLANET_GAS_SHARE, 1);
  });

  it('across 1,000 seeds every palette family of both types occurs, icy dwarfs among the rocky ones', () => {
    const families = new Set(SEEDS.map((s) => `${planetParams(s).type}:${planetParams(s).family}`));
    const expected = [...ROCKY_FAMILY_NAMES.map((f) => `rocky:${f}`), ...GAS_FAMILY_NAMES.map((f) => `gas:${f}`)];
    expect([...families].sort()).toEqual(expected.sort());
    expect(ROCKY_FAMILY_NAMES.length).toBeGreaterThanOrEqual(9);
    expect(GAS_FAMILY_NAMES.length).toBeGreaterThanOrEqual(9);
    // Icy dwarfs (docs/PLAN.md section 9, Phase 4) are a rocky family, drawn with the rocky shader.
    expect(ROCKY_FAMILY_NAMES).toContain('icy');
    expect(GAS_FAMILY_NAMES).not.toContain('icy');
  });

  it('across 20,000 seeds the icy dwarf and ring shares are the documented ones', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => planetParams(hash(0x5a4e, i)));
    const rocky = many.filter((p) => p.type === 'rocky');
    const gas = many.filter((p) => p.type === 'gas');
    const share = (list: PlanetParams[], test: (p: PlanetParams) => boolean) => list.filter(test).length / list.length;
    // Binomial standard errors are under 0.7%; allow about 3 of them.
    expect(share(rocky, (p) => p.family === 'icy')).toBeCloseTo(PLANET_ICY_SHARE, 1);
    expect(Math.abs(share(rocky, (p) => p.family === 'icy') - PLANET_ICY_SHARE)).toBeLessThan(0.02);
    expect(Math.abs(share(gas, (p) => p.ring !== null) - PLANET_RING_SHARE.gas)).toBeLessThan(0.02);
    expect(Math.abs(share(rocky, (p) => p.ring !== null) - PLANET_RING_SHARE.rocky)).toBeLessThan(0.01);
    // Gas giants only otherwise: no icy gas giant.
    expect(share(gas, (p) => p.family === 'icy')).toBe(0);
    // Rings come in every size and tilt the ranges allow, around planets of both types.
    const rings = many.flatMap((p) => (p.ring === null ? [] : [p.ring]));
    const spread = (values: number[], [min, max]: readonly [number, number]) => (Math.max(...values) - Math.min(...values)) / (max - min);
    expect(spread(rings.map((r) => r.inner), PLANET_RING_RANGES.inner)).toBeGreaterThan(0.95);
    expect(spread(rings.map((r) => r.outer - r.inner), PLANET_RING_RANGES.width)).toBeGreaterThan(0.95);
    expect(spread(rings.map((r) => r.opening), PLANET_RING_RANGES.opening)).toBeGreaterThan(0.95);
    expect(rings.some((r) => r.roll > 0) && rings.some((r) => r.roll < 0)).toBe(true);
  });

  it('with the test default trip seed, the first 50 encounters include a ringed planet and an icy dwarf', () => {
    // The schedule the engine flies (docs/PLAN.md section 9, Phase 4: "Done when").
    const planets = encounterSchedule(DEFAULT_AUTOPILOT_PARAMS, 50)
      .filter((e) => e.kind === 'planet')
      .map((e) => planetParams(e.seed));
    expect(DEFAULT_AUTOPILOT_PARAMS.baseSeed).toBe(ENCOUNTER_BASE_SEED);
    expect(planets.filter((p) => p.ring !== null).length).toBeGreaterThanOrEqual(1);
    expect(planets.filter((p) => p.family === 'icy').length).toBeGreaterThanOrEqual(1);
    // And it still opens with the oceanic planet (src/tripSeed.test.ts checks the whole opening).
    expect(planets[0]!.family).toBe('oceanic');
  });

  it('an icy dwarf is small, pale and cratered, with bright, flat plains and dark patches', () => {
    const icy = SEEDS.map((s) => planetParams(s)).filter((p) => p.family === 'icy');
    expect(icy.length).toBeGreaterThan(50);
    const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (const p of icy) {
      if (p.type !== 'rocky') throw new Error('an icy gas giant');
      expect(p.radius).toBeGreaterThanOrEqual(PLANET_ICY_RADIUS[0]);
      expect(p.radius).toBeLessThanOrEqual(PLANET_ICY_RADIUS[1]);
      expect(p.craters).toBeGreaterThanOrEqual(0.25);
      // The plains (the basin colour) are the brightest tone, the lowland patches the darkest.
      expect(luma(p.palette[0])).toBeGreaterThan(0.7);
      expect(luma(p.palette[1])).toBeLessThan(0.3);
      expect(luma(p.palette[0])).toBeGreaterThan(luma(p.palette[2]));
      expect(p.atmosphereIntensity).toBeLessThanOrEqual(0.35);
    }
  });

  it("every rocky family's sub-ranges lie inside the configured rocky ranges", () => {
    for (const [i, family] of ROCKY_FAMILY_RANGES.entries()) {
      for (const [key, [min, max]] of Object.entries(family)) {
        const range = PLANET_ROCKY_RANGES[key as keyof typeof family];
        const label = `${ROCKY_FAMILY_NAMES[i]}: ${key}`;
        expect(min, label).toBeLessThanOrEqual(max);
        expect(min, label).toBeGreaterThanOrEqual(range[0]);
        expect(max, label).toBeLessThanOrEqual(range[1]);
      }
    }
  });

  it('across 1,000 seeds the atmosphere colours vary within each family, and so do band counts and tilts', () => {
    const colours = new Map<string, Set<string>>();
    for (const seed of SEEDS) {
      const p = planetParams(seed);
      if (p.atmosphereIntensity === 0) continue;
      const key = `${p.type}:${p.family}`;
      if (!colours.has(key)) colours.set(key, new Set());
      colours.get(key)!.add(p.atmosphereColor.map((c) => c.toFixed(3)).join(','));
    }
    for (const [family, set] of colours) expect(set.size, family).toBeGreaterThan(5);
    // The seeded values spread across their configured ranges (not bunched in one corner).
    const spread = (values: number[], [min, max]: readonly [number, number]) =>
      (Math.max(...values) - Math.min(...values)) / (max - min);
    const params = SEEDS.map((s) => planetParams(s));
    const gas = params.filter((p) => p.type === 'gas');
    const rocky = params.filter((p) => p.type === 'rocky');
    expect(spread(gas.map((p) => (p.type === 'gas' ? p.bandFrequency : 0)), PLANET_GAS_RANGES.bandFrequency)).toBeGreaterThan(0.95);
    expect(spread(gas.map((p) => p.radius), PLANET_GAS_RANGES.radius)).toBeGreaterThan(0.95);
    expect(spread(rocky.map((p) => p.radius), PLANET_ROCKY_RANGES.radius)).toBeGreaterThan(0.95);
    expect(spread(rocky.map((p) => p.noiseScale), PLANET_ROCKY_RANGES.noiseScale)).toBeGreaterThan(0.95);
    for (const [list, ranges] of [
      [gas, PLANET_GAS_RANGES],
      [rocky, PLANET_ROCKY_RANGES],
    ] as const) {
      expect(spread(list.map((p) => p.axialTilt), ranges.axialTilt)).toBeGreaterThan(0.95);
      expect(spread(list.map((p) => p.rotationSpeed), ranges.rotationSpeed)).toBeGreaterThan(0.95);
      expect(spread(list.map((p) => p.atmosphereIntensity), ranges.atmosphereIntensity)).toBeGreaterThan(0.8);
    }
  });

  it('across 1,000 seeds all numeric params lie within the configured ranges', () => {
    for (const seed of SEEDS) {
      const params = planetParams(seed);
      const ranges: Readonly<Record<string, readonly [number, number]>> =
        params.type === 'gas'
          ? PLANET_GAS_RANGES
          : params.family === 'icy'
            ? { ...PLANET_ROCKY_RANGES, radius: PLANET_ICY_RADIUS }
            : PLANET_ROCKY_RANGES;
      const label = `seed ${seed} (${params.type})`;
      for (const [key, value] of Object.entries(params)) {
        if (NON_RANGE_FIELDS.has(key)) continue;
        const range = ranges[key];
        expect(range, `${label}: no configured range for ${key}`).toBeDefined();
        expect(typeof value, `${label}: ${key}`).toBe('number');
        expect(value as number, `${label}: ${key}`).toBeGreaterThanOrEqual(range![0]);
        expect(value as number, `${label}: ${key}`).toBeLessThanOrEqual(range![1]);
      }
      // Every configured range is used.
      for (const key of Object.keys(ranges)) expect(params, label).toHaveProperty(key);
      expect(Number.isInteger(params.octaves), label).toBe(true);
      expect(params.rotationPhase, label).toBeGreaterThanOrEqual(PLANET_ROTATION_PHASE_RANGE[0]);
      expect(params.rotationPhase, label).toBeLessThan(PLANET_ROTATION_PHASE_RANGE[1]);
      expect(params.noiseOffset, label).toHaveLength(3);
      for (const o of params.noiseOffset) {
        expect(o, label).toBeGreaterThanOrEqual(PLANET_NOISE_OFFSET_RANGE[0]);
        expect(o, label).toBeLessThanOrEqual(PLANET_NOISE_OFFSET_RANGE[1]);
      }
      expect(params.palette, label).toHaveLength(4);
      params.palette.forEach((c, i) => expectRgb(c, `${label}: palette[${i}]`));
      expectRgb(params.atmosphereColor, `${label}: atmosphereColor`);
      // The pass factor and the extent (docs/PLAN.md section 9, Phase 4).
      expect(params.passFactor, label).toBeGreaterThanOrEqual(PLANET_PASS_FACTOR_RANGE[0]);
      expect(params.passFactor, label).toBeLessThanOrEqual(PLANET_PASS_FACTOR_RANGE[1]);
      expect(params.radius * params.passFactor, label).toBeGreaterThanOrEqual(PLANET_MIN_PASS_DISTANCE * (1 - 1e-12));
      expect(params.passFactor, label).toBeGreaterThanOrEqual(params.extent * (1 + ENCOUNTER_CLEARANCE_MARGIN));
      const ring = params.ring;
      if (ring === null) {
        expect(params.extent, label).toBe(1 + params.atmosphereThickness);
        continue;
      }
      expect(params.extent, label).toBe(ring.outer);
      const g = PLANET_RING_RANGES;
      for (const [value, range, name] of [
        [ring.inner, g.inner, 'inner'],
        [ring.outer - ring.inner, g.width, 'width'],
        [ring.opacity, g.opacity, 'opacity'],
        [ring.bands, g.bands, 'bands'],
        [ring.bandOffset, g.bandOffset, 'bandOffset'],
        [ring.gap, g.gap, 'gap'],
        [ring.gapWidth, g.gapWidth, 'gapWidth'],
        [ring.opening, g.opening, 'opening'],
        [Math.abs(ring.roll), g.roll, 'roll'],
      ] as const) {
        expect(value, `${label}: ring ${name}`).toBeGreaterThanOrEqual(range[0] - 1e-12);
        expect(value, `${label}: ring ${name}`).toBeLessThanOrEqual(range[1] + 1e-12);
      }
      ring.colors.forEach((c, i) => expectRgb(c, `${label}: ring colour ${i}`));
    }
  });

  it('keeps every Phase 3 draw: the type and family of every planet but an icy dwarf are as before Phase 4', () => {
    // planetParams(hash(0x5eed, i)) for i = 0…39 before Phase 4 (main at #45), as `type:family`.
    // The Phase 4 variety comes from a stream of its own, so only an icy dwarf, which replaces its
    // family's look, differs; the test default trip seed therefore opens as it did.
    const phase3 = [
      'gas:saturnian', 'gas:neptunian', 'rocky:sulphur', 'rocky:lunar', 'rocky:oceanic', 'gas:neptunian', 'rocky:sulphur', 'gas:ember',
      'gas:ember', 'rocky:lunar', 'gas:rose', 'gas:saturnian', 'rocky:lunar', 'gas:uranian', 'rocky:lunar', 'gas:uranian',
      'rocky:terran', 'rocky:oceanic', 'rocky:volcanic', 'rocky:sulphur', 'gas:ember', 'gas:uranian', 'gas:violet', 'rocky:lunar',
      'gas:violet', 'rocky:sulphur', 'rocky:ferric', 'gas:emerald', 'rocky:terran', 'rocky:ferric', 'gas:jovian', 'gas:uranian',
      'gas:jovian', 'rocky:terran', 'rocky:oceanic', 'gas:violet', 'rocky:oceanic', 'rocky:ferric', 'gas:jovian', 'gas:ember',
    ];
    let icy = 0;
    phase3.forEach((before, i) => {
      const p = planetParams(hash(0x5eed, i));
      if (p.family === 'icy') {
        icy++;
        expect(before.startsWith('rocky:'), `${i}`).toBe(true);
      } else {
        expect(`${p.type}:${p.family}`, `${i}`).toBe(before);
      }
    });
    expect(icy).toBeGreaterThan(0);
    expect(icy).toBeLessThan(phase3.length / 4);
  });

  it('plugs into the autopilot as planetFor: the encounter uses the seeded radius', () => {
    const params = { ...DEFAULT_AUTOPILOT_PARAMS, interval: 1, nebulaShare: 0, planetFor: planetParams };
    const ship = createShipState();
    let state = createAutopilotState(params);
    for (let i = 0; i < 20 && state.encounter === null; i++) state = updateAutopilot(state, ship, 0.1, params);
    const encounter = state.encounter!;
    expect(encounter).not.toBeNull();
    const expected = planetParams(hash(ENCOUNTER_BASE_SEED, 0));
    expect(encounter.kind === 'planet' && encounter.planet).toEqual(expected);
    expect(encounter.plan.radius).toBe(expected.radius);
    // At its own pass factor.
    expect(encounter.plan.closestDistance).toBeCloseTo(expected.radius * expected.passFactor, 9);
  });
});

/** Every material on the planet's meshes. */
function materialsOf(planet: Planet) {
  const materials: { dispose(): void; uniforms: Record<string, { value: unknown }> }[] = [];
  planet.object.traverse((o) => {
    const m = (o as { material?: unknown }).material;
    if (m) materials.push(m as (typeof materials)[number]);
  });
  return materials;
}

describe('Planet', () => {
  afterEach(() => {
    disposePlanetGeometry();
    vi.restoreAllMocks();
  });

  it.each(['rocky', 'gas'] as const)('builds a %s planet from its params', (type) => {
    const params = firstOfType(type);
    const planet = new Planet(params);
    expect(planet.object.scale.x).toBeCloseTo(params.radius, 9);
    const materials = materialsOf(planet);
    // Surface plus atmosphere shell (both test planets have an atmosphere).
    expect(params.atmosphereIntensity).toBeGreaterThan(0);
    expect(materials).toHaveLength(2);
    const surface = materials[0]!;
    expect((surface as unknown as { defines: Record<string, unknown> }).defines.PLANET_GAS !== undefined).toBe(type === 'gas');
    planet.dispose();
  });

  it('an airless planet has no atmosphere shell', () => {
    const seed = SEEDS.find((s) => planetParams(s).atmosphereIntensity === 0);
    expect(seed).toBeDefined();
    const planet = new Planet(planetParams(seed!));
    expect(materialsOf(planet)).toHaveLength(1);
    planet.dispose();
  });

  it('dispose() frees its materials and textures, and only the last live planet frees the shared geometry', () => {
    const geometry = planetGeometry();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    // The atmosphere's annulus (issue #65) is shared and freed with the sphere.
    const annulus = atmosphereGeometry();
    const annulusDispose = vi.spyOn(annulus, 'dispose');
    // A planet kept alive throughout holds the shared geometry while the others come and go.
    const keeper = new Planet(firstOfType('gas'));
    expect(planetGeometryRefs()).toBe(1);
    for (const type of ['rocky', 'gas'] as const) {
      const planet = new Planet(firstOfType(type));
      expect(planetGeometryRefs()).toBe(2);
      const materials = materialsOf(planet);
      const materialSpies = materials.map((m) => vi.spyOn(m, 'dispose'));
      const textures = materials.flatMap((m) =>
        Object.values(m.uniforms)
          .map((u) => u.value)
          .filter((v): v is Texture => v instanceof Texture),
      );
      const textureSpies = textures.map((t) => vi.spyOn(t, 'dispose'));
      // Every mesh draws with the one shared geometry, and the atmosphere with the shared annulus.
      planet.object.traverse((o) => {
        const g = (o as { geometry?: unknown }).geometry;
        if (g) expect(g).toBe(o === planet.atmosphere ? annulus : geometry);
      });
      expect(planet.atmosphere).not.toBeNull();

      planet.dispose();
      for (const spy of [...materialSpies, ...textureSpies]) expect(spy).toHaveBeenCalledTimes(1);
      // Disposing twice is harmless and drops the reference only once.
      planet.dispose();
      for (const spy of materialSpies) expect(spy).toHaveBeenCalledTimes(1);
      expect(planetGeometryRefs()).toBe(1);
    }
    // Still held by the keeper: neither the planets nor the teardown free it.
    disposePlanetGeometry();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(planetGeometry()).toBe(geometry);

    // The last live planet frees it, once, and the next planet gets a fresh one.
    keeper.dispose();
    expect(planetGeometryRefs()).toBe(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(annulusDispose).toHaveBeenCalledTimes(1);
    expect(atmosphereGeometry()).not.toBe(annulus);
    keeper.dispose();
    disposePlanetGeometry();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    const later = new Planet(firstOfType('rocky'));
    expect(planetGeometry()).not.toBe(geometry);
    later.dispose();
  });

  it('dispose() removes the planet from its parent', () => {
    const planet = new Planet(firstOfType('gas'));
    const parent = new (planet.object.constructor as new () => typeof planet.object)();
    parent.add(planet.object);
    planet.dispose();
    expect(planet.object.parent).toBeNull();
  });

  it('setFade drives one opacity uniform shared by every material, and hides the planet at 0', () => {
    const planet = new Planet(firstOfType('gas'));
    const materials = materialsOf(planet);
    planet.setFade(0.4);
    for (const m of materials) expect(m.uniforms.uOpacity!.value).toBe(0.4);
    expect(planet.object.visible).toBe(true);
    planet.setFade(0);
    expect(planet.object.visible).toBe(false);
    planet.setFade(2);
    expect(planet.uniforms.uOpacity.value).toBe(1);
    expect(planet.object.visible).toBe(true);
    planet.setFade(-1);
    expect(planet.uniforms.uOpacity.value).toBe(0);
    planet.dispose();
  });

  it('draws its surface before the depth-tested starfield with depth writes, and its atmosphere after', () => {
    const planet = new Planet(firstOfType('gas'));
    const meshes: Mesh[] = [];
    planet.object.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    const surface = meshes.find((m) => m.parent !== planet.object)!;
    const atmosphere = meshes.find((m) => m.parent === planet.object)!;
    expect(surface).toBeDefined();
    expect(atmosphere).toBeDefined();
    const starfield = new Starfield();
    const stars = starfield.mesh;
    // All three are in Three.js's transparent list, which draws in ascending renderOrder.
    for (const m of [surface, atmosphere, stars]) expect((m.material as ShaderMaterial).transparent).toBe(true);
    expect(stars.renderOrder).toBe(STARFIELD_RENDER_ORDER);
    expect(surface.renderOrder).toBeLessThan(stars.renderOrder);
    expect(atmosphere.renderOrder).toBeGreaterThan(stars.renderOrder);
    // The surface's depth hides only the stars behind it; nothing else writes depth.
    const surfaceMaterial = surface.material as ShaderMaterial;
    expect(surfaceMaterial.depthTest).toBe(true);
    expect(surfaceMaterial.depthWrite).toBe(true);
    expect(stars.material.depthTest).toBe(true);
    expect(stars.material.depthWrite).toBe(false);
    const atmosphereMaterial = atmosphere.material as ShaderMaterial;
    expect(atmosphereMaterial.depthTest).toBe(true);
    expect(atmosphereMaterial.depthWrite).toBe(false);
    starfield.dispose();
    planet.dispose();
  });

  it('a ringed planet adds its ring, drawn with the halo program after the surface and before the starfield, depth-tested and writing depth', () => {
    const params = firstOfType('gas', true);
    const ring = params.ring!;
    const planet = new Planet(params);
    expect(planet.ring).not.toBeNull();
    const ringMesh = planet.ring!;
    const ringMaterial = ringMesh.material;
    const meshes: Mesh[] = [];
    planet.object.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    const surface = meshes.find((m) => m.renderOrder === SURFACE_RENDER_ORDER)!;
    const atmosphere = planet.atmosphere!;
    expect(meshes).toHaveLength(3);
    expect(meshes).toContain(atmosphere);
    // Order: far stars, surface, atmosphere, ring, near stars (all in the transparent list). The
    // atmosphere draws before the ring, so the ring blends over its glow rather than hiding it.
    expect(ringMesh.renderOrder).toBe(RING_RENDER_ORDER);
    expect(atmosphere.renderOrder).toBe(RINGED_ATMOSPHERE_RENDER_ORDER);
    expect(RINGED_ATMOSPHERE_RENDER_ORDER).toBeGreaterThan(SURFACE_RENDER_ORDER);
    expect(RING_RENDER_ORDER).toBeGreaterThan(RINGED_ATMOSPHERE_RENDER_ORDER);
    expect(RING_RENDER_ORDER).toBeLessThan(STARFIELD_RENDER_ORDER);
    // A planet without a ring keeps its atmosphere after the near stars.
    const plain = new Planet(firstOfType('gas'));
    expect(plain.ring).toBeNull();
    expect(plain.atmosphere!.renderOrder).toBe(ATMOSPHERE_RENDER_ORDER);
    plain.dispose();
    expect(ringMaterial.transparent).toBe(true);
    // The planet's depth hides the ring behind its disc; the ring's hides the near stars behind it.
    expect(ringMaterial.depthTest).toBe(true);
    expect(ringMaterial.depthWrite).toBe(true);
    // The halo program: the atmosphere's sources, no defines, front faces only, so no new program.
    const atmosphereMaterial = atmosphere.material as ShaderMaterial;
    expect(ringMaterial.vertexShader).toBe(atmosphereMaterial.vertexShader);
    expect(ringMaterial.fragmentShader).toBe(atmosphereMaterial.fragmentShader);
    expect(ringMaterial.defines).toEqual(atmosphereMaterial.defines);
    expect(ringMaterial.side).toBe(atmosphereMaterial.side);
    expect(ringMaterial.side).toBe(FrontSide);
    expect(ringMaterial.uniforms.uRing!.value).toBe(1);
    expect(atmosphereMaterial.uniforms.uRing!.value).toBe(0);
    // It fades and is lit with the planet.
    expect(ringMaterial.uniforms.uOpacity).toBe(planet.uniforms.uOpacity);
    expect(ringMaterial.uniforms.uLightDir).toBe(planet.uniforms.uLightDir);
    expect(ringMaterial.uniforms.uRingOuter!.value).toBe(ring.outer);
    // It adds the planet's own glow in front of its far side.
    expect(atmosphereMaterial.depthTest).toBe(true);
    expect(atmosphereMaterial.depthWrite).toBe(false);
    for (const name of ['uAtmosphereColor', 'uAtmosphereIntensity', 'uThickness'] as const) {
      expect(ringMaterial.uniforms[name]).toBe(planet.uniforms[name]);
    }
    // The ring and the spin axis share the tilt, so a gas giant's bands run along its ring.
    expect(ringMesh.parent).toBe(surface.parent);
    planet.dispose();
  });

  it('the ring geometry is a flat annulus within [inner, outer] with both windings, and freed with its planet', () => {
    const geometry = ringGeometry(1.4, 2.5);
    const plain = new RingGeometry(1.4, 2.5, 160, 1);
    const position = geometry.getAttribute('position');
    let outermost = 0;
    let innermost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < position.count; i++) {
      const p = new Vector3().fromBufferAttribute(position, i);
      // In the XZ plane: its normal is the mesh's local +Y.
      expect(Math.abs(p.y)).toBeLessThan(1e-9);
      outermost = Math.max(outermost, p.length());
      innermost = Math.min(innermost, p.length());
    }
    // To float32 precision (the outer edge's chords lie inside the circle).
    expect(outermost).toBeCloseTo(2.5, 6);
    expect(innermost).toBeCloseTo(1.4, 6);
    // Both windings: every triangle twice, once each way round.
    expect(geometry.getIndex()!.count).toBe(2 * plain.getIndex()!.count);
    expect(Object.keys(geometry.attributes).sort()).toEqual(Object.keys(planetGeometry().attributes).sort());
    plain.dispose();
    geometry.dispose();

    const planet = new Planet(firstOfType('gas', true));
    const ring = planet.ring!;
    const geometryDispose = vi.spyOn(ring.geometry, 'dispose');
    const materialDispose = vi.spyOn(ring.material, 'dispose');
    planet.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(planetGeometryRefs()).toBe(0);
  });

  it('ringAxis tilts the ring toward the approach by its opening and about the path by its roll, as the planet draws it', () => {
    const frames = [
      DEFAULT_PLANET_FRAME,
      planEncounter({ x: 0, y: 0, z: 0 }, { x: 0.4, y: -0.1, z: -1 }, 50, ENCOUNTER_DISTANCE, 3, 2.7),
      planEncounter({ x: 0, y: 0, z: 0 }, { x: -0.8, y: 0.2, z: -0.3 }, 50, ENCOUNTER_DISTANCE, 3, -0.4),
    ];
    const base = firstOfType('gas', true);
    for (const frame of frames) {
      for (const [opening, roll] of [
        [0.3, 0.2],
        [0.6, -0.45],
      ] as const) {
        const axis = ringAxis({ opening, roll }, frame, { x: 0, y: 0, z: 0 });
        const d = frame.direction;
        const side = frame.side;
        expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 12);
        // Seen from ahead (along -direction) the ring opens by `opening`; from the closest approach
        // (along -side) by asin(cos(opening) sin(roll)).
        expect(-(axis.x * d.x + axis.y * d.y + axis.z * d.z)).toBeCloseTo(Math.sin(opening), 12);
        expect(axis.x * side.x + axis.y * side.y + axis.z * side.z).toBeCloseTo(Math.cos(opening) * Math.sin(roll), 12);
        // The planet's ring mesh and spin axis follow it.
        const planet = new Planet({ ...base, ring: { ...base.ring!, opening, roll } }, undefined, frame);
        planet.object.updateMatrixWorld(true);
        const up = new Vector3(0, 1, 0).transformDirection(planet.ring!.matrixWorld);
        expect(up.x).toBeCloseTo(axis.x, 9);
        expect(up.y).toBeCloseTo(axis.y, 9);
        expect(up.z).toBeCloseTo(axis.z, 9);
        planet.dispose();
      }
    }
  });

  it('an icy dwarf draws with the rocky surface program', () => {
    const icy = firstIcy();
    const rocky = new Planet(firstOfType('rocky'));
    const planet = new Planet(icy);
    const surfaceOf = (p: Planet) => materialsOf(p)[0] as unknown as ShaderMaterial;
    expect(surfaceOf(planet).fragmentShader).toBe(surfaceOf(rocky).fragmentShader);
    expect(surfaceOf(planet).defines).toEqual(surfaceOf(rocky).defines);
    expect(surfaceOf(planet).uniforms.uCraters!.value).toBe(icy.type === 'rocky' && icy.craters);
    planet.dispose();
    rocky.dispose();
  });

  it('setScale, setLightDirection and update', () => {
    const params = firstOfType('rocky');
    const planet = new Planet(params);
    planet.setScale(0.15);
    expect(planet.object.scale.x).toBeCloseTo(params.radius * 0.15, 9);
    planet.setLightDirection(0, 0, 2);
    expect(planet.uniforms.uLightDir.value.toArray()).toEqual([0, 0, 1]);
    for (const m of materialsOf(planet)) expect(m.uniforms.uLightDir!.value).toBe(planet.uniforms.uLightDir.value);

    // The surface spins about the (tilted) axis at the seeded speed.
    let surface: { rotation: { y: number } } | null = null;
    planet.object.traverse((o) => {
      const m = (o as { material?: { defines?: object } }).material;
      if (m && o.parent !== planet.object) surface = o as unknown as { rotation: { y: number } };
    });
    expect(surface).not.toBeNull();
    planet.update(10);
    expect(surface!.rotation.y).toBeCloseTo(params.rotationPhase + 10 * params.rotationSpeed, 9);
    planet.dispose();
  });
});
