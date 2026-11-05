import { Scene, Vector3, type Object3D } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DT_CAP_SECONDS,
  ENCOUNTER_ARRIVAL_SPEED,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_MIN_SPEED,
  ENCOUNTER_MIN_SPEED_FLOOR,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  PLANET_GAS_RANGES,
  PLANET_GAS_SHARE,
  PLANET_ROCKY_RANGES,
  REDUCED_MOTION_SPEED_LEVEL,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
  SHIP_SPEED_TAU_SECONDS,
  ENCOUNTER_WARP_ENTRY_SECONDS,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  createTravel,
  encounterCruiseSpeed,
  encounterProfile,
  encounterSchedule,
  encounterViewMargin,
  setCruiseSpeed,
  stepTravel,
  updateAutopilot,
  warpEntryDuration,
  type AutopilotParams,
  type TravelState,
  type Travel,
} from './Autopilot';
import {
  DEFAULT_ENCOUNTER_PROFILE,
  encounterOffset,
  encounterOpacity,
  encounterScale,
  encounterTargetSpeed,
  planEncounter,
} from './encounter';
import {
  EncounterView,
  encounterLightDirection,
  encounterNebulaParams,
  encounterPlanetParams,
  planetRenderPosition,
} from './EncounterView';
import { Nebula, disposeNebulaGeometry, nebulaGeometry, nebulaGeometryRefs, nebulaParams } from './Nebula';
import { disposePlanetGeometry, planetGeometry, planetGeometryRefs, planetParams, type Planet } from './Planet';
import { hash } from './seed';
import { DEFAULT_SHIP_PARAMS, createShipState, headingAt, updateShip, type Vec3 } from './Ship';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const CYCLE: TravelState[] = ['APPROACH', 'FLYBY', 'DEPARTURE', 'CRUISE'];

/**
 * Engine-like autopilot params: seeded planets and nebulae, a short interval, cruise at speed level
 * `level`. Planets only unless `nebulaShare` is given.
 */
function engineParams(level = SHIP_DEFAULT_SPEED_LEVEL, interval = 2, nebulaShare = 0): AutopilotParams {
  const params: AutopilotParams = {
    ...DEFAULT_AUTOPILOT_PARAMS,
    interval,
    planetFor: planetParams,
    nebulaFor: nebulaParams,
    nebulaShare,
  };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  return params;
}

afterEach(() => {
  disposePlanetGeometry();
  disposeNebulaGeometry();
});

describe('planetRenderPosition (floating origin)', () => {
  it('gives small, float32-safe offsets for planets placed at ship positions around 1e12', () => {
    const origin = { x: 1e12 + 0.25, y: -3.7e11, z: -1.1e12 + 0.75 };
    const heading = headingAt(53, DEFAULT_SHIP_PARAMS, { x: 0, y: 0, z: 0 });
    const plan = planEncounter(origin, heading, 120, ENCOUNTER_DISTANCE, ENCOUNTER_SIDE_OFFSET_FACTOR, 1.1);
    const out = new Vector3();

    // Whole-unit ship moves keep the 1e12 coordinates exact, so the expected offset is known exactly.
    for (const [mx, my, mz] of [
      [0, 0, 0],
      [7, -2, -640],
      [-31, 90, -1600],
      [250, 40, -3100],
    ] as const) {
      const ship = { x: origin.x + mx, y: origin.y + my, z: origin.z + mz };
      expect(ship.x - origin.x).toBe(mx);
      const result = planetRenderPosition(plan, ship, out);
      expect(result).toBe(out);
      const expected = { x: plan.offset.x - mx, y: plan.offset.y - my, z: plan.offset.z - mz };

      // Small: within the encounter's own distances, nowhere near the absolute coordinates.
      expect(len(out)).toBeLessThan(ENCOUNTER_DISTANCE * 3);
      // Exact in float64…
      expect(dist(out, expected)).toBeLessThan(1e-6);
      // …and still accurate after the float32 conversion the GPU applies (float32 spacing near 4e3
      // is about 5e-4).
      const f32 = { x: Math.fround(out.x), y: Math.fround(out.y), z: Math.fround(out.z) };
      expect(dist(f32, expected)).toBeLessThan(1e-3);
    }

    // For contrast: rounding the absolute coordinates to float32 first, as the GPU would if they
    // reached it, is off by thousands of units at this magnitude.
    const ship = { x: origin.x + 7, y: origin.y - 2, z: origin.z - 640 };
    const naive = {
      x: Math.fround(plan.center.x) - Math.fround(ship.x),
      y: Math.fround(plan.center.y) - Math.fround(ship.y),
      z: Math.fround(plan.center.z) - Math.fround(ship.z),
    };
    expect(dist(naive, planetRenderPosition(plan, ship, out))).toBeGreaterThan(100);
  });
});

