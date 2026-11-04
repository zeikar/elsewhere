/**
 * Test-only hook for the Playwright e2e suite. It is installed only in the `e2e` Vite mode
 * (`vite build --mode e2e`), so it is absent from the production build (checked by
 * `npm run check:hook`).
 *
 * The hook is read-only toward the engine: getters expose engine state, and the only engine
 * methods are its own public API, which the UI will call anyway. `showPlanet` / `hidePlanet` draw a
 * planet on a separate e2e-only canvas (src/e2ePlanetPreview.ts) and never touch the engine.
 */
import type { Engine } from './engine/Engine';
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

export function installE2EHook(engine: Engine): void {
  const hook: E2EHook = {
    snapshot() {
      const ship = engine.getShip();
      const info = engine.getRendererInfo();
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
