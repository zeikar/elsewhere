/**
 * Engine: renderer, resize, frame loop, dt and visibility (docs/PLAN.md sections 6 and 8).
 *
 * The engine owns the frame loop and knows nothing about the DOM UI; the UI talks to it only through
 * the small public API below. The camera always sits at the origin and only takes the ship heading
 * (floating origin). Nothing is allocated inside the frame loop.
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
import { FrameClock } from './FrameClock';
import { computeRenderSize } from './renderSize';
import { DEFAULT_SHIP_PARAMS, createShipState, updateShip, type ShipParams, type ShipState } from './Ship';
import { DEFAULT_STARFIELD_OPTIONS, Starfield } from './Starfield';

export interface EngineOptions {
  /** Speed level travel starts at (index into SHIP_SPEED_LEVELS, clamped). Default: SHIP_DEFAULT_SPEED_LEVEL. */
  speedLevel?: number;
  /** Starfield streak time, in seconds. Default: STAR_STREAK_TIME_SECONDS. */
  streakTime?: number;
}

/** Called with the new paused state whenever pause() or resume() changes it. */
export type PausedChangeListener = (paused: boolean) => void;

export class Engine {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly clock = new FrameClock();
  private readonly ship: ShipState;
  private readonly shipParams: ShipParams;
  private readonly starfield: Starfield;
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
    this.shipParams = { ...DEFAULT_SHIP_PARAMS, targetSpeed: SHIP_SPEED_LEVELS[this.speedLevel] ?? 0 };
    this.ship = createShipState({}, this.shipParams);
    this.scene.add(this.starfield.mesh);
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

  /** Sets the speed level, an index into SHIP_SPEED_LEVELS (clamped); the ship eases toward it. */
  setSpeed(level: number): void {
    const clamped = clampSpeedLevel(level, this.speedLevel);
    this.speedLevel = clamped;
    this.shipParams.targetSpeed = SHIP_SPEED_LEVELS[clamped] ?? 0;
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

  /** Live ship state (read-only view; do not modify). */
  getShip(): Readonly<ShipState> {
    return this.ship;
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
    updateShip(this.ship, dt, this.shipParams, this.ship);
    this.frameCount++;
    this.render();
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
    this.applyHeading();
    this.starfield.update(this.ship);
    this.renderer.render(this.scene, this.camera);
  }

  /** Camera stays at the origin and looks along the ship heading. */
  private applyHeading(): void {
    const h = this.ship.heading;
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