describe('encounterLightDirection', () => {
  it('is a unit vector lighting the faces the ship sees on approach and at the closest approach', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (const t of [0, 31, 77, 140]) {
      const heading = headingAt(t, DEFAULT_SHIP_PARAMS, { x: 0, y: 0, z: 0 });
      for (const sideAngle of [0, 1, 2.5, 4, 5.9]) {
        const plan = planEncounter({ x: 1e9, y: 0, z: -3e8 }, heading, 90, ENCOUNTER_DISTANCE, 2, sideAngle);
        const light = encounterLightDirection(plan, out);
        expect(light).toBe(out);
        expect(len(light)).toBeCloseTo(1, 12);
        const d = plan.direction;
        const s = plan.side;
        // Approaching, the ship sees the face pointing back along the path (-direction).
        expect(dot(light, { x: -d.x, y: -d.y, z: -d.z })).toBeGreaterThan(0.5);
        // At the closest approach, it sees the face pointing toward the path (-side).
        expect(dot(light, { x: -s.x, y: -s.y, z: -s.z })).toBeGreaterThan(0.5);
      }
    }
  });

  it('with a -Z heading and the planet to the right, the light comes from behind, left and above', () => {
    const plan = planEncounter({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 100);
    const light = encounterLightDirection(plan, { x: 0, y: 0, z: 0 });
    expect(light.x).toBeLessThan(0);
    expect(light.y).toBeGreaterThan(0);
    expect(light.z).toBeGreaterThan(0);
  });
});

describe('encounterPlanetParams', () => {
  it('is the seeded planet, always drawn at the planned radius', () => {
    const params = engineParams();
    let autopilot = createTravel(params, DEFAULT_SHIP_PARAMS).autopilot;
    for (let i = 0; i < 100 && autopilot.encounter === null; i++) {
      autopilot = updateAutopilot(autopilot, createShipState(), 0.1, params);
    }
    const encounter = autopilot.encounter!;
    expect(encounter).not.toBeNull();
    if (encounter.kind !== 'planet') throw new Error('expected a planet encounter');
    expect(encounterPlanetParams(encounter)).toEqual(planetParams(hash(ENCOUNTER_BASE_SEED, 0)));

    const mismatched = { ...encounter, plan: { ...encounter.plan, radius: 33 } };
    const drawn = encounterPlanetParams(mismatched);
    expect(drawn.radius).toBe(33);
    expect(drawn.seed).toBe(encounter.seed);
  });
});

/** Steps travel and the view as the engine does each frame; returns what happened in that step. */
function frame(travel: Travel, view: EncounterView, dt: number) {
  const before = travel.autopilot.state;
  stepTravel(travel, dt);
  view.sync(travel.autopilot);
  const kind = travel.autopilot.encounter?.kind ?? 'planet';
  view.place(travel.autopilot, travel.ship, encounterProfile(travel.autopilotParams, kind));
  return { from: before, to: travel.autopilot.state };
}

describe('EncounterView', () => {
  it('creates the planet as APPROACH starts and disposes it, with the shared geometry, as DEPARTURE ends', () => {
    const scene = new Scene();
    const view = new EncounterView(scene);
    const travel = createTravel(engineParams(2), DEFAULT_SHIP_PARAMS);
    const dt = 1 / 30;
    const transitions: TravelState[] = [];
    const planets = new Set<Planet>();
    let disposedMaterials = 0;
    let geometryDisposed = 0;
    let createdAt: TravelState | null = null;
    let fadeChecks = 0;

    for (let i = 0; i < 20_000 && transitions.filter((t) => t === 'CRUISE').length < 2; i++) {
      const { from, to } = frame(travel, view, dt);
      if (from !== to) transitions.push(to);
      const planet = view.getPlanet();
      const encounter = travel.autopilot.encounter;
      if (planet !== null && !planets.has(planet)) {
        planets.add(planet);
        createdAt = travel.autopilot.state;
        expect(from).toBe('CRUISE');
        expect(encounter?.kind === 'planet' && encounterPlanetParams(encounter)).toEqual(planet.params);
        // Starts invisible, at opacity 0.
        expect(planet.object.visible).toBe(false);
        planet.object.traverse((o) => {
          const material = (o as { material?: { addEventListener(t: string, f: () => void): void } }).material;
          material?.addEventListener('dispose', () => disposedMaterials++);
        });
        planetGeometry().addEventListener('dispose', () => geometryDisposed++);
      }
      // Exactly one planet in the scene during an encounter, none outside.
      expect(scene.children.length).toBe(encounter === null ? 0 : 1);
      expect(planet === null).toBe(encounter === null);
      if (planet !== null && encounter !== null) {
        expect(scene.children[0]).toBe(planet.object);
        // Floating origin: the render position is planet - ship.
        const p = planet.object.position;
        const c = encounter.plan.center;
        const s = travel.ship.position;
        expect(dist(p, { x: c.x - s.x, y: c.y - s.y, z: c.z - s.z })).toBeLessThan(1e-6);
        // Opacity follows the fade curve, and the planet keeps its world size (its full radius)
        // from spawn to despawn, so only perspective changes its size on screen.
        const remaining = travel.autopilot.remaining;
        expect(planet.uniforms.uOpacity.value).toBeCloseTo(encounterOpacity(encounter.plan, remaining), 12);
        expect(encounterScale(encounter.plan, remaining)).toBe(1);
        expect(planet.object.scale.toArray()).toEqual([planet.params.radius, planet.params.radius, planet.params.radius]);
        expect(planet.object.visible).toBe(travel.autopilot.fade > 0);
        fadeChecks++;
      }
    }

    expect(transitions).toEqual([...CYCLE, ...CYCLE]);
    expect(createdAt).toBe('APPROACH');
    expect(planets.size).toBe(2);
    expect(fadeChecks).toBeGreaterThan(100);
    // Both planets disposed their materials, and the shared geometry was freed after each one.
    expect(disposedMaterials).toBeGreaterThanOrEqual(2 * 2);
    expect(geometryDisposed).toBe(2);
    expect(planetGeometryRefs()).toBe(0);
    expect(view.getPlanet()).toBeNull();
    expect(scene.children).toHaveLength(0);
  });

  it('dispose() frees the planet of an encounter in progress', () => {
    const scene = new Scene();
    const view = new EncounterView(scene);
    const travel = createTravel(engineParams(1, 0.5), DEFAULT_SHIP_PARAMS);
    for (let i = 0; i < 100 && view.getPlanet() === null; i++) frame(travel, view, 0.05);
    const planet = view.getPlanet()!;
    expect(planet).not.toBeNull();
    let geometryDisposed = 0;
    planetGeometry().addEventListener('dispose', () => geometryDisposed++);
    view.dispose();
    expect(view.getPlanet()).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(geometryDisposed).toBe(1);
  });
});

