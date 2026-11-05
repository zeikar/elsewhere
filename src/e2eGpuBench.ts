/**
 * E2E-only GPU benchmark (issue #65), used through the test hook (src/e2eHook.ts) and absent from
 * the production build: the GPU cost of one frame of cruise or of an encounter at a chosen moment,
 * at the page's viewport and pixel ratio.
 *
 * A software renderer cannot fly a whole encounter at 3024×1964 in reasonable time, so this flies it
 * without drawing: it builds the engine's own travel (`createEngineTravel`, the same trip seed, kind
 * and speed level) and the engine's scene (the far stars, the galaxies, the near starfield and an
 * `EncounterView`), steps the simulation at 60 Hz exactly as `Engine.frame` does, and draws only the
 * frame it measures, on its own full-viewport canvas (`#gpu-bench`) with a renderer set up as the
 * engine's. `at: 'peak'` picks the moment of the encounter whose estimated GPU work
 * (src/e2eGpuCost.ts) is largest, sampled every quarter second of travel: for a planet, when it is
 * biggest on screen, near its closest approach.
 *
 * The frame is drawn `frames` times. Where `EXT_disjoint_timer_query_webgl2` is there (SwiftShader
 * has it), each draw is timed on the GPU (GpuTimer.ts); each draw is also timed on the wall clock up
 * to a one-pixel read-back, which waits for the GPU. Both are reported with the cost estimate.
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  CLEAR_COLOR,
  DPR_CAP,
  ENCOUNTER_BASE_SEED,
  VIEW_WIDEST_ASPECT,
} from './config';
import { encounterProfile, stepTravel, type EncounterKind, type TravelState } from './engine/Autopilot';
import { createEngineTravel } from './engine/Engine';
import { EncounterView } from './engine/EncounterView';
import { FarStarfield } from './engine/FarStarfield';
import { Galaxies, generateGalaxies } from './engine/Galaxies';
import { GpuTimer } from './engine/GpuTimer';
import { PlanetBaker } from './engine/PlanetBake';
import { cameraFovDeg, cameraFrustum, computeRenderSize } from './engine/renderSize';
import { DEFAULT_STARFIELD_OPTIONS, Starfield } from './engine/Starfield';
import { estimateFrameCost, shaderKind, type FrameCostEstimate, type ShaderKind } from './e2eGpuCost';

export interface GpuBenchRequest {
  /** `'cruise'` (no encounter), or the kind of encounter to fly (every encounter that kind). */
  scene: 'cruise' | EncounterKind;
  /** Trip seed. Default: ENCOUNTER_BASE_SEED. */
  tripSeed?: number;
  /** Speed level. Default: the engine's default. */
  speedLevel?: number;
  /**
   * When, in the first encounter, to measure: `'peak'` (its largest estimated GPU work) or seconds
   * since its object was created. Cruise is measured 10 s after the start. Default: `'peak'`.
   */
  at?: 'peak' | number;
  /** Draws timed. Default: 8. */
  frames?: number;
  /** Shaders whose meshes are hidden while timing, to measure what they add (e.g. `['atmosphere']`). */
  without?: ShaderKind[];
  /**
   * A planet's surface as the engine draws it once its bake is done (`'baked'`, the default) or as
   * it is drawn before (`'procedural'`, and as it always was before issue #65).
   */
  surface?: 'baked' | 'procedural';
}

export interface GpuBenchTimes {
  /** Per draw, in ms. */
  median: number;
  min: number;
  max: number;
  n: number;
}

export interface GpuBenchResult {
  /** Drawing buffer, in device pixels, and the pixel ratio applied. */
  width: number;
  height: number;
  dpr: number;
  /** Whether the GPU timer (`EXT_disjoint_timer_query_webgl2`) was there. */
  timer: boolean;
  /** GPU time per draw, from the timer, or `null` without it. */
  gpuMs: GpuBenchTimes | null;
  /** Wall time per draw up to a one-pixel read-back (which waits for the GPU). */
  wallMs: GpuBenchTimes;
  estimate: FrameCostEstimate;
  /**
   * For a baked planet: the GPU time of each of its first bake slices (one frame's share of the
   * bake, PLANET_BAKE_ROWS_PER_FRAME rows; the first also allocates the cube maps), in ms, and the
   * whole bake's, from the timer; `null` otherwise.
   */
  bake: { slicesMs: number[]; totalMs: number | null; bytes: number } | null;
  /** The measured moment. */
  state: {
    travel: TravelState;
    /** Seconds since the encounter object was created (0 at cruise). */
    encounterTime: number;
    remaining: number | null;
    kind: EncounterKind | null;
    seed: number | null;
    family: string | null;
    /** Planet type and ring, or `null` for other kinds. */
    planetType: string | null;
    ringed: boolean | null;
    /** Angular diameter of the encounter object's bounding sphere (a planet's disc), in degrees. */
    angularDiameterDeg: number | null;
    visible: boolean;
  };
  /** Compiled programs in the benchmark renderer. */
  programs: number;
}

