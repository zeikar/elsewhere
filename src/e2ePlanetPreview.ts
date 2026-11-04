/**
 * E2E-only planet preview, used through the test hook (src/e2eHook.ts) and absent from the
 * production build. The engine draws encounter planets wherever the encounter puts them; this
 * instead draws one chosen planet, framed the same every time, on its own full-viewport canvas laid
 * over the scene, with its own renderer and a camera at the origin looking down -Z, like the engine's. The planet sits at a fixed position relative to the
 * camera, scaled by its radius so every planet is framed the same, and is drawn once at a fixed
 * rotation time so screenshots are repeatable.
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, WebGLRenderer } from 'three';
import { CAMERA_FAR, CAMERA_FOV_DEG, CAMERA_NEAR, CLEAR_COLOR, DPR_CAP, ENCOUNTER_BASE_SEED } from './config';
import { Planet, planetParams, type PlanetType } from './engine/Planet';
import { hash } from './engine/seed';

/** Planet centre relative to the camera, in planet radii: straight ahead, slightly right. */
const PREVIEW_OFFSET_RADII = { x: 0.15, y: 0, z: -3.4 } as const;

/** Rotation time the preview is drawn at, in seconds. */
const PREVIEW_TIME = 0;

/** Encounter indices searched for a seed of the requested type. */
const MAX_SEARCH = 1000;

export interface PlanetPreviewInfo {
  /** Encounter index whose appearance seed was used. */
  index: number;
  seed: number;
  type: PlanetType;
  family: string;
  radius: number;
  /** Compiled shader programs in the preview renderer. */
  programs: number;
}

let canvas: HTMLCanvasElement | null = null;
let renderer: WebGLRenderer | null = null;
let planet: Planet | null = null;
// Created on first use, so merely importing this module has no side effects.
let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;

/** Encounter index (from 0) and seed of the `nth` (from 0) encounter planet of `type`. */
function findSeed(type: PlanetType, nth: number): { index: number; seed: number } {
  let found = 0;
  for (let index = 0; index < MAX_SEARCH; index++) {
    const seed = hash(ENCOUNTER_BASE_SEED, index);
    if (planetParams(seed).type === type && found++ === nth) return { index, seed };
  }
  throw new Error(`fewer than ${nth + 1} ${type} planets in the first ${MAX_SEARCH} encounters`);
}

/**
 * Shows the `nth` (default: the first) encounter planet of `type`, replacing any shown planet, and
 * draws it once.
 */
export function showPlanetPreview(type: PlanetType, nth = 0): PlanetPreviewInfo {
  if (canvas === null || renderer === null) {
    canvas = document.createElement('canvas');
    canvas.id = 'planet-preview';
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:1;';
    document.body.append(canvas);
    renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(CLEAR_COLOR, 1);
  }
  scene ??= new Scene();
  camera ??= new PerspectiveCamera(CAMERA_FOV_DEG, 1, CAMERA_NEAR, CAMERA_FAR);
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, DPR_CAP));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  planet?.dispose();
  const { index, seed } = findSeed(type, Math.max(0, Math.floor(nth)));
  const params = planetParams(seed);
  planet = new Planet(params);
  const r = params.radius;
  planet.object.position.set(PREVIEW_OFFSET_RADII.x * r, PREVIEW_OFFSET_RADII.y * r, PREVIEW_OFFSET_RADII.z * r);
  planet.update(PREVIEW_TIME);
  scene.add(planet.object);
  renderer.render(scene, camera);
  return {
    index,
    seed,
    type: params.type,
    family: params.family,
    radius: r,
    programs: renderer.info.programs?.length ?? 0,
  };
}

/** Removes the preview canvas and frees its planet and renderer. */
export function hidePlanetPreview(): void {
  planet?.dispose();
  planet = null;
  renderer?.dispose();
  renderer = null;
  canvas?.remove();
  canvas = null;
}
