// Long-run stability at the simulation level (docs/PLAN.md sections 5, 6 Performance and 9 Phase 3):
// 100 accelerated encounters through the engine's own frame sequence (stepTravel, then the
// encounter view's sync and place) leave every encounter resource freed, with the scene and the
// shared geometries back at their baseline after each one. Asteroids and comets (Phase 4) own their
// geometries (the rocks', the nucleus's and the glow's), so those are checked to be freed too, over
// long runs of asteroids alone and of comets alone.
import { Scene, type BufferGeometry, type Material, type Object3D } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { DT_CAP_SECONDS, SHIP_SPEED_LEVELS } from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  createTravel,
  encounterProfile,
  setCruiseSpeed,
  stepTravel,
  type AutopilotParams,
  type EncounterKind,
  type Travel,
} from './Autopilot';
import { asteroidParams } from './Asteroid';
import { cometParams } from './Comet';
import { EncounterView } from './EncounterView';
import { disposeNebulaGeometry, nebulaGeometryRefs, nebulaParams } from './Nebula';
import { disposePlanetGeometry, planetGeometryRefs, planetParams, planetProgramMaterials } from './Planet';
import { mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS } from './Ship';

afterEach(() => {
  disposePlanetGeometry();
  disposeNebulaGeometry();
});

/** Engine-like params: seeded planets, nebulae, asteroids and comets in the default mix (or `overrides`), a short interval, top speed. */
function longRunParams(interval: number, overrides: Partial<AutopilotParams> = {}): AutopilotParams {
  const params: AutopilotParams = {
    ...DEFAULT_AUTOPILOT_PARAMS,
    interval,
    planetFor: planetParams,
    nebulaFor: nebulaParams,
    asteroidFor: asteroidParams,
    cometFor: cometParams,
    ...overrides,
  };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
  return params;
}

/** What a material's shader program is keyed on, as far as these materials differ: its sources and defines. */
function programKey(material: Material): string {
  const s = material as Material & { vertexShader?: string; fragmentShader?: string; defines?: object };
  return `${s.vertexShader}\n${s.fragmentShader}\n${JSON.stringify(s.defines ?? {})}`;
}

/**
 * Counts live GPU-side resources the way `renderer.info.memory` does: a geometry or material is
 * live from when an encounter object holding it is created until its `dispose` event fires.
 */
class ResourceLedger {
  readonly geometries = new Set<BufferGeometry>();
  readonly materials = new Set<Material>();
  /** Distinct shader sources among live materials (what `renderer.info.programs` would hold). */
  programs(): number {
    return this.programKeys().size;
  }

  /** The program key (shader sources and defines) of every live material. */
  programKeys(): Set<string> {
    const keys = new Set<string>();
    for (const m of this.materials) keys.add(programKey(m));
    return keys;
  }

  track(root: Object3D): void {
    root.traverse((o) => {
      const mesh = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
      const geometry = mesh.geometry;
      if (geometry !== undefined && !this.geometries.has(geometry)) {
        this.geometries.add(geometry);
        geometry.addEventListener('dispose', () => this.geometries.delete(geometry));
      }
      const materials = mesh.material === undefined ? [] : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (this.materials.has(material)) continue;
        this.materials.add(material);
        material.addEventListener('dispose', () => this.materials.delete(material));
      }
    });
  }
}

interface LongRunResult {
  kinds: Record<EncounterKind, number>;
  /** Planet encounters whose planet had a ring. */
  ringed: number;
  /** Encounters whose return to CRUISE left something behind, with what. */
  leaks: string[];
  /** Largest per-frame step beyond what the ship's speed allows (≤ 0 is fine). */
  worstJump: number;
  /** Peak live resources during an encounter, by kind. */
  peak: Record<EncounterKind, { geometries: number; materials: number; programs: number }>;
  /** Asteroid encounters that were a field of several rocks, and the most rocks in one. */
  fields: number;
  mostRocks: number;
  /** The program keys asteroid rocks drew with. */
  asteroidPrograms: Set<string>;
  /** The program keys comets drew with, and comet encounters drawn without their tails. */
  cometPrograms: Set<string>;
  tailless: number;
  frames: number;
}

