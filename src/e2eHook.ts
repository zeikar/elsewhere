/**
 * Test-only hook for the Playwright e2e suite. It is installed only in the `e2e` Vite mode
 * (`vite build --mode e2e`), so it is absent from the production build (checked by
 * `npm run check:hook`).
 *
 * The hook is read-only toward the engine: getters expose engine state, and the only engine
 * methods are its own public API, which the UI will call anyway. `showPlanet` / `showEncounter` /
 * `hidePlanet` draw a planet or a nebula on a separate e2e-only canvas (src/e2ePlanetPreview.ts) and
 * never touch the engine.
 *
 * Performance instrumentation: `snapshot().perf` reports the engine's rolling frame-time statistics
 * (mean and 95th percentile of the frame interval and of the frame work time) and, in Chromium, the
 * used JS heap (`performance.memory`); `snapshot().renderer` reports `renderer.info`. `probe(out)`
 * is a cheap per-frame reading that writes into a caller-owned object, so a watcher running every
 * animation frame (the soak test's) allocates nothing.
 *
 * `e2eEngineOptions` reads e2e-only engine overrides from the page URL (also absent from the
 * production build): `?encounterInterval=<seconds>` shortens (or, with a huge value, effectively
 * disables) the encounter interval so tests run quickly, `?encounterKind=planet|nebula` makes
 * every encounter that kind, `?starLayers=far|near` draws only that star layer, `?headingDrift=0`
 * holds the heading at -Z (so the ship only translates), and `?arrivalSpeed=<u/s>` sets the arrival
 * speed (a value at or above the top speed flies encounters from the top speed, without dropping
 * out of warp, so tests that only need encounter cycles pass them about 2.5–3× sooner).
 */
import { Vector3 } from 'three';
import type { Engine, EngineOptions } from './engine/Engine';
import type { FrameStats } from './engine/FrameStats';
import type { EncounterKind, EncounterSide, TravelState } from './engine/Autopilot';
import { nebulaLayerPlaneDistance } from './engine/Nebula';
import type { PlanetType } from './engine/Planet';
import {
  hidePlanetPreview,
  showEncounterPreview,
  showPlanetPreview,
  type EncounterPreviewInfo,
  type PlanetPreviewInfo,
  type PlanetPreviewOptions,
} from './e2ePlanetPreview';

/** A rolling window of frame times, in milliseconds (`null` fields while the window is empty). */
export interface E2EFrameTimes {
  /** The most recent frame's value. */
  last: number | null;
  mean: number | null;
  /** 95th percentile (nearest rank). */
  p95: number | null;
  max: number | null;
  /** Frames in the window. */
  count: number;
  /** Frames recorded in total. */
  total: number;
}