describe('EncounterView with nebulae', () => {
  it('creates the nebula as APPROACH starts, places it relative to the ship, and frees it as DEPARTURE ends', () => {
    const scene = new Scene();
    const view = new EncounterView(scene);
    const travel = createTravel(engineParams(2, 1, 1), DEFAULT_SHIP_PARAMS);
    const transitions: TravelState[] = [];
    const nebulae = new Set<Nebula>();
    let disposedMaterials = 0;
    let geometryDisposed = 0;
    let checks = 0;
    for (let i = 0; i < 50_000 && transitions.filter((t) => t === 'CRUISE').length < 2; i++) {
      const { from, to } = frame(travel, view, 1 / 30);
      if (from !== to) transitions.push(to);
      const nebula = view.getNebula();
      const encounter = travel.autopilot.encounter;
      expect(view.getPlanet()).toBeNull();
      expect(scene.children.length).toBe(encounter === null ? 0 : 1);
      expect(nebula === null).toBe(encounter === null);
      if (nebula === null || encounter === null) continue;
      expect(view.getObject()).toBe(nebula);
      if (!nebulae.has(nebula)) {
        nebulae.add(nebula);
        expect(from).toBe('CRUISE');
        expect(to).toBe('APPROACH');
        expect(encounter.kind === 'nebula' && encounterNebulaParams(encounter)).toEqual(nebula.params);
        for (const layer of nebula.layers) layer.mesh.material.addEventListener('dispose', () => disposedMaterials++);
        nebulaGeometry().addEventListener('dispose', () => geometryDisposed++);
      }
      // Floating origin: the render position is nebula centre - ship; the fade is the autopilot's.
      const c = encounter.plan.center;
      const s = travel.ship.position;
      expect(dist(nebula.object.position, { x: c.x - s.x, y: c.y - s.y, z: c.z - s.z })).toBeLessThan(1e-6);
      expect(nebula.opacity.value).toBeCloseTo(travel.autopilot.fade, 12);
      expect(nebula.object.visible).toBe(travel.autopilot.fade > 0);
      expect(nebula.object.scale.x).toBe(1);
      checks++;
    }
    expect(transitions).toEqual([...CYCLE, ...CYCLE]);
    expect(nebulae.size).toBe(2);
    expect(checks).toBeGreaterThan(100);
    const layerCount = [...nebulae].reduce((sum, n) => sum + n.layers.length, 0);
    expect(disposedMaterials).toBe(layerCount);
    expect(geometryDisposed).toBe(2);
    expect(nebulaGeometryRefs()).toBe(0);
    expect(scene.children).toHaveLength(0);
  });

  it('keeps a new nebula hidden until its compile settles', async () => {
    const scene = new Scene();
    const { calls, compile } = fakeCompiler();
    const view = new EncounterView(scene, compile);
    const travel = createTravel(engineParams(1, 0.5, 1), DEFAULT_SHIP_PARAMS);
    runUntil(travel, view, () => view.getNebula() !== null);
    const nebula = view.getNebula()!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.object).toBe(nebula.object);
    runUntil(travel, view, () => travel.autopilot.fade > 0.05);
    expect(nebula.object.visible).toBe(false);
    expect(nebula.opacity.value).toBe(0);
    calls[0]!.resolve();
    await flush();
    frame(travel, view, 0.05);
    expect(nebula.object.visible).toBe(true);
    expect(nebula.opacity.value).toBeCloseTo(travel.autopilot.fade, 12);
    view.dispose();
    expect(nebulaGeometryRefs()).toBe(0);
  });

  it('with the default share, each encounter gets the object of its kind, and all are freed', () => {
    const scene = new Scene();
    const view = new EncounterView(scene);
    const travel = createTravel(engineParams(2, 1, DEFAULT_AUTOPILOT_PARAMS.nebulaShare), DEFAULT_SHIP_PARAMS);
    const kinds: string[] = [];
    let last: unknown = null;
    for (let i = 0; i < 200_000 && travel.autopilot.encounterCount < 5; i++) {
      frame(travel, view, 1 / 20);
      const current = view.getObject();
      const encounter = travel.autopilot.encounter;
      if (current !== null && current !== last) {
        last = current;
        kinds.push(current instanceof Nebula ? 'nebula' : 'planet');
        expect(kinds.at(-1)).toBe(encounter!.kind);
      }
    }
    expect(kinds.slice(0, 5)).toEqual(encounterSchedule(travel.autopilotParams, 5).map((e) => e.kind));
    expect(new Set(kinds)).toEqual(new Set(['planet', 'nebula']));
    view.dispose();
    expect(planetGeometryRefs()).toBe(0);
    expect(nebulaGeometryRefs()).toBe(0);
    expect(scene.children).toHaveLength(0);
  });
});

