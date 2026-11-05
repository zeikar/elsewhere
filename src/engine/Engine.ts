/**
 * Engine: renderer, resize, frame loop, dt and visibility (docs/PLAN.md sections 6 and 8).
 *
 * The engine owns the frame loop and knows nothing about the DOM UI; the UI talks to it only through
 * the small public API below. The camera always sits at the origin and only takes the ship heading
 * (floating origin). Nothing is allocated inside the frame loop.
 *
 * Each frame runs one simulation step (`stepTravel`: the ship, then the Autopilot, which sets the
 * ship's target speed and drift rate), then the encounter view creates or disposes the encounter
 * object, a planet, a nebula, an asteroid or a comet (compiling its shaders with `renderer.compileAsync`
 * before it is first drawn), and the render places it relative to the ship. The encounter shader
 * programs themselves are compiled once at construction and kept for the whole run
 * (`ProgramWarmup`), so encounters reuse them instead of compiling their own. The two star layers keep running underneath: the far
 * stars (FarStarfield), which turn with the camera only, and the near starfield (Starfield), which
 * streams past with the ship's travel. The trip's distant galaxies (Galaxies, from the trip seed)
 * belong to the far layer and turn with the camera only, like the far stars.
 * Pausing stops the simulation, so the encounter freezes with it.
 *
 * Instrumentation (docs/PLAN.md section 6, Performance): every frame records its interval since the
 * previous frame (from the frame clock, so a pause or a hidden period is never counted) and its work
 * time (simulation, encounter sync and render submission, on the main thread) into two fixed-size
 * `FrameStats` windows, read through `getFrameIntervals()` and `getFrameWork()`.
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer, type WebGLInfo } from 'three';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  CLEAR_COLOR,
  DPR_CAP,
  ENCOUNTER_BASE_SEED,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
  VIEW_WIDEST_ASPECT,
} from '../config';
import {
  DEFAULT_AUTOPILOT_PARAMS,
  createTravel,
  encounterProfile,
  setCruiseSpeed,
  stepTravel,
  type AutopilotParams,
  type AutopilotState,
  type EncounterKind,
  type Travel,
} from './Autopilot';
import { asteroidParams, prepareAsteroids, type Asteroid } from './Asteroid';
import { cometParams, prepareComets, type Comet } from './Comet';
import { EncounterView } from './EncounterView';
import { FarStarfield } from './FarStarfield';
import { FrameClock } from './FrameClock';
import { FrameStats } from './FrameStats';
import { Galaxies, generateGalaxies, type Galaxy } from './Galaxies';
import { nebulaParams, nebulaProgramMaterials, type Nebula } from './Nebula';
import { cameraFovDeg, cameraFrustum, computeRenderSize, type ViewFrustum } from './renderSize';
import { planetParams, planetProgramMaterials, type Planet } from './Planet';
import { ProgramWarmup } from './ProgramWarmup';
import { DEFAULT_SHIP_PARAMS, type ShipState } from './Ship';
import { DEFAULT_STARFIELD_OPTIONS, Starfield } from './Starfield';

export interface EngineOptions {
  /**
   * Trip seed (a uint32): encounter `i` uses the appearance seed `hash(tripSeed, i)`, so one seed
   * fixes the whole sequence of kinds, appearances and placements. The app passes a random seed, or
   * the one in `?seed=` (src/tripSeed.ts). Default: ENCOUNTER_BASE_SEED, the test default.
   */
  tripSeed?: number;
  /** Speed level travel starts at (index into SHIP_SPEED_LEVELS, clamped). Default: SHIP_DEFAULT_SPEED_LEVEL. */
  speedLevel?: number;
  /** Starfield streak time, in seconds. Default: STAR_STREAK_TIME_SECONDS. */
  streakTime?: number;
  /** Encounter interval: seconds of cruise before each encounter. Default: ENCOUNTER_INTERVAL_SECONDS. */
  encounterInterval?: number;
  /** Makes every encounter this kind (the seeded mix of planets, nebulae, asteroids and comets otherwise). */
  encounterKind?: EncounterKind;
  /**
   * Arrival speed, in units per second: encounters are flown from min(cruise speed, this). Default:
   * ENCOUNTER_ARRIVAL_SPEED. A higher value (up to `Infinity`) flies them from a faster cruise speed
   * instead of dropping out of warp, so tests that only need encounter cycles pass them sooner.
   */
  arrivalSpeed?: number;
  /** Which star layers are drawn (the distant galaxies belong to the far layer). Default: 'both'. For tests that look at one layer alone. */
  starLayers?: StarLayers;
  /** Whether the heading drifts (the slow yaw and pitch). Default: true. Off, the heading stays at -Z. */
  headingDrift?: boolean;
}