const STEP = 1 / 60;
/** Steps between samples of the estimate while looking for the peak (a quarter second). */
const SAMPLE_STEPS = 15;
/** Longest flight searched, in simulated seconds. */
const MAX_SECONDS = 900;

let canvas: HTMLCanvasElement | null = null;
let renderer: WebGLRenderer | null = null;

function prepareRenderer(width: number, height: number, dpr: number): WebGLRenderer {
  if (canvas === null || renderer === null) {
    canvas = document.createElement('canvas');
    canvas.id = 'gpu-bench';
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2;';
    document.body.append(canvas);
    // As the engine's (Engine.ts).
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(CLEAR_COLOR, 1);
  }
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  return renderer;
}

/** The engine's scene and travel for `request`, built afresh. */
function build(request: Readonly<GpuBenchRequest>, aspect: number) {
  const tripSeed = (request.tripSeed ?? ENCOUNTER_BASE_SEED) >>> 0;
  const travel = createEngineTravel({
    tripSeed,
    ...(request.speedLevel === undefined ? {} : { speedLevel: request.speedLevel }),
    ...(request.scene === 'cruise' ? { encounterInterval: 1e9 } : { encounterKind: request.scene, encounterInterval: 1 }),
  });
  travel.autopilotParams.view = cameraFrustum(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT);
  const scene = new Scene();
  const farStars = new FarStarfield();
  const galaxies = new Galaxies(generateGalaxies(tripSeed));
  const starfield = new Starfield(DEFAULT_STARFIELD_OPTIONS);
  scene.add(farStars.mesh, galaxies.mesh, starfield.mesh);
  const view = new EncounterView(scene, null, { bakePlanets: request.surface !== 'procedural' });
  const camera = new PerspectiveCamera(cameraFovDeg(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT), aspect, CAMERA_NEAR, CAMERA_FAR);
  const look = new Vector3();
  let created = -1;
  let steps = 0;
  /** One engine frame: the simulation step, the encounter sync, and the placement before the render. */
  const step = (): void => {
    stepTravel(travel, STEP);
    view.sync(travel.autopilot);
    if (view.getObject() !== null && created < 0) created = steps;
    steps++;
  };
  const place = (): void => {
    const h = travel.ship.heading;
    camera.lookAt(look.set(h.x, h.y, h.z));
    camera.updateMatrixWorld();
    starfield.update(travel.ship);
    const kind = travel.autopilot.encounter?.kind ?? 'planet';
    view.place(travel.autopilot, travel.ship, encounterProfile(travel.autopilotParams, kind));
  };
  const dispose = (): void => {
    view.dispose();
    scene.remove(farStars.mesh, galaxies.mesh, starfield.mesh);
    farStars.dispose();
    galaxies.dispose();
    starfield.dispose();
  };
  return {
    travel,
    scene,
    view,
    camera,
    farStars,
    starfield,
    step,
    place,
    dispose,
    encounterSeconds: () => (created < 0 ? 0 : (steps - created) * STEP),
    steps: () => steps,
  };
}

