// Long-run stability at the simulation level (docs/PLAN.md sections 5, 6 Performance and 9 Phase 3):
// 100 accelerated encounters through the engine's own frame sequence (stepTravel, then the
// encounter view's sync and place) leave every encounter resource freed, with the scene and the
// shared geometries back at their baseline after each one.
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
import { EncounterView } from './EncounterView';
import { disposeNebulaGeometry, nebulaGeometryRefs, nebulaParams } from './Nebula';
import { disposePlanetGeometry, planetGeometryRefs, planetParams } from './Planet';
import { mulberry32 } from './seed';
import { DEFAULT_SHIP_PARAMS } from './Ship';

afterEach(() => {
  disposePlanetGeometry();
  disposeNebulaGeometry();
});

/** Engine-like params: seeded planets and nebulae in the default mix, a short interval, top speed. */
function longRunParams(interval: number): AutopilotParams {
  const params: AutopilotParams = {
    ...DEFAULT_AUTOPILOT_PARAMS,
    interval,
    planetFor: planetParams,
    nebulaFor: nebulaParams,
  };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
  return params;
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
    const keys = new Set<string>();
    for (const m of this.materials) {
      const s = m as Material & { vertexShader?: string; fragmentShader?: string; defines?: object };
      keys.add(`${s.vertexShader}\n${s.fragmentShader}\n${JSON.stringify(s.defines ?? {})}`);
    }
    return keys.size;
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
  /** Peak live resources during an encounter. */
  peak: { geometries: number; materials: number; programs: number };
  frames: number;
}

/** Runs `count` encounters with engine-like frames of `dt(i)` seconds and audits every return to CRUISE. */
function runEncounters(travel: Travel, count: number, dt: (frame: number) => number): LongRunResult {
  const scene = new Scene();
  const view = new EncounterView(scene);
  const ledger = new ResourceLedger();
  const result: LongRunResult = {
    kinds: { planet: 0, nebula: 0 },
    ringed: 0,
    leaks: [],
    worstJump: Number.NEGATIVE_INFINITY,
    peak: { geometries: 0, materials: 0, programs: 0 },
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
      result.kinds[travel.autopilot.encounter!.kind]++;
      if (view.getPlanet()?.ring) result.ringed++;
      result.peak.geometries = Math.max(result.peak.geometries, ledger.geometries.size);
      result.peak.materials = Math.max(result.peak.materials, ledger.materials.size);
      result.peak.programs = Math.max(result.peak.programs, ledger.programs());
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

  it('100 accelerated encounters, planets and nebulae, each return every resource to baseline', () => {
    // Top speed, a 1 s interval and the capped 0.1 s step: the fastest the engine can run them.
    const travel = createTravel(longRunParams(1), DEFAULT_SHIP_PARAMS);
    const result = runEncounters(travel, 100, () => DT_CAP_SECONDS);

    expect(travel.autopilot.encounterCount).toBe(100);
    expect(travel.autopilot.state).toBe('CRUISE');
    expect(result.leaks).toEqual([]);
    // The default mix: both kinds, many times.
    expect(result.kinds.planet + result.kinds.nebula).toBe(100);
    expect(result.kinds.planet).toBeGreaterThan(30);
    expect(result.kinds.nebula).toBeGreaterThan(20);
    // An encounter holds one shared geometry (a ringed planet its own ring geometry too) and a
    // handful of materials, never more. A ring draws with the atmosphere's (halo) program.
    expect(result.ringed).toBeGreaterThan(0);
    expect(result.peak.geometries).toBe(2);
    expect(result.peak.materials).toBeLessThanOrEqual(8);
    expect(result.peak.programs).toBeLessThanOrEqual(2);
    // No frame moves the ship further than its speed allows.
    expect(result.worstJump).toBeLessThanOrEqual(1e-6);
    // Positions stay finite (float64 on the CPU) after the long run.
    const { position, heading } = travel.ship;
    for (const v of [position.x, position.y, position.z, heading.x, heading.y, heading.z]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.hypot(heading.x, heading.y, heading.z)).toBeCloseTo(1, 12);
  });

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
