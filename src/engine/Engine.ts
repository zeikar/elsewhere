/**
 * Engine: renderer, resize, frame loop, dt and visibility (docs/PLAN.md sections 6 and 8).
 *
 * The engine owns the frame loop and knows nothing about the DOM UI; the UI talks to it only through
 * the small public API below. The camera always sits at the origin and only takes the ship heading
 * (floating origin), which is fixed (SHIP_HEADING), so the camera never turns. Nothing is allocated inside the frame loop.
 *
 * Each frame runs one simulation step (`stepTravel`: the ship, then the Autopilot, which sets the
 * ship's target speed), then the encounter view creates or disposes the encounter
 * object, a planet, a nebula, an asteroid or a comet (compiling its shaders with `renderer.compileAsync`
 * before it is first drawn), and the render places it relative to the ship. The encounter shader
 * programs themselves are compiled once at construction and kept for the whole run
 * (`ProgramWarmup`), so encounters reuse them instead of compiling their own. The two star layers keep running underneath: the far
 * stars (FarStarfield), which turn with the camera only, and the near starfield (Starfield), which
 * streams past with the ship's travel. The trip's distant galaxies (Galaxies, from the trip seed)
 * belong to the far layer and turn with the camera only, like the far stars.
 * Pausing stops the simulation, so the encounter freezes with it.
 *
 * Planet surface bake (issue #65, PlanetBake.ts): where the GPU can render to half-float textures,
 * each planet's surface is baked into cube maps a slice a frame, just before the frame's render,
 * once the bake programs (compiled at start-up with a render target bound, after the screen
 * programs) and the planet's own compile are ready; until the bake is done the planet is drawn
 * procedurally. After a WebGL context restore the warm-ups compile again and the planet bakes again.
 *
 * Frame-rate cap (docs/PLAN.md section 6, Performance): the loop draws at most about FRAME_RATE_CAP
 * frames a second (FrameCap.ts), skipping display frames on faster displays; a skipped frame runs
 * nothing, and the next drawn one steps the simulation by the real time since the last drawn one.
 *
 * Instrumentation (docs/PLAN.md section 6, Performance): every drawn frame records its interval since the
 * previous frame (from the frame clock, so a pause or a hidden period is never counted) and its work
 * time (simulation, encounter sync and render submission, on the main thread) into two fixed-size
 * `FrameStats` windows, read through `getFrameIntervals()` and `getFrameWork()`. On request
 * (`EngineOptions.gpuTiming`) it also times each frame's GPU work where the browser can
 * (`EXT_disjoint_timer_query_webgl2`, GpuTimer.ts), into a third window, `getGpuFrameTimes()`.
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderTarget, WebGLRenderer, type WebGLInfo } from 'three';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  CLEAR_COLOR,
  DPR_CAP,
  ENCOUNTER_BASE_SEED,
  FRAME_CAP_TOLERANCE_MS,
  FRAME_RATE_CAP,
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
import { FrameCap } from './FrameCap';
import { FrameClock } from './FrameClock';
import { FrameStats } from './FrameStats';
import { GpuTimer } from './GpuTimer';
import { Galaxies, generateGalaxies, type Galaxy } from './Galaxies';
import { nebulaParams, nebulaProgramMaterials, type Nebula } from './Nebula';
import { cameraFovDeg, cameraFrustum, computeRenderSize, type ViewFrustum } from './renderSize';
import { SurfaceBake, planetBakeProgramMaterials, planetParams, planetProgramMaterials, type Planet } from './Planet';
import { PlanetBaker } from './PlanetBake';
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
  /**
   * Times each frame's GPU work with `EXT_disjoint_timer_query_webgl2` where the browser has it
   * (GpuTimer.ts), read through `getGpuFrameTimes()`. Default: false (the e2e build turns it on with
   * `?gpuTiming=1`).
   */
  gpuTiming?: boolean;
  /** Frame-rate cap in frames per second (0: none). Default: FRAME_RATE_CAP. */
  frameRateCap?: number;
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
  /** Decides which display frames are drawn (FRAME_RATE_CAP). */
  private readonly frameCap: FrameCap;
  /** Recent frame intervals, in milliseconds. */
  private readonly frameIntervals = new FrameStats();
  /** Recent frame work times (simulation step, encounter sync and render call), in milliseconds. */
  private readonly frameWork = new FrameStats();
  /** Recent frames' GPU times, in milliseconds, when GPU timing is on and supported. */
  private readonly gpuFrames = new FrameStats();
  /** Times each frame's GPU work, or `null` with GPU timing off. */
  private gpuTimer: GpuTimer | null = null;
  /** Ship, autopilot and their params, advanced by `stepTravel`. */
  private readonly travel: Travel;
  private readonly starfield: Starfield;
  private readonly farStarfield: FarStarfield;
  /** The trip's distant galaxies, on the far layer. */
  private readonly galaxies: Galaxies;
  private readonly encounterView: EncounterView;
  /** Keeps every encounter shader program compiled for the whole run (see ProgramWarmup.ts). */
  private readonly programWarmup: ProgramWarmup;
  /** Keeps the planet bake programs compiled (built for a render target), or `null` without baking. */
  private readonly bakeWarmup: ProgramWarmup | null;
  /** Draws each planet's surface bake a slice a frame (PlanetBake.ts), or `null` where the GPU cannot. */
  private readonly planetBaker: PlanetBaker | null;
  /** The planet the latest frame drew, if any: its bake starts from the frame after the first that drew it. */
  private drawnPlanet: Planet | null = null;
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
  /** Counts `warmUp` calls, so a warm-up superseded by a context restore does not go on to the bake programs. */
  private warmupGeneration = 0;

  constructor(canvas: HTMLCanvasElement, options: EngineOptions = {}) {
    this.canvas = canvas;
    this.frameCap = new FrameCap(options.frameRateCap ?? FRAME_RATE_CAP, FRAME_CAP_TOLERANCE_MS);
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
    if (options.gpuTiming === true) this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext);
    this.camera = new PerspectiveCamera(CAMERA_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 0, 0);
    this.speedLevel = clampSpeedLevel(options.speedLevel ?? SHIP_DEFAULT_SPEED_LEVEL, SHIP_DEFAULT_SPEED_LEVEL);
    this.travel = createEngineTravel({ ...options, tripSeed, speedLevel: this.speedLevel });
    this.scene.add(this.farStarfield.mesh, this.galaxies.mesh, this.starfield.mesh);
    // Planets bake their surfaces (PlanetBake.ts) where the GPU can render to half-float textures
    // (the relief map); elsewhere they are drawn procedurally, as before.
    const extensions = this.renderer.extensions;
    const canBake = extensions.has('EXT_color_buffer_float') || extensions.has('EXT_color_buffer_half_float');
    // Each new encounter object's shaders compile (in parallel where supported) before it is first drawn.
    this.encounterView = new EncounterView(
      this.scene,
      (object) => this.renderer.compileAsync(object, this.camera, this.scene),
      { bakePlanets: canBake },
    );
    // Compile the planet and nebula programs once, now, and keep them, so no encounter compiles any.
    // Asteroid rocks and comet nuclei draw with the rocky planet surface program, and a comet's coma
    // and tails with the planets' halo program, so they need no holder of their own; their CPU-side
    // building blocks are made now too, so the first asteroid's or comet's frame does not.
    this.programWarmup = new ProgramWarmup([...planetProgramMaterials(), ...nebulaProgramMaterials()]);
    this.bakeWarmup = canBake ? new ProgramWarmup(planetBakeProgramMaterials()) : null;
    this.planetBaker = canBake ? new PlanetBaker(this.renderer) : null;
    this.warmUp();
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
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
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.drawnPlanet = null;
    this.encounterView.dispose();
    this.programWarmup.dispose();
    this.bakeWarmup?.dispose();
    this.planetBaker?.dispose();
    this.scene.remove(this.starfield.mesh, this.farStarfield.mesh, this.galaxies.mesh);
    this.starfield.dispose();
    this.farStarfield.dispose();
    this.galaxies.dispose();
    this.gpuTimer?.dispose();
    this.gpuTimer = null;
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
    this.frameCap.reset();
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

  /** The frame-rate cap in use, in frames per second (0: none). */
  getFrameRateCap(): number {
    return this.frameCap.fps;
  }

  /** Number of frames the loop has drawn (display frames skipped by the frame-rate cap are not counted). */
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
   * Recent frames' GPU times in milliseconds (the bake slice, if any, and the render), a rolling
   * window, or `null` when GPU timing is off (`EngineOptions.gpuTiming`) or the browser has no
   * `EXT_disjoint_timer_query_webgl2` (read-only view; do not record into it). Each result arrives a
   * few frames after its frame.
   */
  getGpuFrameTimes(): Readonly<FrameStats> | null {
    return this.gpuTimer?.supported === true ? this.gpuFrames : null;
  }

  /** Whether GPU timing was asked for (`EngineOptions.gpuTiming`), whether or not the browser supports it. */
  isGpuTimingOn(): boolean {
    return this.gpuTimer !== null;
  }

  /** The drawing buffer's size in device pixels (the CSS size times the applied DPR). */
  getDrawingBufferSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  /** The scene (read-only view; do not modify): the star layers, the galaxies and the encounter object. */
  getScene(): Scene {
    return this.scene;
  }

  /**
   * The latest frame's interval since the frame before it, in milliseconds, or NaN when it had none
   * (the first frame after a start, resume or the tab becoming visible again).
   */
  getLastFrameInterval(): number {
    return this.clock.lastIntervalMs;
  }

  /** Whether planets bake their surfaces here (the GPU can render to half-float textures). */
  isPlanetBakeOn(): boolean {
    return this.planetBaker !== null;
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
    // Under the frame-rate cap this display frame may be skipped: nothing runs, and the next drawn
    // frame steps the simulation by the whole time since the last drawn one.
    if (!this.frameCap.due(now)) return;
    this.gpuTimer?.poll(this.recordGpuTime);
    const dt = this.clock.tick(now);
    this.frameIntervals.record(this.clock.lastIntervalMs);
    const workStart = performance.now();
    stepTravel(this.travel, dt);
    this.encounterView.sync(this.travel.autopilot);
    this.frameCount++;
    this.render(true);
    this.frameWork.record(performance.now() - workStart);
  };

  private readonly recordGpuTime = (ms: number): void => {
    this.gpuFrames.record(ms);
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
      this.frameCap.reset();
    }
  };

  /** Draws the scene; with `bake` (the frame loop's frames), a slice of the planet's surface bake first. */
  private render(bake = false): void {
    const { ship, autopilot, autopilotParams } = this.travel;
    this.applyHeading();
    this.starfield.update(ship);
    const kind = autopilot.encounter?.kind ?? 'planet';
    this.encounterView.place(autopilot, ship, encounterProfile(autopilotParams, kind));
    this.gpuTimer?.begin();
    // Only once the bake programs are compiled, so a bake never compiles anything, and from the frame
    // after the one that first draws the planet, so neither the frame that creates it nor the one
    // that first draws it does more than before (the first slice also allocates the cube maps).
    const planet = this.encounterView.getPlanet();
    if (bake && this.planetBaker !== null && this.bakeWarmup?.isReady() === true) {
      this.planetBaker.step(planet !== null && planet === this.drawnPlanet ? planet : null);
    }
    this.renderer.render(this.scene, this.camera);
    this.gpuTimer?.end();
    if (bake) this.drawnPlanet = planet !== null && planet.object.visible ? planet : null;
  }

  /**
   * Compiles the warm-ups' programs (at start-up, and again after a context restore): the screen
   * programs first, then, once they have settled, the bake programs and the cube-map stand-in, so
   * the two sets' first-use waits (where `KHR_parallel_shader_compile` is missing, a link each) fall
   * in separate tasks rather than all before the first frame. The bake starts only once its
   * programs are ready (`render`), so it never compiles anything.
   */
  private warmUp(): void {
    const bakeWarmup = this.bakeWarmup;
    // Not ready until compiled again (after a restore), even while the screen programs compile.
    bakeWarmup?.invalidate();
    const generation = ++this.warmupGeneration;
    const screen = this.programWarmup.compile(this.renderer, this.camera, this.scene);
    if (bakeWarmup === null) return;
    void screen.then(() => {
      if (this.disposed || generation !== this.warmupGeneration || this.renderer.getContext().isContextLost()) return;
      // The bake programs draw into a render target, so they are compiled with one bound (a 1×1
      // stand-in, freed as soon as the compile has started).
      const stand = new WebGLRenderTarget(1, 1, { depthBuffer: false });
      void bakeWarmup.compile(this.renderer, this.camera, this.scene, stand);
      stand.dispose();
      // Make a one-texel stand-in of a rocky planet's cube maps, now: Three.js' first cube map of
      // each kind queries the GPU (its anisotropy limit, among others) with calls that wait for it
      // to finish everything queued, which in an encounter's first bake slice stalled the frame.
      const probe = new SurfaceBake('rocky', {}, 1);
      for (const target of probe.targets) this.renderer.initRenderTarget(target);
      probe.dispose();
    });
  }

  /**
   * After a WebGL context loss and restore, Three.js rebuilds its renderer state from scratch, and
   * with it every shader program, and a render target's contents are gone: the warm-ups compile
   * again (so neither the restarted bake nor the next encounter compiles mid-encounter), and the
   * current planet goes back to its procedural surface and bakes again once the bake programs are
   * ready. The GPU timer's queries died with the context: they are dropped, not deleted (they
   * belong to the lost context).
   */
  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    this.warmUp();
    this.encounterView.getPlanet()?.restartBake();
    this.planetBaker?.contextRestored();
    if (this.gpuTimer !== null) {
      this.gpuTimer.abandon();
      this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext);
    }
  };

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

/**
 * The ship, autopilot and their params the engine travels with for `options` (its trip seed, speed
 * level, encounter interval, kind and arrival speed), with the engine's seeded
 * planets, nebulae, asteroids and comets. Shared with the e2e GPU benchmark (src/e2eGpuBench.ts), so
 * it flies exactly the engine's encounters.
 */
export function createEngineTravel(options: Readonly<EngineOptions> = {}): Travel {
  const tripSeed = options.tripSeed === undefined ? ENCOUNTER_BASE_SEED : options.tripSeed >>> 0;
  const speedLevel = clampSpeedLevel(options.speedLevel ?? SHIP_DEFAULT_SPEED_LEVEL, SHIP_DEFAULT_SPEED_LEVEL);
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
  setCruiseSpeed(autopilotParams, SHIP_SPEED_LEVELS[speedLevel] ?? 0);
  return createTravel(autopilotParams, DEFAULT_SHIP_PARAMS);
}
