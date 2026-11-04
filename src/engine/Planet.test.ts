import { Texture } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_FAR,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_PLANET_RADIUS,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  ENCOUNTER_SPAWN_SCALE,
  PLANET_GAS_RANGES,
  PLANET_GAS_SHARE,
  PLANET_NOISE_OFFSET_RANGE,
  PLANET_ROCKY_RANGES,
  PLANET_ROTATION_PHASE_RANGE,
} from '../config';
import { DEFAULT_AUTOPILOT_PARAMS, createAutopilotState, updateAutopilot } from './Autopilot';
import { Planet, disposePlanetGeometry, planetGeometry, planetParams, type PlanetParams, type Rgb } from './Planet';
import { hash } from './seed';
import { createShipState } from './Ship';

const SEEDS = Array.from({ length: 1000 }, (_, i) => hash(ENCOUNTER_BASE_SEED, i));

/** Fields checked separately (not plain numbers within a type's range table). */
const NON_RANGE_FIELDS = new Set(['seed', 'type', 'family', 'palette', 'noiseOffset', 'rotationPhase', 'atmosphereColor']);

function firstOfType(type: PlanetParams['type']): PlanetParams {
  const seed = SEEDS.find((s) => planetParams(s).type === type);
  if (seed === undefined) throw new Error(`no ${type} seed`);
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
  const minRadius = Math.min(PLANET_ROCKY_RANGES.radius[0], PLANET_GAS_RANGES.radius[0]);
  const maxRadius = Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1]);

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
    // At spawn the planet is a distant dot: its spawn-scaled angular radius is under about 1°.
    expect((ENCOUNTER_SPAWN_SCALE * maxRadius) / ENCOUNTER_DISTANCE).toBeLessThan(0.018);
    // Its whole sphere starts beyond the slowdown, so the encounter starts at cruise speed.
    expect(ENCOUNTER_DISTANCE - maxRadius).toBeGreaterThan(ENCOUNTER_SLOWDOWN_DISTANCE);
    expect(ENCOUNTER_DISTANCE + maxRadius * (ENCOUNTER_SIDE_OFFSET_FACTOR + 1)).toBeLessThan(CAMERA_FAR);
    // The placeholder radius the autopilot uses today lies inside the seeded range.
    expect(ENCOUNTER_PLANET_RADIUS).toBeGreaterThanOrEqual(minRadius);
    expect(ENCOUNTER_PLANET_RADIUS).toBeLessThanOrEqual(maxRadius);
  });

  it('the atmosphere shell stays inside the guaranteed clearance, so the camera never enters it', () => {
    for (const ranges of [PLANET_ROCKY_RANGES, PLANET_GAS_RANGES]) {
      expect(ranges.atmosphereThickness[0]).toBeGreaterThan(0);
      expect(1 + ranges.atmosphereThickness[1]).toBeLessThan(1 + ENCOUNTER_CLEARANCE_MARGIN);
    }
    expect(1 + ENCOUNTER_CLEARANCE_MARGIN).toBeLessThan(ENCOUNTER_SIDE_OFFSET_FACTOR);
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

  it('every palette family occurs', () => {
    const families = new Set(SEEDS.map((s) => `${planetParams(s).type}:${planetParams(s).family}`));
    expect(families.size).toBeGreaterThanOrEqual(8);
  });

  it('across 1,000 seeds all numeric params lie within the configured ranges', () => {
    for (const seed of SEEDS) {
      const params = planetParams(seed);
      const ranges: Readonly<Record<string, readonly [number, number]>> =
        params.type === 'gas' ? PLANET_GAS_RANGES : PLANET_ROCKY_RANGES;
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
    }
  });

  it('plugs into the autopilot as planetFor: the encounter uses the seeded radius', () => {
    const params = { ...DEFAULT_AUTOPILOT_PARAMS, interval: 1, driftSettleTime: 0.5, planetFor: planetParams };
    const ship = createShipState();
    let state = createAutopilotState(params);
    for (let i = 0; i < 20 && state.encounter === null; i++) state = updateAutopilot(state, ship, 0.1, params);
    const encounter = state.encounter!;
    expect(encounter).not.toBeNull();
    const expected = planetParams(hash(ENCOUNTER_BASE_SEED, 0));
    expect(encounter.planet).toEqual(expected);
    expect(encounter.plan.radius).toBe(expected.radius);
    expect(encounter.plan.closestDistance).toBeCloseTo(expected.radius * ENCOUNTER_SIDE_OFFSET_FACTOR, 9);
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

  it('dispose() frees its materials and textures but never the shared geometry', () => {
    const geometry = planetGeometry();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    for (const type of ['rocky', 'gas'] as const) {
      const planet = new Planet(firstOfType(type));
      const materials = materialsOf(planet);
      const materialSpies = materials.map((m) => vi.spyOn(m, 'dispose'));
      const textures = materials.flatMap((m) =>
        Object.values(m.uniforms)
          .map((u) => u.value)
          .filter((v): v is Texture => v instanceof Texture),
      );
      const textureSpies = textures.map((t) => vi.spyOn(t, 'dispose'));
      // Every mesh draws with the one shared geometry.
      planet.object.traverse((o) => {
        const g = (o as { geometry?: unknown }).geometry;
        if (g) expect(g).toBe(geometry);
      });

      planet.dispose();
      for (const spy of [...materialSpies, ...textureSpies]) expect(spy).toHaveBeenCalledTimes(1);
      // Disposing twice is harmless.
      planet.dispose();
      for (const spy of materialSpies) expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(geometryDispose).not.toHaveBeenCalled();
    // A planet created after others were disposed still shares the same geometry.
    const later = new Planet(firstOfType('rocky'));
    expect(planetGeometry()).toBe(geometry);
    later.dispose();
    expect(geometryDispose).not.toHaveBeenCalled();

    // The module-level teardown frees it, once, and the next planet gets a fresh one.
    disposePlanetGeometry();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    disposePlanetGeometry();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(planetGeometry()).not.toBe(geometry);
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