/** Star layers to draw: the far stars, the near starfield, or both. */
export type StarLayers = 'both' | 'far' | 'near';

/** Called with the new paused state whenever pause() or resume() changes it. */
export type PausedChangeListener = (paused: boolean) => void;

export class Engine {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly clock = new FrameClock();
  /** Recent frame intervals, in milliseconds. */
  private readonly frameIntervals = new FrameStats();
  /** Recent frame work times (simulation step, encounter sync and render call), in milliseconds. */
  private readonly frameWork = new FrameStats();
  /** Ship, autopilot and their params, advanced by `stepTravel`. */
  private readonly travel: Travel;
  private readonly starfield: Starfield;
  private readonly farStarfield: FarStarfield;
  /** The trip's distant galaxies, on the far layer. */
  private readonly galaxies: Galaxies;
  private readonly encounterView: EncounterView;
  /** Keeps every encounter shader program compiled for the whole run (see ProgramWarmup.ts). */
  private readonly programWarmup: ProgramWarmup;
  private readonly pausedListeners = new Set<PausedChangeListener>();
  /** Scratch look-at target, reused every frame. */
  private readonly lookTarget = new Vector3();
  private resizeObserver: ResizeObserver | null = null;
  /** Matches only the current devicePixelRatio; re-registered after each change. */
  private dprQuery: MediaQueryList | null = null;

  private speedLevel: number;
  private paused = false;
  private running = false;
  private disposed = false;
  private rafId = 0;
  private frameCount = 0;
  private appliedDpr = 1;

  constructor(canvas: HTMLCanvasElement, options: EngineOptions = {}) {
    this.canvas = canvas;
    this.starfield = new Starfield({
      ...DEFAULT_STARFIELD_OPTIONS,
      streakTime: options.streakTime ?? DEFAULT_STARFIELD_OPTIONS.streakTime,
    });
    this.farStarfield = new FarStarfield();
    const layers = options.starLayers ?? 'both';
    this.starfield.mesh.visible = layers !== 'far';
    this.farStarfield.mesh.visible = layers !== 'near';
    const tripSeed = options.tripSeed === undefined ? ENCOUNTER_BASE_SEED : options.tripSeed >>> 0;
    this.galaxies = new Galaxies(generateGalaxies(tripSeed));
    // Hidden with no galaxy in the trip, or without the far layer.
    if (layers === 'near') this.galaxies.mesh.visible = false;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setClearColor(CLEAR_COLOR, 1);
    this.camera = new PerspectiveCamera(CAMERA_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 0, 0);
    this.speedLevel = clampSpeedLevel(options.speedLevel ?? SHIP_DEFAULT_SPEED_LEVEL, SHIP_DEFAULT_SPEED_LEVEL);
    const interval = options.encounterInterval;
    const kind = options.encounterKind;
    const autopilotParams: AutopilotParams = {
      ...DEFAULT_AUTOPILOT_PARAMS,
      baseSeed: tripSeed,
      interval: interval !== undefined && interval >= 0 ? interval : DEFAULT_AUTOPILOT_PARAMS.interval,
      arrivalSpeed:
        options.arrivalSpeed !== undefined && options.arrivalSpeed > 0 ? options.arrivalSpeed : DEFAULT_AUTOPILOT_PARAMS.arrivalSpeed,
      planetFor: planetParams,
      nebulaFor: nebulaParams,
      asteroidFor: asteroidParams,
      cometFor: cometParams,
      nebulaShare: kind === undefined ? DEFAULT_AUTOPILOT_PARAMS.nebulaShare : kind === 'nebula' ? 1 : 0,
      asteroidShare: kind === undefined ? DEFAULT_AUTOPILOT_PARAMS.asteroidShare : kind === 'asteroid' ? 1 : 0,
      cometShare: kind === undefined ? DEFAULT_AUTOPILOT_PARAMS.cometShare : kind === 'comet' ? 1 : 0,
    };
    setCruiseSpeed(autopilotParams, SHIP_SPEED_LEVELS[this.speedLevel] ?? 0);
    const shipParams =
      options.headingDrift === false ? { ...DEFAULT_SHIP_PARAMS, yawAmplitude: 0, pitchAmplitude: 0 } : DEFAULT_SHIP_PARAMS;
    this.travel = createTravel(autopilotParams, shipParams);
    this.scene.add(this.farStarfield.mesh, this.galaxies.mesh, this.starfield.mesh);
    // Each new encounter object's shaders compile (in parallel where supported) before it is first drawn.
    this.encounterView = new EncounterView(this.scene, (object) =>
      this.renderer.compileAsync(object, this.camera, this.scene),
    );
    // Compile the planet and nebula programs once, now, and keep them, so no encounter compiles any.
    // Asteroid rocks and comet nuclei draw with the rocky planet surface program, and a comet's coma
    // and tails with the planets' halo program, so they need no holder of their own; their CPU-side
    // building blocks are made now too, so the first asteroid's or comet's frame does not.
    this.programWarmup = new ProgramWarmup([...planetProgramMaterials(), ...nebulaProgramMaterials()]);
    void this.programWarmup.compile(this.renderer, this.camera, this.scene);
    prepareAsteroids();
    prepareComets();
    this.applyHeading();
  }