function times(values: readonly number[]): GpuBenchTimes {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN, min: sorted[0] ?? Number.NaN, max: sorted[sorted.length - 1] ?? Number.NaN, n: sorted.length };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Runs the benchmark for `request` (see the module comment). */
export async function runGpuBench(request: Readonly<GpuBenchRequest>): Promise<GpuBenchResult> {
  const size = computeRenderSize(window.innerWidth, window.innerHeight, window.devicePixelRatio, DPR_CAP);
  const aspect = size.cssWidth / size.cssHeight;
  const r = prepareRenderer(size.cssWidth, size.cssHeight, size.dpr);
  const width = r.domElement.width;
  const height = r.domElement.height;
  const estimate = (b: ReturnType<typeof build>) => estimateFrameCost(b.scene, b.camera, width, height, size.dpr);

  // Find the step to measure at.
  let target: number;
  const at = request.at ?? 'peak';
  if (request.scene === 'cruise') {
    target = 600;
  } else {
    const probe = build(request, aspect);
    let best = -1;
    let bestWork = -1;
    target = -1;
    for (let i = 0; i < MAX_SECONDS / STEP; i++) {
      probe.step();
      const a = probe.travel.autopilot;
      if (a.encounterCount >= 1 && a.encounter === null) break;
      if (probe.view.getObject() === null) continue;
      if (typeof at === 'number') {
        if (probe.encounterSeconds() >= at) {
          target = probe.steps();
          break;
        }
        continue;
      }
      if (i % SAMPLE_STEPS !== 0) continue;
      probe.place();
      if (probe.view.getObject()?.object.visible !== true) continue;
      const work = estimate(probe).mops;
      if (work > bestWork) {
        bestWork = work;
        best = probe.steps();
      }
    }
    probe.dispose();
    if (typeof at !== 'number') target = best;
    if (target < 0) throw new Error(`no ${request.scene} encounter to measure`);
  }

  // Fly to it again and draw it.
  const b = build(request, aspect);
  for (let i = 0; i < target; i++) b.step();
  b.place();
  b.starfield.setRenderSize(size);
  b.farStars.setRenderSize(size);
  const gl = r.getContext() as WebGL2RenderingContext;
  const timer = new GpuTimer(gl);
  // A planet's bake, done long before the measured moment: time its first slices, then the rest,
  // with a timer of its own, so a late bake result never lands among the frame times.
  let bake: GpuBenchResult['bake'] = null;
  const planet = b.view.getPlanet();
  if (planet?.bake != null) {
    const bakeTimer = new GpuTimer(gl);
    const baker = new PlanetBaker(r);
    const slices: number[] = [];
    let total = 0;
    let timed = 0;
    let frames = 0;
    while (!planet.bake.done) {
      bakeTimer.begin();
      baker.step(planet);
      bakeTimer.end();
      frames++;
      // One slice a frame, as in the engine.
      await nextFrame();
      bakeTimer.poll((ms) => {
        if (slices.length < 3) slices.push(ms);
        total += ms;
        timed++;
      });
    }
    for (let i = 0; i < 60 && timed < frames; i++) {
      await nextFrame();
      bakeTimer.poll((ms) => {
        total += ms;
        timed++;
      });
    }
    baker.dispose();
    bakeTimer.dispose();
    bake = { slicesMs: slices, totalMs: timed === frames ? total : null, bytes: planet.bake.bytes };
  }
  const hidden: { visible: boolean }[] = [];
  if (request.without !== undefined && request.without.length > 0) {
    b.scene.traverse((o) => {
      const mesh = o as { isMesh?: boolean; visible: boolean };
      if (mesh.isMesh === true && o.visible && request.without!.includes(shaderKind(o as never))) {
        o.visible = false;
        hidden.push(o);
      }
    });
  }
  const cost = estimate(b);
  const pixel = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  // Compile and warm up.
  for (let i = 0; i < 2; i++) {
    r.render(b.scene, b.camera);
    sync();
  }
  const gpu: number[] = [];
  const wall: number[] = [];
  const frames = Math.max(1, Math.floor(request.frames ?? 8));
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    timer.begin();
    r.render(b.scene, b.camera);
    timer.end();
    sync();
    wall.push(performance.now() - t0);
    // Query results become available only once control returns to the browser.
    await nextFrame();
    timer.poll((ms) => gpu.push(ms));
  }
  for (let i = 0; i < 60 && timer.supported && gpu.length < frames; i++) {
    await nextFrame();
    timer.poll((ms) => gpu.push(ms));
  }
  timer.dispose();

  const a = b.travel.autopilot;
  const object = b.view.getObject();
  let angular: number | null = null;
  if (object !== null) {
    const position = object.object.position;
    const radius = a.encounter?.plan.radius ?? 0;
    const extent = planet !== null ? object.object.scale.x : radius;
    angular = (2 * Math.asin(Math.min(1, extent / Math.max(position.length(), 1e-9))) * 180) / Math.PI;
  }
  const result: GpuBenchResult = {
    width,
    height,
    dpr: size.dpr,
    timer: timer.supported,
    gpuMs: timer.supported && gpu.length > 0 ? times(gpu) : null,
    wallMs: times(wall),
    estimate: cost,
    bake,
    state: {
      travel: a.state,
      encounterTime: b.encounterSeconds(),
      remaining: Number.isFinite(a.remaining) ? a.remaining : null,
      kind: a.encounter?.kind ?? null,
      seed: a.encounter?.seed ?? null,
      family: planet?.params.family ?? b.view.getNebula()?.params.family ?? b.view.getAsteroid()?.params.family ?? b.view.getComet()?.params.family ?? null,
      planetType: planet?.params.type ?? null,
      ringed: planet === null ? null : planet.ring !== null,
      angularDiameterDeg: angular,
      visible: object?.object.visible ?? false,
    },
    programs: r.info.programs?.length ?? 0,
  };
  for (const o of hidden) o.visible = true;
  b.dispose();
  return result;
}

/** Removes the benchmark canvas and frees its renderer. */
export function disposeGpuBench(): void {
  renderer?.dispose();
  renderer = null;
  canvas?.remove();
  canvas = null;
}
