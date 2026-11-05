/**
 * The fixed heading (issue #62; docs/PLAN.md section 6, Starfield, and section 7): the ship always
 * flies along -Z, so the camera's rotation never changes and the far stars and galaxies, which turn
 * with the camera only, are a still backdrop. Only the near dust streams past, along the velocity.
 * And since the ship never turns, it flies the planned path past every object even after the
 * encounter has ended off screen, short of the closest approach: the real pass is the planned one.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  SHIP_HEADING,
  SHIP_SPEED_LEVELS,
  VIEW_DEFAULT_ASPECT,
  VIEW_WIDEST_ASPECT,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  createTravel,
  encounterSchedule,
  planetViewRadiusFactor,
  setCruiseSpeed,
  stepTravel,
  type AutopilotParams,
  type TravelState,
} from './Autopilot';
import { asteroidParams, asteroidRockPassDistances, rockPosition } from './Asteroid';
import { cometParams } from './Comet';
import { encounterOffset, encounterRemaining, type Encounter } from './encounter';
import { createEngineTravel } from './Engine';
import { encounterAsteroidParams } from './EncounterView';
import { FarStarfield, farStarViewDirection } from './FarStarfield';
import { Galaxies, galaxyViewCorner, generateGalaxies } from './Galaxies';
import { planetParams } from './Planet';
import { cameraFrustum } from './renderSize';
import { DEFAULT_SHIP_PARAMS, type Vec3 } from './Ship';
import { Starfield } from './Starfield';

/** Distance from `p` to the segment from `a` to `b`. */
function pointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const l2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = l2 > 0 ? Math.min(1, Math.max(0, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / l2)) : 0;
  return Math.hypot(ap.x - ab.x * t, ap.y - ab.y * t, ap.z - ab.z * t);
}