/** What `probe` writes: a cheap per-frame reading of the engine. */
export interface E2EProbe {
  /** Frames the engine loop has run. */
  frames: number;
  paused: boolean;
  state: TravelState;
  /** Index of the encounter in progress, or -1 in CRUISE. */
  encounterIndex: number;
  /** Whether the encounter object (planet or nebula) is drawn this frame. */
  visible: boolean;
  /** Interval from the previous frame to the latest one, in ms (NaN when it had none, e.g. after a resume). */
  frameMs: number;
  /** The latest frame's work time (simulation, encounter sync, render call), in ms. */
  workMs: number;
  /** Ship travel position and speed. */
  x: number;
  y: number;
  z: number;
  speed: number;
}

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
    /** Unit direction of travel (the camera looks along it). */
    heading: { x: number; y: number; z: number };
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
  /** Performance instrumentation (see the module comment). */
  perf: {
    /** Time between consecutive frames. */
    frameMs: E2EFrameTimes;
    /** Main-thread work per frame: the simulation step, the encounter sync and the render call. */
    workMs: E2EFrameTimes;
    /** `performance.memory.usedJSHeapSize` in bytes (no forced GC), or `null` outside Chromium. */
    heapUsed: number | null;
  };
  starfield: {
    /** DPR uniform. */
    dpr: number;
    /** Base star width uniform, in device pixels. */
    pixelSize: number;
    /** Streak time uniform, in seconds. */
    streakTime: number;
    /** Whether the near layer is drawn. */
    visible: boolean;
  };
  /** The far-star layer (stars at infinity, turning with the camera only). */
  farStars: {
    count: number;
    /** Whether it is drawn. */
    visible: boolean;
    /** DPR uniform. */
    dpr: number;
    /** Base star width uniform, in device pixels. */
    pixelSize: number;
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
    /** Mean encounter interval in use, in seconds (each cruise is jittered around it). */
    interval: number;
    /** Arrival speed in use, in units per second (encounters are flown from min(cruise, this)). */
    arrivalSpeed: number;
    /** Planned closest distance between the path and the planet centre, or `null` with no encounter. */
    closestDistance: number | null;
    /** Kind of the encounter in progress, or `null` in CRUISE. */
    kind: EncounterKind | null;
    /** Side of the path the encounter object sits on, or `null` in CRUISE. */
    side: EncounterSide | null;
  };
  /** Objects in the scene besides the two star layers (the encounter planet or nebula). */
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
  /** The encounter nebula as last placed for rendering, or `null`. */
  nebula: {
    index: number;
    seed: number;
    family: string;
    /** Core radius in world units. */
    radius: number;
    /** Encounter opacity uniform. */
    opacity: number;
    visible: boolean;
    /** Render position: nebula centre relative to the ship (camera at the origin). */
    position: { x: number; y: number; z: number };
    /** Distance from the camera to the nebula centre. */
    distance: number;
    /** Nebula centre in normalised device coordinates. */
    ndc: { x: number; y: number; z: number };
    /** Per layer: distance from the camera to its plane, its near-camera fade, and whether it is drawn. */
    layers: { planeDistance: number; fade: number; visible: boolean }[];
  } | null;
}

export interface E2EHook {
  snapshot(): E2EHookSnapshot;
  /**
   * Writes a cheap reading of the engine into `out` and returns it; allocates nothing when `out` is
   * given (a new object otherwise). Meant for watchers that run every animation frame.
   */
  probe(out?: E2EProbe): E2EProbe;
  pause(): void;
  resume(): void;
  setSpeed(level: number): void;
  /**
   * Draws the `nth` (default 0) encounter planet of `type` at a fixed position in front of the camera
   * on an overlay canvas (`#planet-preview`), replacing any planet already shown. With
   * `{ farStars: true }` the far-star layer is drawn behind it, as in the engine.
   */
  showPlanet(type: PlanetType, nth?: number, options?: PlanetPreviewOptions): PlanetPreviewInfo;
  /**
   * Draws the planet or nebula for appearance seed `seed` on the same overlay canvas, replacing
   * anything shown: a planet framed as `showPlanet` frames it, a nebula as seen mid-APPROACH.
   */
  showEncounter(kind: EncounterKind, seed: number): EncounterPreviewInfo;
  /** Removes the planet overlay canvas. */
  hidePlanet(): void;
}

declare global {
  interface Window {
    __elsewhere?: E2EHook;
  }
}

/** Reads the e2e-only engine overrides from a URL query string (see the module comment). */
export function e2eEngineOptions(
  search: string,
): Pick<EngineOptions, 'encounterInterval' | 'encounterKind' | 'starLayers' | 'headingDrift' | 'arrivalSpeed'> {
  const query = new URLSearchParams(search);
  const raw = query.get('encounterInterval');
  const interval = raw === null ? Number.NaN : Number(raw);
  const kind = query.get('encounterKind');
  const layers = query.get('starLayers');
  const drift = query.get('headingDrift');
  const rawArrival = query.get('arrivalSpeed');
  const arrival = rawArrival === null ? Number.NaN : Number(rawArrival);
  return {
    ...(interval >= 0 ? { encounterInterval: interval } : {}),
    ...(kind === 'planet' || kind === 'nebula' ? { encounterKind: kind } : {}),
    ...(layers === 'far' || layers === 'near' || layers === 'both' ? { starLayers: layers } : {}),
    ...(drift === '0' ? { headingDrift: false } : {}),
    ...(arrival > 0 ? { arrivalSpeed: arrival } : {}),
  };
}