/** Runs `count` encounters with engine-like frames of `dt(i)` seconds and audits every return to CRUISE. */
function runEncounters(travel: Travel, count: number, dt: (frame: number) => number): LongRunResult {
  const scene = new Scene();
  const view = new EncounterView(scene);
  const ledger = new ResourceLedger();
  const result: LongRunResult = {
    kinds: { planet: 0, nebula: 0, asteroid: 0, comet: 0 },
    ringed: 0,
    leaks: [],
    worstJump: Number.NEGATIVE_INFINITY,
    peak: {
      planet: { geometries: 0, materials: 0, programs: 0 },
      nebula: { geometries: 0, materials: 0, programs: 0 },
      asteroid: { geometries: 0, materials: 0, programs: 0 },
      comet: { geometries: 0, materials: 0, programs: 0 },
    },
    fields: 0,
    mostRocks: 0,
    asteroidPrograms: new Set(),
    cometPrograms: new Set(),
    tailless: 0,
    frames: 0,
  };
  let tracked: object | null = null;
  let state = travel.autopilot.state;
  const prev = { x: 0, y: 0, z: 0 };
  // At most ~10 minutes of simulated travel per encounter at the shortest frame.
  const limit = count * 6_000 * 10;
  for (let i = 0; i < limit && travel.autopilot.encounterCount <= count; i++) {
    const p = travel.ship.position;
    prev.x = p.x;
    prev.y = p.y;
    prev.z = p.z;
    const speedBefore = travel.ship.speed;
    // The engine's frame: simulation step, encounter sync, then placement before the render.
    stepTravel(travel, dt(i));
    view.sync(travel.autopilot);
    const kind = travel.autopilot.encounter?.kind ?? 'planet';
    view.place(travel.autopilot, travel.ship, encounterProfile(travel.autopilotParams, kind));
    result.frames++;

    const moved = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    result.worstJump = Math.max(result.worstJump, moved - Math.max(speedBefore, travel.ship.speed) * DT_CAP_SECONDS);

    const current = view.getObject();
    if (current !== null && current !== tracked) {
      tracked = current;
      ledger.track(current.object);
      const kind = travel.autopilot.encounter!.kind;
      result.kinds[kind]++;
      if (view.getPlanet()?.ring) result.ringed++;
      const asteroid = view.getAsteroid();
      if (asteroid !== null) {
        if (asteroid.rocks.length > 1) result.fields++;
        result.mostRocks = Math.max(result.mostRocks, asteroid.rocks.length);
        // One geometry and one material per rock.
        if (ledger.geometries.size !== asteroid.rocks.length) result.leaks.push(`asteroid with ${asteroid.rocks.length} rocks holds ${ledger.geometries.size} geometries`);
        for (const key of ledger.programKeys()) result.asteroidPrograms.add(key);
      }
      const comet = view.getComet();
      if (comet !== null) {
        // The nucleus and the glow: one geometry and one material each.
        if (ledger.geometries.size !== 2) result.leaks.push(`comet holds ${ledger.geometries.size} geometries`);
        if (!comet.params.tails) result.tailless++;
        for (const key of ledger.programKeys()) result.cometPrograms.add(key);
      }
      const peak = result.peak[kind];
      peak.geometries = Math.max(peak.geometries, ledger.geometries.size);
      peak.materials = Math.max(peak.materials, ledger.materials.size);
      peak.programs = Math.max(peak.programs, ledger.programs());
    }

    const next = travel.autopilot.state;
    if (next === 'CRUISE' && state !== 'CRUISE') {
      const index = travel.autopilot.encounterCount - 1;
      const left: string[] = [];
      if (scene.children.length !== 0) left.push(`${scene.children.length} scene children`);
      if (view.getObject() !== null) left.push('an encounter object');
      if (ledger.geometries.size !== 0) left.push(`${ledger.geometries.size} geometries`);
      if (ledger.materials.size !== 0) left.push(`${ledger.materials.size} materials`);
      if (planetGeometryRefs() !== 0) left.push(`${planetGeometryRefs()} planet geometry refs`);
      if (nebulaGeometryRefs() !== 0) left.push(`${nebulaGeometryRefs()} nebula geometry refs`);
      if (left.length > 0) result.leaks.push(`encounter ${index}: ${left.join(', ')}`);
      if (index + 1 >= count) break;
    }
    state = next;
  }
  view.dispose();
  return result;
}