describe('the fixed heading', () => {
  it("over 600 s of the default trip, through planet and nebula encounters, every state and speed-level changes, the camera's world rotation never changes, so neither do the far stars and galaxies on screen", () => {
    // The engine's own travel (the test default trip seed and the engine's seeded objects), its
    // camera placed each frame as Engine.applyHeading places it: at the origin, looking along the heading.
    const travel = createEngineTravel();
    const camera = new PerspectiveCamera(CAMERA_FOV_DEG, VIEW_DEFAULT_ASPECT, CAMERA_NEAR, CAMERA_FAR);
    const look = new Vector3();
    const place = () => {
      const h = travel.ship.heading;
      camera.lookAt(look.set(h.x, h.y, h.z));
      camera.updateMatrixWorld();
    };
    place();
    const rotation = camera.quaternion.clone();
    // Looking along -Z with world +Y up is the identity rotation.
    expect(rotation.equals(new Quaternion())).toBe(true);
    const farStars = new FarStarfield();
    const galaxies = generateGalaxies(travel.autopilotParams.baseSeed);
    expect(galaxies.length).toBeGreaterThan(0);
    // Every far star's and galaxy corner's view direction, on screen or not: what the shaders draw.
    const farDirections = (): number[] => {
      const out: number[] = [];
      const v = { x: 0, y: 0, z: 0 };
      const dirs = farStars.mesh.geometry.getAttribute('aDirection');
      for (let i = 0; i < dirs.count; i += 7) {
        farStarViewDirection({ x: dirs.getX(i), y: dirs.getY(i), z: dirs.getZ(i) }, camera.matrixWorldInverse, v);
        out.push(v.x, v.y, v.z);
      }
      for (const g of galaxies) {
        for (const [cx, cy] of [[-1, -1], [1, 1]] as const) {
          galaxyViewCorner(g, cx, cy, camera.matrixWorldInverse, v);
          out.push(v.x, v.y, v.z);
        }
      }
      return out;
    };
    const sky = farDirections();
    const starfield = new Starfield();

    const dt = 1 / 60;
    const seconds = 600;
    // Speed-level changes, as the Speed setting makes them (Engine.setSpeed).
    const levelAt = new Map([
      [Math.round(150 / dt), 2],
      [Math.round(300 / dt), 0],
      [Math.round(450 / dt), 1],
    ]);
    const states = new Set<TravelState>();
    const met: { index: number; kind: string; side: string }[] = [];
    let worstRotation = 0;
    let fastest = 0;
    let slowest = Number.POSITIVE_INFINITY;
    for (let i = 1; i <= seconds / dt; i++) {
      const level = levelAt.get(i);
      if (level !== undefined) setCruiseSpeed(travel.autopilotParams, SHIP_SPEED_LEVELS[level]!);
      stepTravel(travel, dt);
      place();
      starfield.update(travel.ship);
      states.add(travel.autopilot.state);
      const encounter = travel.autopilot.encounter;
      if (encounter !== null && met.at(-1)?.index !== encounter.index) met.push({ index: encounter.index, kind: encounter.kind, side: encounter.side });
      worstRotation = Math.max(worstRotation, camera.quaternion.angleTo(rotation));
      expect(camera.quaternion.equals(rotation)).toBe(true);
      expect(travel.ship.heading).toEqual(SHIP_HEADING);
      // The near dust streaks along the velocity: the heading × the speed, straight back along -Z.
      const v = starfield.uniforms.uVelocity.value;
      expect([v.x, v.y]).toEqual([0, 0]);
      expect(v.z).toBeCloseTo(-travel.ship.speed, 9);
      if (travel.ship.time > 30) slowest = Math.min(slowest, travel.ship.speed);
      fastest = Math.max(fastest, travel.ship.speed);
    }
    expect(travel.ship.time).toBeGreaterThanOrEqual(240);
    expect(worstRotation).toBe(0);
    expect(farDirections()).toEqual(sky);
    // It went through every state of several encounters, and the speed levels it was set to.
    expect(states).toEqual(new Set<TravelState>(['CRUISE', 'APPROACH', 'FLYBY', 'DEPARTURE']));
    // The default trip's schedule, met in order: the seeded kinds and sides (the default test seed
    // opens planet, nebula, planet, nebula; Autopilot.test.ts pins it).
    expect(met.length).toBeGreaterThanOrEqual(4);
    expect(met).toEqual(encounterSchedule(travel.autopilotParams, met.length).map(({ index, kind, side }) => ({ index, kind, side })));
    expect(met.slice(0, 4).map((m) => m.kind)).toEqual(['planet', 'nebula', 'planet', 'nebula']);
    expect(fastest).toBeGreaterThan(0.95 * SHIP_SPEED_LEVELS[2]);
    expect(slowest).toBeLessThan(SHIP_SPEED_LEVELS[0] * 1.05);
    starfield.dispose();
    farStars.dispose();
    new Galaxies(galaxies).dispose();
  });
});

/** Autopilot params with every encounter of `kind`, the engine's seeded objects, at speed level `level`, on a screen of `aspect`. */
function onlyKind(kind: 'planet' | 'asteroid' | 'comet', level: number, aspect: number, baseSeed: number): AutopilotParams {
  const params: AutopilotParams = {
    ...DEFAULT_AUTOPILOT_PARAMS,
    baseSeed,
    view: cameraFrustum(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT),
    planetFor: planetParams,
    asteroidFor: asteroidParams,
    cometFor: cometParams,
    nebulaShare: 0,
    asteroidShare: kind === 'asteroid' ? 1 : 0,
    cometShare: kind === 'comet' ? 1 : 0,
  };
  setCruiseSpeed(params, SHIP_SPEED_LEVELS[level]!);
  return params;
}