const ndc = new Vector3();

function frameTimes(stats: Readonly<FrameStats>): E2EFrameTimes {
  const orNull = (x: number) => (Number.isFinite(x) ? x : null);
  return {
    last: orNull(stats.last),
    mean: orNull(stats.mean()),
    p95: orNull(stats.percentile(95)),
    max: orNull(stats.max()),
    count: stats.count,
    total: stats.total,
  };
}

/** Used JS heap in bytes (Chromium's non-standard `performance.memory`), or `null`. */
function heapUsed(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

function newProbe(): E2EProbe {
  return {
    frames: 0,
    paused: false,
    state: 'CRUISE',
    encounterIndex: -1,
    visible: false,
    frameMs: Number.NaN,
    workMs: Number.NaN,
    x: 0,
    y: 0,
    z: 0,
    speed: 0,
  };
}

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
      const nebula = engine.getNebula();
      let nebulaView: E2EHookSnapshot['nebula'] = null;
      if (nebula !== null && autopilot.encounter !== null) {
        const p = nebula.object.position;
        ndc.copy(p).project(engine.getCamera());
        nebulaView = {
          index: autopilot.encounter.index,
          seed: nebula.params.seed,
          family: nebula.params.family,
          radius: nebula.params.radius,
          opacity: nebula.opacity.value,
          visible: nebula.object.visible,
          position: { x: p.x, y: p.y, z: p.z },
          distance: p.length(),
          ndc: { x: ndc.x, y: ndc.y, z: ndc.z },
          layers: nebula.layers.map((layer) => ({
            planeDistance: nebulaLayerPlaneDistance(p, nebula.object.scale.x, layer.placement),
            fade: layer.fade.value,
            visible: layer.mesh.visible,
          })),
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
          heading: { x: ship.heading.x, y: ship.heading.y, z: ship.heading.z },
        },
        renderer: {
          calls: info.render.calls,
          triangles: info.render.triangles,
          frame: info.render.frame,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
        },
        perf: {
          frameMs: frameTimes(engine.getFrameIntervals()),
          workMs: frameTimes(engine.getFrameWork()),
          heapUsed: heapUsed(),
        },
        starfield: { ...engine.getStarfieldSizing(), streakTime: engine.getStreakTime(), visible: engine.isStarfieldVisible() },
        farStars: engine.getFarStarfieldInfo(),
        autopilot: {
          state: autopilot.state,
          encounterIndex: autopilot.encounter?.index ?? null,
          encounterCount: autopilot.encounterCount,
          remaining: Number.isFinite(autopilot.remaining) ? autopilot.remaining : null,
          fade: autopilot.fade,
          targetSpeed: autopilot.targetSpeed,
          driftRate: autopilot.driftRate,
          interval: engine.getEncounterInterval(),
          arrivalSpeed: engine.getArrivalSpeed(),
          closestDistance: autopilot.encounter?.plan.closestDistance ?? null,
          kind: autopilot.encounter?.kind ?? null,
          side: autopilot.encounter?.side ?? null,
        },
        planets: engine.getPlanetCount(),
        planet: planetView,
        nebula: nebulaView,
      };
    },
    probe(out = newProbe()) {
      const ship = engine.getShip();
      const autopilot = engine.getAutopilot();
      out.frames = engine.getFrameCount();
      out.paused = engine.isPaused();
      out.state = autopilot.state;
      out.encounterIndex = autopilot.encounter?.index ?? -1;
      out.visible = engine.isEncounterVisible();
      out.frameMs = engine.getLastFrameInterval();
      out.workMs = engine.getFrameWork().last;
      out.x = ship.position.x;
      out.y = ship.position.y;
      out.z = ship.position.z;
      out.speed = ship.speed;
      return out;
    },
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    setSpeed: (level) => engine.setSpeed(level),
    showPlanet: (type, nth, options) => showPlanetPreview(type, nth, options),
    showEncounter: (kind, seed) => showEncounterPreview(kind, seed),
    hidePlanet: () => hidePlanetPreview(),
  };
  Object.defineProperty(window, '__elsewhere', { value: Object.freeze(hook), configurable: false });
}