/** A fake `EncounterCompiler` whose promises the test settles by hand. */
function fakeCompiler() {
  const calls: { object: Object3D; inScene: boolean; resolve: () => void; reject: (reason: unknown) => void }[] = [];
  const compile = (object: Object3D) =>
    new Promise<void>((resolve, reject) => calls.push({ object, inScene: object.parent !== null, resolve, reject }));
  return { calls, compile };
}

/** Lets settled promises run their callbacks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs engine-like frames until `done` holds (at most `limit` frames). */
function runUntil(travel: Travel, view: EncounterView, done: () => boolean, dt = 0.05, limit = 50_000): void {
  for (let i = 0; i < limit && !done(); i++) frame(travel, view, dt);
  expect(done()).toBe(true);
}

describe('EncounterView shader warm-up', () => {
  it('keeps a new planet hidden until its compile settles, then follows the fade', async () => {
    const scene = new Scene();
    const { calls, compile } = fakeCompiler();
    const view = new EncounterView(scene, compile);
    const travel = createTravel(engineParams(1, 0.5), DEFAULT_SHIP_PARAMS);
    runUntil(travel, view, () => view.getPlanet() !== null);
    const planet = view.getPlanet()!;
    // Compiled once, as soon as it is in the scene.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.object).toBe(planet.object);
    expect(calls[0]!.inScene).toBe(true);

    // Still compiling: hidden even once the autopilot fades it in.
    runUntil(travel, view, () => travel.autopilot.fade > 0.05);
    expect(planet.object.visible).toBe(false);
    expect(planet.uniforms.uOpacity.value).toBe(0);
    expect(calls).toHaveLength(1);

    calls[0]!.resolve();
    await flush();
    frame(travel, view, 0.05);
    expect(planet.object.visible).toBe(true);
    expect(planet.uniforms.uOpacity.value).toBeCloseTo(travel.autopilot.fade, 12);
    view.dispose();
  });

  it.each(['rejects', 'throws'] as const)('shows the planet anyway when the compile %s', async (failure) => {
    const scene = new Scene();
    const calls: Object3D[] = [];
    const view = new EncounterView(scene, (object) => {
      calls.push(object);
      if (failure === 'throws') throw new Error('no context');
      return Promise.reject(new Error('compile failed'));
    });
    const travel = createTravel(engineParams(1, 0.5), DEFAULT_SHIP_PARAMS);
    runUntil(travel, view, () => view.getPlanet() !== null);
    await flush();
    runUntil(travel, view, () => travel.autopilot.fade > 0.05);
    const planet = view.getPlanet()!;
    expect(calls).toEqual([planet.object]);
    expect(planet.object.visible).toBe(true);
    expect(planet.uniforms.uOpacity.value).toBeCloseTo(travel.autopilot.fade, 12);
    view.dispose();
  });

  it('a compile that settles after its planet was released never marks the next planet ready', async () => {
    const scene = new Scene();
    const { calls, compile } = fakeCompiler();
    const view = new EncounterView(scene, compile);
    const travel = createTravel(engineParams(2, 0.5), DEFAULT_SHIP_PARAMS);
    const index = () => travel.autopilot.encounter?.index ?? null;

    // The first encounter runs to its end with its compile still pending: the planet stays hidden
    // throughout and is released normally.
    runUntil(travel, view, () => index() === 0);
    const first = view.getPlanet()!;
    let firstShown = false;
    runUntil(travel, view, () => {
      firstShown ||= first.object.visible;
      return index() === null;
    }, 0.1);
    expect(firstShown).toBe(false);
    expect(view.getPlanet()).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(planetGeometryRefs()).toBe(0);

    // The next planet is compiled in turn; the stale compile settling now changes nothing.
    runUntil(travel, view, () => index() === 1);
    const second = view.getPlanet()!;
    expect(second).not.toBe(first);
    expect(calls.map((c) => c.object)).toEqual([first.object, second.object]);
    calls[0]!.resolve();
    await flush();
    runUntil(travel, view, () => travel.autopilot.fade > 0.05);
    expect(second.object.visible).toBe(false);
    expect(second.uniforms.uOpacity.value).toBe(0);
    // Its own compile does.
    calls[1]!.resolve();
    await flush();
    frame(travel, view, 0.05);
    expect(second.object.visible).toBe(true);

    // Disposing the view with a compile pending, then settling it, is harmless too.
    runUntil(travel, view, () => index() === 2, 0.1);
    view.dispose();
    expect(view.getPlanet()).toBeNull();
    calls[2]!.reject(new Error('context lost'));
    await flush();
    expect(view.getPlanet()).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(planetGeometryRefs()).toBe(0);
  });
});