  /** Attaches resize and visibility handling and starts travelling. Call once; no-op after dispose(). */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    window.addEventListener('resize', this.resize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(this.canvas);
    }
    this.watchDpr();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    if (document.visibilityState === 'hidden') this.clock.hide();
    this.resize();
    if (!this.paused) this.requestFrame();
  }

  /** Stops the loop, detaches listeners and releases GPU resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.cancelFrame();
    window.removeEventListener('resize', this.resize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.pausedListeners.clear();
    this.encounterView.dispose();
    this.programWarmup.dispose();
    this.scene.remove(this.starfield.mesh, this.farStarfield.mesh, this.galaxies.mesh);
    this.starfield.dispose();
    this.farStarfield.dispose();
    this.galaxies.dispose();
    this.renderer.dispose();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.cancelFrame();
    this.notifyPausedChange();
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    // Forget the reference time so the paused duration never becomes a step.
    this.clock.reset();
    if (this.running) this.requestFrame();
    this.notifyPausedChange();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Calls `listener` with the new paused state on every pause/resume change. Returns an unsubscribe function. */
  onPausedChange(listener: PausedChangeListener): () => void {
    this.pausedListeners.add(listener);
    return () => {
      this.pausedListeners.delete(listener);
    };
  }

  /**
   * Sets the speed level, an index into SHIP_SPEED_LEVELS (clamped). It sets the autopilot's cruise
   * speed and scales its encounter speed profile with it (`setCruiseSpeed`) rather than overriding
   * it; above the arrival speed the ship drops out of warp before each encounter, so encounters keep
   * the arrival speed's profile. The ship eases toward the new target from the next step.
   */
  setSpeed(level: number): void {
    const clamped = clampSpeedLevel(level, this.speedLevel);
    this.speedLevel = clamped;
    setCruiseSpeed(this.travel.autopilotParams, SHIP_SPEED_LEVELS[clamped] ?? 0);
  }

  /** Current speed level (index into SHIP_SPEED_LEVELS). */
  getSpeed(): number {
    return this.speedLevel;
  }

  getSpeedLevelCount(): number {
    return SHIP_SPEED_LEVELS.length;
  }

  /** Pixel ratio actually applied to the renderer: min(devicePixelRatio, DPR_CAP). */
  getAppliedDpr(): number {
    return this.appliedDpr;
  }

  /** Number of frames the loop has run. */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Recent frame intervals in milliseconds: the time between consecutive frames, a rolling window
   * (read-only view; do not record into it). The first frame after a start, resume or the tab
   * becoming visible again has no interval, so pauses and hidden periods never show up as frames.
   */
  getFrameIntervals(): Readonly<FrameStats> {
    return this.frameIntervals;
  }

  /**
   * Recent frame work times in milliseconds: the main-thread time each frame spends on the
   * simulation step, the encounter sync and the render call, a rolling window (read-only view; do
   * not record into it). A synchronous shader compile, for example, shows up here.
   */
  getFrameWork(): Readonly<FrameStats> {
    return this.frameWork;
  }

  /**
   * The latest frame's interval since the frame before it, in milliseconds, or NaN when it had none
   * (the first frame after a start, resume or the tab becoming visible again).
   */
  getLastFrameInterval(): number {
    return this.clock.lastIntervalMs;
  }

  /** Whether the current encounter object, planet, nebula, asteroid or comet, is drawn; false with none. */
  isEncounterVisible(): boolean {
    return this.encounterView.getObject()?.object.visible ?? false;
  }

  /** Live ship state (read-only view; do not modify). */
  getShip(): Readonly<ShipState> {
    return this.travel.ship;
  }

  /** Live autopilot state (read-only view; do not modify). */
  getAutopilot(): Readonly<AutopilotState> {
    return this.travel.autopilot;
  }

  /** Trip seed in use (a uint32; see EngineOptions.tripSeed). */
  getTripSeed(): number {
    return this.travel.autopilotParams.baseSeed;
  }

  /** Encounter interval in use, in seconds. */
  getEncounterInterval(): number {
    return this.travel.autopilotParams.interval;
  }

  /** Arrival speed in use, in units per second (see EngineOptions.arrivalSpeed). */
  getArrivalSpeed(): number {
    return this.travel.autopilotParams.arrivalSpeed;
  }

  /** The view the autopilot tests encounter objects against: the camera's, set on every resize (read-only view). */
  getAutopilotView(): Readonly<ViewFrustum> | null {
    return this.travel.autopilotParams.view;
  }

  /** The current encounter's planet, or `null` outside planet encounters (read-only view; do not modify). */
  getPlanet(): Planet | null {
    return this.encounterView.getPlanet();
  }

  /** The current encounter's nebula, or `null` outside nebula encounters (read-only view; do not modify). */
  getNebula(): Nebula | null {
    return this.encounterView.getNebula();
  }

  /** The current encounter's asteroid, or `null` outside asteroid encounters (read-only view; do not modify). */
  getAsteroid(): Asteroid | null {
    return this.encounterView.getAsteroid();
  }

  /** The current encounter's comet, or `null` outside comet encounters (read-only view; do not modify). */
  getComet(): Comet | null {
    return this.encounterView.getComet();
  }

  /** Number of objects in the scene besides the star layers and galaxies: the encounter objects (planets, nebulae, asteroids or comets). */
  getPlanetCount(): number {
    let count = 0;
    for (const child of this.scene.children) {
      if (child !== this.starfield.mesh && child !== this.farStarfield.mesh && child !== this.galaxies.mesh) count++;
    }
    return count;
  }

  /** The camera (read-only view; do not modify). */
  getCamera(): PerspectiveCamera {
    return this.camera;
  }

  getCameraAspect(): number {
    return this.camera.aspect;
  }

  /** The camera's live vertical field of view, in degrees (narrower than CAMERA_FOV_DEG beyond 21:9). */
  getCameraFov(): number {
    return this.camera.fov;
  }

  getRendererInfo(): Readonly<WebGLInfo> {
    return this.renderer.info;
  }

  /** Starfield streak time, in seconds. */
  getStreakTime(): number {
    return this.starfield.uniforms.uStreakTime.value;
  }

  /** Starfield DPR and base pixel-size uniforms (device pixels). */
  getStarfieldSizing(): { dpr: number; pixelSize: number } {
    const u = this.starfield.uniforms;
    return { dpr: u.uDpr.value, pixelSize: u.uPixelSize.value };
  }

  /** Whether the near starfield is drawn. */
  isStarfieldVisible(): boolean {
    return this.starfield.mesh.visible;
  }

  /** Far-star layer: star count, whether it is drawn, and its DPR and base pixel-size uniforms (device pixels). */
  getFarStarfieldInfo(): { count: number; visible: boolean; dpr: number; pixelSize: number } {
    const u = this.farStarfield.uniforms;
    return {
      count: this.farStarfield.mesh.geometry.instanceCount,
      visible: this.farStarfield.mesh.visible,
      dpr: u.uDpr.value,
      pixelSize: u.uPixelSize.value,
    };
  }

  /** The trip's distant galaxies (read-only view; do not modify) and whether they are drawn. */
  getGalaxyInfo(): { galaxies: readonly Galaxy[]; visible: boolean } {
    return { galaxies: this.galaxies.galaxies, visible: this.galaxies.mesh.visible };
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (this.paused || !this.running) return;
    this.requestFrame();
    const dt = this.clock.tick(now);
    this.frameIntervals.record(this.clock.lastIntervalMs);
    const workStart = performance.now();
    stepTravel(this.travel, dt);
    this.encounterView.sync(this.travel.autopilot);
    this.frameCount++;
    this.render();
    this.frameWork.record(performance.now() - workStart);
  };

  private readonly resize = (): void => {
    const cssWidth = this.canvas.clientWidth || window.innerWidth;
    const cssHeight = this.canvas.clientHeight || window.innerHeight;
    const size = computeRenderSize(cssWidth, cssHeight, window.devicePixelRatio, DPR_CAP);
    this.appliedDpr = size.dpr;
    this.renderer.setPixelRatio(size.dpr);
    // updateStyle = false: CSS keeps the canvas at full viewport size.
    this.renderer.setSize(size.cssWidth, size.cssHeight, false);
    this.camera.aspect = size.cssWidth / size.cssHeight;
    // Beyond 21:9 the vertical field of view narrows, so the horizontal one stays at the 21:9 one
    // (config.ts, VIEW_WIDEST_ASPECT).
    this.camera.fov = cameraFovDeg(CAMERA_FOV_DEG, this.camera.aspect, VIEW_WIDEST_ASPECT);
    this.camera.updateProjectionMatrix();
    // The autopilot ends an encounter's slow phase once its object is off this screen, so encounter
    // timing follows the screen's shape (config.ts, VIEW_DEFAULT_ASPECT).
    this.travel.autopilotParams.view = cameraFrustum(CAMERA_FOV_DEG, this.camera.aspect, VIEW_WIDEST_ASPECT);
    this.starfield.setRenderSize(size);
    this.farStarfield.setRenderSize(size);
    // Setting the canvas size clears it; redraw now so a paused view stays correct.
    this.render();
  };

  /**
   * A devicePixelRatio change alone (e.g. moving the window to a monitor with another scale factor)
   * may fire neither `resize` nor the ResizeObserver, so watch a media query that matches only the
   * current ratio. It stops matching once the ratio changes, so it is replaced after each change.
   */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    if (typeof window.matchMedia !== 'function') return;
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private readonly onDprChange = (): void => {
    if (this.disposed) return;
    this.watchDpr();
    this.resize();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.clock.hide();
    } else {
      this.clock.show();
    }
  };

  private render(): void {
    const { ship, autopilot, autopilotParams } = this.travel;
    this.applyHeading();
    this.starfield.update(ship);
    const kind = autopilot.encounter?.kind ?? 'planet';
    this.encounterView.place(autopilot, ship, encounterProfile(autopilotParams, kind));
    this.renderer.render(this.scene, this.camera);
  }

  /** Camera stays at the origin and looks along the ship heading. */
  private applyHeading(): void {
    const h = this.travel.ship.heading;
    this.lookTarget.set(h.x, h.y, h.z);
    this.camera.lookAt(this.lookTarget);
  }

  private notifyPausedChange(): void {
    for (const listener of this.pausedListeners) listener(this.paused);
  }

  private requestFrame(): void {
    if (this.rafId === 0) this.rafId = requestAnimationFrame(this.frame);
  }

  private cancelFrame(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
}

/** Rounds and clamps a speed level into SHIP_SPEED_LEVELS; a non-finite level falls back to `fallback`. */
function clampSpeedLevel(level: number, fallback: number): number {
  const max = SHIP_SPEED_LEVELS.length - 1;
  return Math.min(max, Math.max(0, Math.round(Number.isFinite(level) ? level : fallback)));
}