describe('the real pass (flown with the live view, past the end of the encounter)', () => {
  const ASPECTS = [4 / 3, 16 / 9, 21 / 9, 32 / 9];
  const TRIPS = 4;

  it.each(['planet', 'asteroid', 'comet'] as const)(
    'every %s target (the planet, each asteroid rock, the comet nucleus) is passed at its planned closest distance, within 0.5%%, at every level and screen shape',
    (kind) => {
      let worstLow = Number.POSITIVE_INFINITY;
      let worstHigh = 0;
      let endedEarly = 0;
      let trips = 0;
      for (let level = 0; level < SHIP_SPEED_LEVELS.length; level++) {
        for (const aspect of ASPECTS) {
          for (let n = 0; n < TRIPS; n++) {
            const travel = createTravel(onlyKind(kind, level, aspect, 0x62f1 + 97 * n + 13 * level + ASPECTS.indexOf(aspect)), DEFAULT_SHIP_PARAMS);
            let plan: Encounter | null = null;
            // What is passed, relative to the object's centre, with its planned closest distance, and
            // the radius beyond which it is wholly behind the camera.
            let targets: { at: Vec3; planned: number }[] = [];
            let behind = 0;
            let nearest: number[] = [];
            let ended = false;
            let remainingAtEnd = Number.NaN;
            const a = { x: 0, y: 0, z: 0 };
            const b = { x: 0, y: 0, z: 0 };
            for (let i = 0; i < 1e6; i++) {
              const hasPrev = plan !== null;
              if (hasPrev) encounterOffset(plan!, travel.ship.position, a);
              stepTravel(travel, 1 / 60);
              const encounter = travel.autopilot.encounter;
              if (plan === null) {
                if (encounter === null) continue;
                // A copy: the measurement goes on after the autopilot has let go of the encounter.
                plan = structuredClone(encounter.plan);
                if (encounter.kind === 'asteroid') {
                  const p = encounterAsteroidParams(encounter);
                  const planned = asteroidRockPassDistances(p.rocks, plan.closestDistance);
                  targets = p.rocks.map((rock, j) => ({ at: rockPosition(rock.offset, plan!, { x: 0, y: 0, z: 0 }), planned: planned[j]! }));
                  behind = plan.radius;
                } else {
                  targets = [{ at: { x: 0, y: 0, z: 0 }, planned: plan.closestDistance }];
                  behind = encounter.kind === 'planet' ? plan.radius * planetViewRadiusFactor(encounter.planet) : plan.radius;
                }
                expect(encounter.kind).toBe(kind);
                nearest = targets.map(() => Number.POSITIVE_INFINITY);
              }
              encounterOffset(plan, travel.ship.position, b);
              if (!ended && encounter === null) {
                ended = true;
                remainingAtEnd = encounterRemaining(plan, travel.ship.position);
              }
              // The frame's segment of the ship's path, relative to the object's centre.
              const from = hasPrev ? { x: -a.x, y: -a.y, z: -a.z } : { x: -b.x, y: -b.y, z: -b.z };
              const to = { x: -b.x, y: -b.y, z: -b.z };
              targets.forEach((t, j) => (nearest[j] = Math.min(nearest[j]!, pointToSegment(t.at, from, to))));
              // On until the whole object is behind the camera (the heading is the camera's forward axis).
              const h = travel.ship.heading;
              if (b.x * h.x + b.y * h.y + b.z * h.z < -behind) break;
            }
            const label = `${kind}, level ${level}, aspect ${aspect.toFixed(2)}, trip ${n}`;
            expect(plan, label).not.toBeNull();
            expect(ended, label).toBe(true);
            if (remainingAtEnd > 0) endedEarly++;
            targets.forEach((t, j) => {
              const ratio = nearest[j]! / t.planned;
              expect(ratio, `${label}, target ${j}`).toBeGreaterThanOrEqual(0.995);
              expect(ratio, `${label}, target ${j}`).toBeLessThanOrEqual(1.005);
              worstLow = Math.min(worstLow, ratio);
              worstHigh = Math.max(worstHigh, ratio);
            });
            trips++;
          }
        }
      }
      expect(trips).toBe(SHIP_SPEED_LEVELS.length * ASPECTS.length * TRIPS);
      // The case measured: most of these encounters ended off screen before the closest approach.
      expect(endedEarly / trips).toBeGreaterThan(0.5);
      // Not merely within 0.5%: the ship flies the planned line exactly.
      expect(worstLow).toBeGreaterThan(1 - 1e-9);
      expect(worstHigh).toBeLessThan(1 + 1e-9);
    },
    120_000,
  );
});