/** Median radius of the seeded planet draw: gas with probability PLANET_GAS_SHARE, the radius uniform over the type's range. */
function medianPlanetRadius(): number {
  // Found by bisection on the mixture's CDF.
  const uniformCdf = ([min, max]: readonly [number, number], r: number) => Math.min(1, Math.max(0, (r - min) / (max - min)));
  const cdf = (r: number) =>
    (1 - PLANET_GAS_SHARE) * uniformCdf(PLANET_ROCKY_RANGES.radius, r) + PLANET_GAS_SHARE * uniformCdf(PLANET_GAS_RANGES.radius, r);
  let low = Math.min(PLANET_ROCKY_RANGES.radius[0], PLANET_GAS_RANGES.radius[0]);
  let high = Math.max(PLANET_ROCKY_RANGES.radius[1], PLANET_GAS_RANGES.radius[1]);
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (cdf(mid) < 0.5) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * One median-radius planet encounter at speed level `level`, simulated from load at dt = 1/60 with
 * the default (jittered) interval: the peak bearing rate (°/s), the 30°→80° bearing sweep, the times
 * from the spawn to the closest approach and to the end (s), and the ship's speed when the planet
 * first reaches opacity 0.1 and at the closest approach. The bearing is the angle between the planned
 * path and the line of sight to the planet centre.
 */
function medianPlanetFlyby(level: number) {
  const radius = medianPlanetRadius();
  const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, nebulaShare: 0, planetFor: () => ({ radius }) };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
  const dt = 1 / 60;
  const rel = { x: 0, y: 0, z: 0 };
  let spawnedAt = Number.NaN;
  let closestAt = Number.NaN;
  let endedAt = Number.NaN;
  let at30 = Number.NaN;
  let at80 = Number.NaN;
  let speedAtVisible = Number.NaN;
  let speedAtClosest = Number.NaN;
  let prevBearing = Number.NaN;
  let peak = 0;
  for (let i = 0; i < 1e6 && Number.isNaN(endedAt); i++) {
    const before = travel.autopilot.state;
    stepTravel(travel, dt);
    const { autopilot, ship } = travel;
    if (before === 'CRUISE' && autopilot.state === 'APPROACH') spawnedAt = ship.time;
    if (before === 'DEPARTURE' && autopilot.state === 'CRUISE') endedAt = ship.time;
    const encounter = autopilot.encounter;
    if (encounter === null) continue;
    expect(encounter.plan.radius).toBe(radius);
    if (Number.isNaN(speedAtVisible) && autopilot.fade >= 0.1) speedAtVisible = ship.speed;
    if (Number.isNaN(closestAt) && autopilot.remaining <= 0) {
      closestAt = ship.time;
      speedAtClosest = ship.speed;
    }
    const toPlanet = encounterOffset(encounter.plan, ship.position, rel);
    const bearing = (Math.acos(Math.min(1, dot(toPlanet, encounter.plan.direction) / len(toPlanet))) * 180) / Math.PI;
    if (Number.isNaN(at30) && bearing >= 30) at30 = ship.time;
    if (Number.isNaN(at80) && bearing >= 80) at80 = ship.time;
    if (!Number.isNaN(prevBearing)) peak = Math.max(peak, Math.abs(bearing - prevBearing) / dt);
    prevBearing = bearing;
  }
  expect(endedAt).toBeGreaterThan(closestAt);
  expect(at80).toBeGreaterThan(at30);
  return {
    peak,
    sweep: at80 - at30,
    approach: closestAt - spawnedAt,
    duration: endedAt - spawnedAt,
    speedAtVisible,
    speedAtClosest,
  };
}

