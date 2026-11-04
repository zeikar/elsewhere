/**
 * Test-only hook for the Playwright e2e suite. It is installed only in the `e2e` Vite mode
 * (`vite build --mode e2e`), so it is absent from the production build (checked by
 * `npm run check:hook`).
 *
 * The hook is read-only toward the engine: getters expose engine state, and the only engine
 * methods are its own public API, which the UI will call anyway. `showPlanet` / `hidePlanet` draw a
 * planet on a separate e2e-only canvas (src/e2ePlanetPreview.ts) and never touch the engine.
 *
 * `e2eEngineOptions` reads e2e-only engine overrides from the page URL (also absent from the
 * production build): `?encounterInterval=<seconds>` shortens (or, with a huge value, effectively
 * disables) the encounter interval so tests run quickly.
 */
import { Vector3 } from 'three';
import type { Engine, EngineOptions } from './engine/Engine';
import type { TravelState } from './engine/Autopilot';
import type { PlanetType } from './engine/Planet';
import { hidePlanetPreview, showPlanetPreview, type PlanetPreviewInfo } from './e2ePlanetPreview';

export interface E2EHookSnapshot {
  /** Speed level (index into SHIP_SPEED_LEVELS). */
  speed: number;
  paused: boolean;
  /** Pixel ratio applied to the renderer. */
  dpr: number;
  frames: number;
  cameraAspect: number;
  ship: {
    time: number;
    speed: number;
    distance: number;
    position: { x: number; y: number; z: number };
  };
  renderer: {
    calls: number;
    triangles: number;
    frame: number;
    geometries: number;
    textures: number;
    /** Compiled shader programs. */
    programs: number;
  };
  starfield: {
    /** DPR uniform. */
    dpr: number;
    /** Base star width uniform, in device pixels. */
    pixelSize: number;
    /** Streak time uniform, in seconds. */
    streakTime: number;
  };
  autopilot: {
    state: TravelState;
    /** Index of the encounter in progress, or `null` in CRUISE. */
    encounterIndex: number | null;
    /** Encounters started so far. */
    encounterCount: number;
    /** Remaining distance to the closest approach; `null` (Infinity) with no encounter. */
    remaining: number | null;
    /** Planet opacity the autopilot asks for, in [0, 1]. */
    fade: number;
    targetSpeed: number;
    driftRate: number;
    /** Encounter interval in use, in seconds. */
    interval: number;
    /** Planned closest distance between the path and the planet centre, or `null` with no encounter. */
    closestDistance: number | null;
  };
  /** Objects in the scene besides the starfield (the planets). */
  planets: number;
  /** The encounter planet as last placed for rendering, or `null`. */
  planet: {
    index: number;
    type: PlanetType;
    seed: number;
    /** Planet radius in world units. */
    radius: number;
    /** Drawn radius in world units (radius × the encounter's size scale). */
    drawnRadius: number;
    /** Opacity uniform. */
    opacity: number;
    visible: boolean;
    /** Render position: planet centre relative to the ship (camera at the origin). */
    position: { x: number; y: number; z: number };
    /** Distance from the camera to the planet centre. */
    distance: number;
    /** Planet centre in normalised device coordinates (x, y in [-1, 1] on screen, z < 1 in front). */
    ndc: { x: number; y: number; z: number };
  } | null;
}

export interface E2EHook {
  snapshot(): E2EHookSnapshot;
  pause(): void;
  resume(): void;
  setSpeed(level: number): void;
  /**
   * Draws the `nth` (default 0) encounter planet of `type` at a fixed position in front of the camera
   * on an overlay canvas (`#planet-preview`), replacing any planet already shown.
   */
  showPlanet(type: PlanetType, nth?: number): PlanetPreviewInfo;
  /** Removes the planet overlay canvas. */
  hidePlanet(): void;
}

declare global {
  interface Window {
    __elsewhere?: E2EHook;
  }
}

/** Reads the e2e-only engine overrides from a URL query string (see the module comment). */
export function e2eEngineOptions(search: string): Pick<EngineOptions, 'encounterInterval'> {
  const raw = new URLSearchParams(search).get('encounterInterval');
  const interval = raw === null ? Number.NaN : Number(raw);
  return interval >= 0 ? { encounterInterval: interval } : {};
}

const ndc = new Vector3();

export function installE2EHook(engine: Engine): void {
  const hook: E2EHook = {
    snapshot() {
      const ship = engine.getShip();
      const info = engine.getRendererInfo();
      const autopilot = engine.getAutopilot();
      const planet = engine.getPlanet();
      let planetView: E2EHookSnapshot['planet'] = null;
      if (planet !== null && autopilot.encounter !== null) {
        const p = planet.object.position;
        ndc.copy(p).project(engine.getCamera());
        planetView = {
          index: autopilot.encounter.index,
          type: planet.params.type,
          seed: planet.params.seed,
          radius: planet.params.radius,
          drawnRadius: planet.object.scale.x,
          opacity: planet.uniforms.uOpacity.value,
          visible: planet.object.visible,
          position: { x: p.x, y: p.y, z: p.z },
          distance: p.length(),
          ndc: { x: ndc.x, y: ndc.y, z: ndc.z },
        };
      }
      return {
        speed: engine.getSpeed(),
        paused: engine.isPaused(),
        dpr: engine.getAppliedDpr(),
        frames: engine.getFrameCount(),
        cameraAspect: engine.getCameraAspect(),
        ship: {
          time: ship.time,
          speed: ship.speed,
          distance: ship.distance,
          position: { x: ship.position.x, y: ship.position.y, z: ship.position.z },
        },
        renderer: {
          calls: info.render.calls,
          triangles: info.render.triangles,
          frame: info.render.frame,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
        },
        starfield: { ...engine.getStarfieldSizing(), streakTime: engine.getStreakTime() },
        autopilot: {
          state: autopilot.state,
          encounterIndex: autopilot.encounter?.index ?? null,
          encounterCount: autopilot.encounterCount,
          remaining: Number.isFinite(autopilot.remaining) ? autopilot.remaining : null,
          fade: autopilot.fade,
          targetSpeed: autopilot.targetSpeed,
          driftRate: autopilot.driftRate,
          interval: engine.getEncounterInterval(),
          closestDistance: autopilot.encounter?.plan.closestDistance ?? null,
        },
        planets: engine.getPlanetCount(),
        planet: planetView,
      };
    },
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    setSpeed: (level) => engine.setSpeed(level),
    showPlanet: (type, nth) => showPlanetPreview(type, nth),
    hidePlanet: () => hidePlanetPreview(),
  };
  Object.defineProperty(window, '__elsewhere', { value: Object.freeze(hook), configurable: false });
}