describe('long run (simulation level)', () => {
  it('the resource ledger sees what an encounter object holds until it is disposed', () => {
    const travel = createTravel(longRunParams(1), DEFAULT_SHIP_PARAMS);
    const view = new EncounterView(new Scene());
    for (let i = 0; i < 1_000 && view.getObject() === null; i++) {
      stepTravel(travel, DT_CAP_SECONDS);
      view.sync(travel.autopilot);
    }
    const ledger = new ResourceLedger();
    ledger.track(view.getObject()!.object);
    expect(ledger.geometries.size).toBe(1);
    expect(ledger.materials.size).toBeGreaterThan(0);
    expect(ledger.programs()).toBeGreaterThan(0);
    view.dispose();
    expect(ledger.geometries.size).toBe(0);
    expect(ledger.materials.size).toBe(0);
  });

  it('100 accelerated encounters, planets, nebulae, asteroids and comets, each return every resource to baseline', () => {
    // Top speed, a 1 s interval and the capped 0.1 s step: the fastest the engine can run them.
    const travel = createTravel(longRunParams(1), DEFAULT_SHIP_PARAMS);
    const result = runEncounters(travel, 100, () => DT_CAP_SECONDS);

    expect(travel.autopilot.encounterCount).toBe(100);
    expect(travel.autopilot.state).toBe('CRUISE');
    expect(result.leaks).toEqual([]);
    // The default mix: every kind, many times.
    expect(result.kinds.planet + result.kinds.nebula + result.kinds.asteroid + result.kinds.comet).toBe(100);
    expect(result.kinds.planet).toBeGreaterThan(25);
    expect(result.kinds.nebula).toBeGreaterThan(20);
    expect(result.kinds.asteroid).toBeGreaterThan(5);
    expect(result.kinds.comet).toBeGreaterThan(3);
    // A planet encounter holds one shared geometry (a ringed planet its own ring geometry too) and a
    // handful of materials, never more. A ring draws with the atmosphere's (halo) program.
    expect(result.ringed).toBeGreaterThan(0);
    expect(result.peak.planet.geometries).toBe(2);
    expect(result.peak.planet.materials).toBeLessThanOrEqual(3);
    expect(result.peak.planet.programs).toBeLessThanOrEqual(2);
    // A nebula: the shared plane, one material per layer, one program.
    expect(result.peak.nebula.geometries).toBe(1);
    expect(result.peak.nebula.materials).toBeLessThanOrEqual(8);
    expect(result.peak.nebula.programs).toBe(1);
    // An asteroid: a geometry and a material per rock (at most 7) and one program, the rocky
    // planet surface's (config.ts, ASTEROID_DETAIL).
    expect(result.peak.asteroid.geometries).toBeLessThanOrEqual(7);
    expect(result.peak.asteroid.materials).toBeLessThanOrEqual(7);
    expect(result.peak.asteroid.programs).toBe(1);
    expect(result.asteroidPrograms).toEqual(new Set([programKey(planetProgramMaterials()[0]!)]));
    // A comet: the nucleus and the glow, a geometry and a material each, drawn with the rocky surface
    // program and the halo program (the atmosphere's and the ring's).
    expect(result.peak.comet.geometries).toBe(2);
    expect(result.peak.comet.materials).toBe(2);
    expect(result.peak.comet.programs).toBe(2);
    const [rocky, , halo] = planetProgramMaterials();
    expect(result.cometPrograms).toEqual(new Set([programKey(rocky!), programKey(halo!)]));
    // No frame moves the ship further than its speed allows.
    expect(result.worstJump).toBeLessThanOrEqual(1e-6);
    // Positions stay finite (float64 on the CPU) after the long run.
    const { position, heading } = travel.ship;
    for (const v of [position.x, position.y, position.z, heading.x, heading.y, heading.z]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(heading.x, heading.y, heading.z)).toBeCloseTo(1, 12);
  });

  it('120 accelerated asteroid encounters, fields of up to 7 rocks among them, each free every rock geometry and material', () => {
    const travel = createTravel(longRunParams(1, { nebulaShare: 0, asteroidShare: 1 }), DEFAULT_SHIP_PARAMS);
    const result = runEncounters(travel, 120, () => DT_CAP_SECONDS);
    expect(travel.autopilot.encounterCount).toBe(120);
    expect(result.kinds).toEqual({ planet: 0, nebula: 0, asteroid: 120, comet: 0 });
    // Nothing left after any of them (no growth over the run), with every encounter's rocks counted.
    expect(result.leaks).toEqual([]);
    expect(result.fields).toBeGreaterThan(30);
    expect(result.fields).toBeLessThan(90);
    expect(result.mostRocks).toBe(7);
    expect(result.peak.asteroid.geometries).toBe(7);
    expect(result.peak.asteroid.materials).toBe(7);
    expect(result.peak.asteroid.programs).toBe(1);
    expect(result.worstJump).toBeLessThanOrEqual(1e-6);
  }, 60_000);

  it('120 accelerated comet encounters each free the nucleus and the glow, with no growth over the run', () => {
    const travel = createTravel(longRunParams(1, { nebulaShare: 0, asteroidShare: 0, cometShare: 1 }), DEFAULT_SHIP_PARAMS);
    const result = runEncounters(travel, 120, () => DT_CAP_SECONDS);
    expect(travel.autopilot.encounterCount).toBe(120);
    expect(result.kinds).toEqual({ planet: 0, nebula: 0, asteroid: 0, comet: 120 });
    // Nothing left after any of them, every comet drawn with its tails, and the same two programs.
    expect(result.leaks).toEqual([]);
    expect(result.tailless).toBe(0);
    expect(result.peak.comet.geometries).toBe(2);
    expect(result.peak.comet.materials).toBe(2);
    expect(result.peak.comet.programs).toBe(2);
    expect(result.cometPrograms.size).toBe(2);
    expect(result.worstJump).toBeLessThanOrEqual(1e-6);
  }, 60_000);

  it('irregular frame times (seeded, 0 to beyond the cap) change nothing about the cleanup', () => {
    const travel = createTravel(longRunParams(2), DEFAULT_SHIP_PARAMS);
    const random = mulberry32(0x50a4);
    // Mostly 60 Hz-ish frames, with the odd stall (clamped to the cap) and zero-length frame.
    const dt = () => {
      const u = random();
      return u < 0.05 ? 0 : u < 0.1 ? 0.5 : 0.01 + 0.04 * random();
    };
    const result = runEncounters(travel, 12, dt);
    expect(travel.autopilot.encounterCount).toBe(12);
    expect(result.leaks).toEqual([]);
    expect(result.kinds.planet).toBeGreaterThan(0);
    expect(result.kinds.nebula).toBeGreaterThan(0);
    expect(result.worstJump).toBeLessThanOrEqual(1e-6);
  });
});