describe('the travel step', () => {
  it('stepTravel is updateShip, then updateAutopilot, then feeds the ship params', () => {
    const params = engineParams(1, 3);
    const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
    expect(travel.shipParams.targetSpeed).toBe(params.cruiseSpeed);
    expect(travel.ship.speed).toBe(0);
    let ship = createShipState({}, travel.shipParams);
    let autopilot = { ...travel.autopilot };
    const shipParams = { ...travel.shipParams };
    for (let i = 0; i < 2000; i++) {
      const dt = i % 7 === 0 ? 0.1 : 1 / 60;
      stepTravel(travel, dt);
      ship = updateShip(ship, dt, shipParams);
      autopilot = updateAutopilot(autopilot, ship, dt, params);
      shipParams.targetSpeed = autopilot.targetSpeed;
      shipParams.driftRate = autopilot.driftRate;
    }
    expect(travel.ship).toEqual(ship);
    expect(travel.autopilot).toEqual(autopilot);
    expect(travel.shipParams).toEqual(shipParams);
    expect(travel.autopilot.encounterCount).toBeGreaterThan(0);
  });

  it('setCruiseSpeed scales the whole speed profile for the encounter speed instead of overriding it', () => {
    const base = DEFAULT_AUTOPILOT_PARAMS;
    let floored = 0;
    let outOfWarp = 0;
    for (const speed of SHIP_SPEED_LEVELS) {
      const params: AutopilotParams = { ...base };
      setCruiseSpeed(params, speed);
      // Encounters are flown from the cruise speed, or from the arrival speed above it.
      const encounterSpeed = encounterCruiseSpeed(params);
      expect(encounterSpeed).toBe(Math.min(speed, ENCOUNTER_ARRIVAL_SPEED));
      const factor = encounterSpeed / base.cruiseSpeed;
      const scaledMin = DEFAULT_ENCOUNTER_PROFILE.minSpeed * factor;
      expect(params.cruiseSpeed).toBe(speed);
      // Distances, and so the fades and transitions, are unchanged.
      expect({ ...params.profile, minSpeed: 0 }).toEqual({ ...DEFAULT_ENCOUNTER_PROFILE, minSpeed: 0 });
      if (speed >= ENCOUNTER_ARRIVAL_SPEED) {
        // At and above the arrival speed (the default level's), exactly the default level's profile.
        if (speed > ENCOUNTER_ARRIVAL_SPEED) outOfWarp++;
        expect(params.profile).toEqual(DEFAULT_ENCOUNTER_PROFILE);
        for (const remaining of [2000, 900, 500, 100, 0, -30, -300, -900, -2000]) {
          expect(encounterTargetSpeed(remaining, encounterSpeed, params.profile)).toBe(
            encounterTargetSpeed(remaining, base.cruiseSpeed, base.profile),
          );
        }
      } else if (scaledMin >= ENCOUNTER_MIN_SPEED_FLOOR) {
        expect(params.profile.minSpeed).toBeCloseTo(scaledMin, 12);
        for (const remaining of [2000, 900, 500, 100, 0, -30, -300, -900, -2000]) {
          const scaled = encounterTargetSpeed(remaining, encounterSpeed, params.profile);
          expect(scaled).toBeCloseTo(factor * encounterTargetSpeed(remaining, base.cruiseSpeed, base.profile), 9);
        }
      } else {
        // Floored at the slowest levels, and never above the cruise speed.
        floored++;
        expect(params.profile.minSpeed).toBe(Math.min(speed, ENCOUNTER_MIN_SPEED_FLOOR));
        for (const remaining of [2000, 900, 500, 100, 0, -30, -300, -900, -2000]) {
          const target = encounterTargetSpeed(remaining, encounterSpeed, params.profile);
          expect(target).toBeGreaterThanOrEqual(params.profile.minSpeed - 1e-9);
          expect(target).toBeLessThanOrEqual(speed + 1e-9);
        }
      }
    }
    // The reduced-motion level is the floored one (6 × 20 / 60 = 2 would be below the floor), and
    // the top level is above the arrival speed.
    expect(floored).toBeGreaterThan(0);
    expect(outOfWarp).toBeGreaterThan(0);
    // A cruise speed below the floor is never sped up by an encounter.
    const crawl: AutopilotParams = { ...base };
    setCruiseSpeed(crawl, ENCOUNTER_MIN_SPEED_FLOOR / 2);
    expect(crawl.profile.minSpeed).toBe(ENCOUNTER_MIN_SPEED_FLOOR / 2);
    // At the top speed the planet is passed at the default level's minimum speed.
    const top: AutopilotParams = { ...base };
    setCruiseSpeed(top, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
    expect(encounterTargetSpeed(0, encounterCruiseSpeed(top), top.profile)).toBe(ENCOUNTER_MIN_SPEED);
  });

  it.each([1 / 60, DT_CAP_SECONDS])(
    'at the reduced-motion level the floored minimum speed keeps the clearance and gradual fades (dt = %f)',
    (dt) => {
      const params = engineParams(REDUCED_MOTION_SPEED_LEVEL, 1);
      expect(params.profile.minSpeed).toBe(ENCOUNTER_MIN_SPEED_FLOOR);
      const travel = createTravel(params, DEFAULT_SHIP_PARAMS);
      const rel = { x: 0, y: 0, z: 0 };
      let minClearance = Number.POSITIVE_INFINITY;
      let radius = Number.NaN;
      let worstFadeStep = 0;
      let slowest = Number.POSITIVE_INFINITY;
      let startedAt = Number.NaN;
      let endedAt = Number.NaN;
      let prevFade = travel.autopilot.fade;
      let endedOutOfView = false;
      for (let i = 0; i < 1e6 && Number.isNaN(endedAt); i++) {
        const before = travel.autopilot.state;
        const prevEncounter = travel.autopilot.encounter;
        stepTravel(travel, dt);
        const { autopilot, ship } = travel;
        if (before === 'CRUISE' && autopilot.state === 'APPROACH') startedAt = ship.time;
        if (before === 'DEPARTURE' && autopilot.state === 'CRUISE') {
          endedAt = ship.time;
          endedOutOfView = encounterViewMargin(prevEncounter!, ship, params.viewHalfAngle) > 0;
        }
        // The planet is removed once out of view, at whatever fade it has, which no one sees.
        if (!endedOutOfView) worstFadeStep = Math.max(worstFadeStep, Math.abs(autopilot.fade - prevFade));
        prevFade = autopilot.fade;
        const encounter = autopilot.encounter;
        if (encounter === null) continue;
        radius = encounter.plan.radius;
        minClearance = Math.min(minClearance, len(encounterOffset(encounter.plan, ship.position, rel)));
        if (autopilot.state === 'FLYBY') slowest = Math.min(slowest, autopilot.targetSpeed);
      }
      expect(endedAt).toBeGreaterThan(startedAt);
      expect(endedOutOfView).toBe(true);
      // Clear of the planet, at its planned closest approach.
      expect(minClearance).toBeGreaterThanOrEqual(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
      expect(minClearance).toBeCloseTo(radius * ENCOUNTER_SIDE_OFFSET_FACTOR, 0);
      // Fades in gradually: no frame changes the opacity by more than 2% while it is in view.
      expect(worstFadeStep).toBeGreaterThan(0);
      expect(worstFadeStep).toBeLessThan(0.02);
      // Slows to the floor, not below it, so it does not crawl, and ends once the planet is out of
      // view, shortly after the closest approach: one encounter takes about 153 s (about 285 s when it
      // ran on to the despawn distance, and about 350 s with the unfloored minimum of 2).
      expect(slowest).toBeCloseTo(ENCOUNTER_MIN_SPEED_FLOOR, 9);
      expect(endedAt - startedAt).toBeLessThan(170);
    },
  );

  // Measured with this same simulation before #36, for that median planet (radius about 102, at
  // D = 1600, minimum speed 15) at the default speed level: the bearing peaked at 4.25°/s, 38.6 s
  // after the spawn.
  const BEFORE_PEAK_DEG_PER_S = 4.25;
  const BEFORE_APPROACH_S = 38.6;
  const fasterLevels = SHIP_SPEED_LEVELS.map((cruiseSpeed, level) => ({ level, cruiseSpeed })).filter(
    ({ level }) => level >= SHIP_DEFAULT_SPEED_LEVEL,
  );

  it.each(fasterLevels)(
    'at speed level $level ($cruiseSpeed u/s) a median planet sweeps past no faster in angle than before #36, and is reached within 1.5× the time',
    ({ level }) => {
      const flyby = medianPlanetFlyby(level);
      // The closest approach is 0.4× as far as before, so the ship passes it 0.4× as fast: about
      // 4.4°/s. Faster levels drop out of warp first, so they fly the same flyby.
      expect(flyby.peak).toBeGreaterThan(BEFORE_PEAK_DEG_PER_S * 0.8);
      expect(flyby.peak).toBeLessThanOrEqual(BEFORE_PEAK_DEG_PER_S * 1.2);
      // About 54 s.
      expect(flyby.approach).toBeLessThanOrEqual(BEFORE_APPROACH_S * 1.5);
      // Out of warp before the planet is noticeably visible, and past it at near the minimum speed
      // (the ship lags the profile by about its time constant).
      expect(flyby.speedAtVisible).toBeLessThanOrEqual(ENCOUNTER_ARRIVAL_SPEED + 0.5);
      expect(flyby.speedAtClosest).toBeGreaterThanOrEqual(ENCOUNTER_MIN_SPEED);
      expect(flyby.speedAtClosest).toBeLessThan(ENCOUNTER_MIN_SPEED * 1.5);
    },
  );

  it("at the top speed level a median planet's flyby matches the default level's: peak bearing rate within ±20%, the same sweep and approach time", () => {
    const top = medianPlanetFlyby(SHIP_SPEED_LEVELS.length - 1);
    const normal = medianPlanetFlyby(SHIP_DEFAULT_SPEED_LEVEL);
    // Before the drop out of warp the top level peaked at about 37°/s (8.4× the default level),
    // swept from 30° to 80° in 1.7 s and reached the planet 17 s after the spawn.
    expect(Math.abs(top.peak - normal.peak)).toBeLessThanOrEqual(0.2 * normal.peak);
    // The same within a few frames: from the spawn on the profile is the same, and the ship has
    // settled to the arrival speed by the time the planet is noticeably visible.
    expect(Math.abs(top.sweep - normal.sweep)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(top.approach - normal.approach)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(top.duration - normal.duration)).toBeLessThanOrEqual(0.5);
  });

  it.each([1 / 60, 1 / 120])(
    'during an encounter, pause → resume → speed up keeps the state machine consistent (dt = %f)',
    (dt) => {
      const travel = createTravel(engineParams(SHIP_DEFAULT_SPEED_LEVEL), DEFAULT_SHIP_PARAMS);
      const states: TravelState[] = [travel.autopilot.state];
      let worstJump = 0;
      let index: number | null = null;
      const step = (h: number) => {
        const before = { ...travel.ship.position };
        const speedBefore = travel.ship.speed;
        stepTravel(travel, h);
        const moved = dist(before, travel.ship.position);
        // No jump: a step never moves further than the larger end-point speed allows.
        worstJump = Math.max(worstJump, moved - Math.max(speedBefore, travel.ship.speed) * h);
        if (travel.autopilot.state !== states.at(-1)) states.push(travel.autopilot.state);
        if (travel.autopilot.encounter !== null) {
          index ??= travel.autopilot.encounter.index;
          expect(travel.autopilot.encounter.index).toBe(index);
        }
      };

      // Into the approach, with the planet faded in part way.
      while (!(travel.autopilot.state === 'APPROACH' && travel.autopilot.fade > 0.3)) step(dt);

      // Pause: no steps run, so nothing changes, however long it lasts.
      const frozen = JSON.parse(JSON.stringify({ ship: travel.ship, autopilot: travel.autopilot }));
      // Resume: the first frame has dt = 0 (FrameClock.reset), which changes no state.
      step(0);
      expect(JSON.parse(JSON.stringify({ ship: travel.ship, autopilot: travel.autopilot }))).toEqual(frozen);

      // ArrowUp: one speed level up, mid-encounter. The encounter is already flown from the arrival
      // speed (the default level's), so its target speed stays as it was.
      const remainingBefore = travel.autopilot.remaining;
      setCruiseSpeed(travel.autopilotParams, SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL + 1]!);
      step(0);
      expect(travel.autopilot.state).toBe('APPROACH');
      expect(travel.autopilot.remaining).toBe(remainingBefore);
      expect(travel.shipParams.targetSpeed).toBe(
        encounterTargetSpeed(remainingBefore, encounterCruiseSpeed(travel.autopilotParams), travel.autopilotParams.profile),
      );
      expect(travel.shipParams.targetSpeed).toBe(frozen.autopilot.targetSpeed);

      // (Read through a function: TypeScript would otherwise keep the narrowing from the loop above.)
      const state = (): TravelState => travel.autopilot.state;
      while (state() !== 'CRUISE') step(dt);
      expect(states).toEqual(['CRUISE', ...CYCLE]);
      // Then, given a cruise long enough for it (this one's interval is 2 s), back into warp at the
      // new level.
      travel.autopilotParams.interval = 60;
      const endedAt = travel.ship.time;
      // The encounter ended out of view, near its minimum speed, so the return to warp starts there.
      const entry = warpEntryDuration(travel.autopilotParams, travel.autopilot.entrySpeed);
      expect(entry).toBeGreaterThan(ENCOUNTER_WARP_ENTRY_SECONDS);
      while (travel.ship.time < endedAt + entry + SHIP_SPEED_TAU_SECONDS) step(dt);
      expect(states).toEqual(['CRUISE', ...CYCLE]);
      expect(worstJump).toBeLessThan(1e-9);
      expect(travel.ship.speed).toBeGreaterThan(SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL]! * 2);
    },
  );
});
