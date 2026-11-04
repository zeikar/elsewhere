import { Scene, Vector3, type Object3D } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DT_CAP_SECONDS,
  ENCOUNTER_BASE_SEED,
  ENCOUNTER_CLEARANCE_MARGIN,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_MIN_SPEED_FLOOR,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  REDUCED_MOTION_SPEED_LEVEL,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  createTravel,
  setCruiseSpeed,
  stepTravel,
  updateAutopilot,
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
  encounterPlanetParams,
  planetRenderPosition,
} from './EncounterView';
import { disposePlanetGeometry, planetGeometry, planetGeometryRefs, planetParams, type Planet } from './Planet';
import { hash } from './seed';
import { DEFAULT_SHIP_PARAMS, createShipState, headingAt, updateShip, type Vec3 } from './Ship';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const CYCLE: TravelState[] = ['APPROACH', 'FLYBY', 'DEPARTURE', 'CRUISE'];

/** Engine-like autopilot params: seeded planets, a short interval, cruise at speed level `level`. */
function engineParams(level = SHIP_DEFAULT_SPEED_LEVEL, interval = 2): AutopilotParams {
  const params: AutopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, interval, planetFor: planetParams };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  return params;
}

afterEach(() => {
  disposePlanetGeometry();
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
  view.place(travel.autopilot, travel.ship, travel.autopilotParams.profile);
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
        expect(encounterPlanetParams(encounter!)).toEqual(planet.params);
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
        // Opacity and scale follow the fade curves.
        const remaining = travel.autopilot.remaining;
        expect(planet.uniforms.uOpacity.value).toBeCloseTo(encounterOpacity(encounter.plan, remaining), 12);
        expect(planet.object.scale.x).toBeCloseTo(planet.params.radius * encounterScale(encounter.plan, remaining), 9);
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

/** A fake `PlanetCompiler` whose promises the test settles by hand. */
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

  it('setCruiseSpeed scales the whole speed profile by the speed level instead of overriding it', () => {
    const base = DEFAULT_AUTOPILOT_PARAMS;
    let floored = 0;
    for (const speed of SHIP_SPEED_LEVELS) {
      const params: AutopilotParams = { ...base };
      setCruiseSpeed(params, speed);
      const factor = speed / base.cruiseSpeed;
      const scaledMin = DEFAULT_ENCOUNTER_PROFILE.minSpeed * factor;
      expect(params.cruiseSpeed).toBe(speed);
      // Distances, and so the fades and transitions, are unchanged.
      expect({ ...params.profile, minSpeed: 0 }).toEqual({ ...DEFAULT_ENCOUNTER_PROFILE, minSpeed: 0 });
      if (scaledMin >= ENCOUNTER_MIN_SPEED_FLOOR) {
        expect(params.profile.minSpeed).toBeCloseTo(scaledMin, 12);
        for (const remaining of [2000, 900, 500, 100, 0, -30, -300, -900, -2000]) {
          const scaled = encounterTargetSpeed(remaining, params.cruiseSpeed, params.profile);
          expect(scaled).toBeCloseTo(factor * encounterTargetSpeed(remaining, base.cruiseSpeed, base.profile), 9);
        }
      } else {
        // Floored at the slowest levels, and never above the cruise speed.
        floored++;
        expect(params.profile.minSpeed).toBe(Math.min(speed, ENCOUNTER_MIN_SPEED_FLOOR));
        for (const remaining of [2000, 900, 500, 100, 0, -30, -300, -900, -2000]) {
          const target = encounterTargetSpeed(remaining, params.cruiseSpeed, params.profile);
          expect(target).toBeGreaterThanOrEqual(params.profile.minSpeed - 1e-9);
          expect(target).toBeLessThanOrEqual(speed + 1e-9);
        }
      }
    }
    // The reduced-motion level is the floored one (15 × 20 / 60 = 5 would be below the floor).
    expect(floored).toBeGreaterThan(0);
    // A cruise speed below the floor is never sped up by an encounter.
    const crawl: AutopilotParams = { ...base };
    setCruiseSpeed(crawl, ENCOUNTER_MIN_SPEED_FLOOR / 2);
    expect(crawl.profile.minSpeed).toBe(ENCOUNTER_MIN_SPEED_FLOOR / 2);
    // Still slows right down around the planet at the top speed.
    const top: AutopilotParams = { ...base };
    setCruiseSpeed(top, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
    expect(encounterTargetSpeed(0, top.cruiseSpeed, top.profile)).toBeLessThan(top.cruiseSpeed / 3);
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
      for (let i = 0; i < 1e6 && Number.isNaN(endedAt); i++) {
        const before = travel.autopilot.state;
        stepTravel(travel, dt);
        const { autopilot, ship } = travel;
        worstFadeStep = Math.max(worstFadeStep, Math.abs(autopilot.fade - prevFade));
        prevFade = autopilot.fade;
        if (before === 'CRUISE' && autopilot.state === 'APPROACH') startedAt = ship.time;
        if (before === 'DEPARTURE' && autopilot.state === 'CRUISE') endedAt = ship.time;
        const encounter = autopilot.encounter;
        if (encounter === null) continue;
        radius = encounter.plan.radius;
        minClearance = Math.min(minClearance, len(encounterOffset(encounter.plan, ship.position, rel)));
        if (autopilot.state === 'FLYBY') slowest = Math.min(slowest, autopilot.targetSpeed);
      }
      expect(endedAt).toBeGreaterThan(startedAt);
      // Clear of the planet, at its planned closest approach.
      expect(minClearance).toBeGreaterThanOrEqual(radius * (1 + ENCOUNTER_CLEARANCE_MARGIN));
      expect(minClearance).toBeCloseTo(radius * ENCOUNTER_SIDE_OFFSET_FACTOR, 0);
      // Fades in and out gradually: no frame changes the opacity by more than 2%.
      expect(worstFadeStep).toBeGreaterThan(0);
      expect(worstFadeStep).toBeLessThan(0.02);
      // Slows to the floor, not below it, so it does not crawl: one encounter takes about 195 s
      // (about 250 s with the unfloored minimum of 5).
      expect(slowest).toBeCloseTo(ENCOUNTER_MIN_SPEED_FLOOR, 9);
      expect(endedAt - startedAt).toBeLessThan(210);
    },
  );

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

      // ArrowUp: one speed level up, mid-encounter.
      const remainingBefore = travel.autopilot.remaining;
      setCruiseSpeed(travel.autopilotParams, SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL + 1]!);
      step(0);
      expect(travel.autopilot.state).toBe('APPROACH');
      expect(travel.autopilot.remaining).toBe(remainingBefore);
      expect(travel.shipParams.targetSpeed).toBeCloseTo(
        encounterTargetSpeed(remainingBefore, travel.autopilotParams.cruiseSpeed, travel.autopilotParams.profile),
        12,
      );
      expect(travel.shipParams.targetSpeed).toBeGreaterThan(frozen.autopilot.targetSpeed);

      // (Read through a function: TypeScript would otherwise keep the narrowing from the loop above.)
      const state = (): TravelState => travel.autopilot.state;
      while (state() !== 'CRUISE') step(dt);
      expect(states).toEqual(['CRUISE', ...CYCLE]);
      expect(worstJump).toBeLessThan(1e-9);
      expect(travel.ship.speed).toBeGreaterThan(SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL]!);
    },
  );
});
