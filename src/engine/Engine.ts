/**
 * Engine: renderer, resize, frame loop, dt and visibility (docs/PLAN.md sections 6 and 8).
 *
 * The engine owns the frame loop and knows nothing about the DOM UI; the UI talks to it only through
 * the small public API below. The camera always sits at the origin and only takes the ship heading
 * (floating origin). Nothing is allocated inside the frame loop.
 *
 * Each frame runs one simulation step (`stepTravel`: the ship, then the Autopilot, which sets the
 * ship's target speed and drift rate), then the encounter view creates or disposes the encounter
 * object, a planet or a nebula (compiling its shaders with `renderer.compileAsync` before it is first
 * drawn), and the render places it relative to the ship. The encounter shader programs themselves
 * are compiled once at construction and kept for the whole run (`ProgramWarmup`), so encounters
 * reuse them instead of compiling their own. The starfield keeps running underneath.
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
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_SPEED_LEVELS,
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
import { EncounterView } from './EncounterView';
import { FrameClock } from './FrameClock';
import { FrameStats } from './FrameStats';
import { nebulaParams, nebulaProgramMaterials, type Nebula } from './Nebula';
import { computeRenderSize } from './renderSize';
import { planetParams, planetProgramMaterials, type Planet } from './Planet';
import { ProgramWarmup } from './ProgramWarmup';
import { DEFAULT_SHIP_PARAMS, type ShipState } from './Ship';
import { DEFAULT_STARFIELD_OPTIONS, Starfield } from './Starfield';

export interface EngineOptions {
  /** Speed level travel starts at (index into SHIP_SPEED_LEVELS, clamped). Default: SHIP_DEFAULT_SPEED_LEVEL. */
  speedLevel?: number;
  /** Starfield streak time, in seconds. Default: STAR_STREAK_TIME_SECONDS. */
  streakTime?: number;
  /** Encounter interval: seconds of cruise before each encounter. Default: ENCOUNTER_INTERVAL_SECONDS. */
  encounterInterval?: number;
  /** Makes every encounter this kind (the seeded mix of planets and nebulae otherwise). */
  encounterKind?: EncounterKind;
}

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
      interval: interval !== undefined && interval >= 0 ? interval : DEFAULT_AUTOPILOT_PARAMS.interval,
      planetFor: planetParams,
      nebulaFor: nebulaParams,
      nebulaShare: kind === undefined ? DEFAULT_AUTOPILOT_PARAMS.nebulaShare : kind === 'nebula' ? 1 : 0,
    };
    setCruiseSpeed(autopilotParams, SHIP_SPEED_LEVELS[this.speedLevel] ?? 0);
    this.travel = createTravel(autopilotParams, DEFAULT_SHIP_PARAMS);
    this.scene.add(this.starfield.mesh);
    // Each new encounter object's shaders compile (in parallel where supported) before it is first drawn.
    this.encounterView = new EncounterView(this.scene, (object) =>
      this.renderer.compileAsync(object, this.camera, this.scene),
    );
    // Compile the planet and nebula programs once, now, and keep them, so no encounter compiles any.
    this.programWarmup = new ProgramWarmup([...planetProgramMaterials(), ...nebulaProgramMaterials()]);
    void this.programWarmup.compile(this.renderer, this.camera, this.scene);
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
    this.scene.remove(this.starfield.mesh);
    this.starfield.dispose();
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
   * it; the ship eases toward the new target from the next step.
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

  /** Whether the current encounter object, planet or nebula, is drawn; false with none. */
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

  /** Encounter interval in use, in seconds. */
  getEncounterInterval(): number {
    return this.travel.autopilotParams.interval;
  }

  /** The current encounter's planet, or `null` outside planet encounters (read-only view; do not modify). */
  getPlanet(): Planet | null {
    return this.encounterView.getPlanet();
  }

  /** The current encounter's nebula, or `null` outside nebula encounters (read-only view; do not modify). */
  getNebula(): Nebula | null {
    return this.encounterView.getNebula();
  }

  /** Number of objects in the scene besides the starfield: the encounter objects (planets or nebulae). */
  getPlanetCount(): number {
    let count = 0;
    for (const child of this.scene.children) if (child !== this.starfield.mesh) count++;
    return count;
  }

  /** The camera (read-only view; do not modify). */
  getCamera(): PerspectiveCamera {
    return this.camera;
  }

  getCameraAspect(): number {
    return this.camera.aspect;
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
    this.camera.updateProjectionMatrix();
    this.starfield.setRenderSize(size);
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
