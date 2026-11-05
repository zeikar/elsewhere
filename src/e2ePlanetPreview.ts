/**
 * E2E-only encounter preview, used through the test hook (src/e2eHook.ts) and absent from the
 * production build. The engine draws encounter objects wherever the encounter puts them; this
 * instead draws one chosen planet or nebula, framed the same every time, on its own full-viewport
 * canvas (`#planet-preview`) laid over the scene, with its own renderer and a camera at the origin
 * looking down -Z, like the engine's. It is drawn once at a fixed time so screenshots are repeatable.
 *
 * - A planet sits at a fixed position relative to the camera, scaled by its radius so every planet
 *   is framed the same. On request the far-star layer (FarStarfield, the engine's own) is drawn
 *   behind it, with the engine's render order, so a test can check that the planet hides the far
 *   stars behind its disc.
 * - A nebula is seen as in its encounter, mid-APPROACH: planned along -Z on its seeded side of the
 *   path (`encounterSide`), with the camera NEBULA_PREVIEW_REMAINING short of the closest approach,
 *   fully faded in.
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, WebGLRenderer } from 'three';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  CLEAR_COLOR,
  DPR_CAP,
  ENCOUNTER_BASE_SEED,
  NEBULA_ENCOUNTER_DISTANCE,
  NEBULA_SIDE_OFFSET_FACTOR,
} from './config';
import { encounterSide, type EncounterKind, type EncounterSide } from './engine/Autopilot';
import { encounterOffset, planEncounter } from './engine/encounter';
import { FarStarfield } from './engine/FarStarfield';
import { Nebula, nebulaParams } from './engine/Nebula';
import { Planet, planetParams, type PlanetType } from './engine/Planet';
import { computeRenderSize } from './engine/renderSize';
import { hash } from './engine/seed';

/** Planet centre relative to the camera, in planet radii: straight ahead, slightly right. */
const PREVIEW_OFFSET_RADII = { x: 0.15, y: 0, z: -3.4 } as const;

/** Rotation time the preview is drawn at, in seconds. */
const PREVIEW_TIME = 0;

/** Encounter indices searched for a seed of the requested type. */
const MAX_SEARCH = 1000;

/** Remaining distance to the closest approach the nebula preview is seen from (fully faded in). */
const NEBULA_PREVIEW_REMAINING = 1100;

export interface PlanetPreviewInfo {
  /** Encounter index whose appearance seed was used. */
  index: number;
  seed: number;
  type: PlanetType;
  family: string;
  radius: number;
  /** Compiled shader programs in the preview renderer. */
  programs: number;
  /** The planet's disc on the canvas, in CSS pixels from the top-left corner (approximately a circle). */
  disc: { x: number; y: number; radius: number };
  /**
   * With the far stars drawn: how many far stars lie behind the inner 80% of the disc's radius
   * (their direction within 0.8 × the disc's angular radius of its centre). `null` without them.
   */
  farStarsBehindDisc: number | null;
}

export interface PlanetPreviewOptions {
  /** Draw the far-star layer behind the planet. Default: false. */
  farStars?: boolean;
}

export interface EncounterPreviewInfo {
  kind: EncounterKind;
  seed: number;
  family: string;
  /** Planet type, or `null` for a nebula. */
  type: PlanetType | null;
  radius: number;
  /** Side of the path the object sits on in its encounter. */
  side: EncounterSide;
  /** Compiled shader programs in the preview renderer. */
  programs: number;
}

let canvas: HTMLCanvasElement | null = null;
let renderer: WebGLRenderer | null = null;
let shown: Planet | Nebula | null = null;
let farStars: FarStarfield | null = null;
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

/** Creates the canvas and renderer on first use and sizes them and the camera to the viewport. */
function prepare(): { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera } {
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
  shown?.dispose();
  shown = null;
  if (farStars !== null) scene.remove(farStars.mesh);
  return { renderer, scene, camera };
}

/** Adds the far-star layer to the preview scene, sized for the preview canvas. */
function addFarStars(s: Scene): FarStarfield {
  farStars ??= new FarStarfield();
  farStars.setRenderSize(computeRenderSize(window.innerWidth, window.innerHeight, window.devicePixelRatio, DPR_CAP));
  s.add(farStars.mesh);
  return farStars;
}

/** Number of far stars whose direction is within `angle` (radians) of the unit direction `centre`. */
function farStarsWithin(stars: FarStarfield, centre: { x: number; y: number; z: number }, angle: number): number {
  const directions = stars.mesh.geometry.getAttribute('aDirection');
  const cos = Math.cos(angle);
  let count = 0;
  for (let i = 0; i < directions.count; i++) {
    const dot = directions.getX(i) * centre.x + directions.getY(i) * centre.y + directions.getZ(i) * centre.z;
    if (dot > cos) count++;
  }
  return count;
}

/**
 * Draws the planet for appearance seed `seed`, framed by its radius, replacing anything shown, with
 * the far stars behind it when asked for.
 */
function drawPlanet(
  seed: number,
  options: Readonly<PlanetPreviewOptions> = {},
): { planet: Planet; disc: PlanetPreviewInfo['disc']; farStarsBehindDisc: number | null } {
  const { renderer: r, scene: s, camera: c } = prepare();
  const params = planetParams(seed);
  const planet = new Planet(params);
  shown = planet;
  const radius = params.radius;
  planet.object.position.set(PREVIEW_OFFSET_RADII.x * radius, PREVIEW_OFFSET_RADII.y * radius, PREVIEW_OFFSET_RADII.z * radius);
  planet.update(PREVIEW_TIME);
  s.add(planet.object);
  const stars = options.farStars === true ? addFarStars(s) : null;
  r.render(s, c);

  // The disc: centre projected, radius from the angular radius (the camera looks down -Z unrotated).
  const p = planet.object.position;
  const distance = p.length();
  const angularRadius = Math.asin(Math.min(1, planet.object.scale.x / distance));
  const centre = p.clone().project(c);
  const halfHeight = window.innerHeight / 2;
  const focal = halfHeight / Math.tan(((c.fov / 2) * Math.PI) / 180);
  const disc = {
    x: (centre.x + 1) * (window.innerWidth / 2),
    y: (1 - centre.y) * halfHeight,
    radius: Math.tan(angularRadius) * focal,
  };
  const farStarsBehindDisc =
    stars === null ? null : farStarsWithin(stars, { x: p.x / distance, y: p.y / distance, z: p.z / distance }, 0.8 * angularRadius);
  return { planet, disc, farStarsBehindDisc };
}

/** Draws the nebula for appearance seed `seed` as seen mid-APPROACH, replacing anything shown. */
function drawNebula(seed: number): Nebula {
  const { renderer: r, scene: s, camera: c } = prepare();
  const params = nebulaParams(seed);
  const origin = { x: 0, y: 0, z: 0 };
  const plan = planEncounter(
    origin,
    { x: 0, y: 0, z: -1 },
    params.radius,
    NEBULA_ENCOUNTER_DISTANCE,
    NEBULA_SIDE_OFFSET_FACTOR,
    encounterSide(seed).sideAngle,
  );
  const ship = { x: 0, y: 0, z: -(NEBULA_ENCOUNTER_DISTANCE - NEBULA_PREVIEW_REMAINING) };
  const nebula = new Nebula(params, plan);
  shown = nebula;
  encounterOffset(plan, ship, nebula.object.position);
  nebula.setFade(1);
  nebula.update(PREVIEW_TIME);
  s.add(nebula.object);
  r.render(s, c);
  return nebula;
}

/**
 * Shows the `nth` (default: the first) encounter planet of `type`, replacing anything shown, and
 * draws it once, with the far stars behind it when `options.farStars` is set.
 */
export function showPlanetPreview(type: PlanetType, nth = 0, options: Readonly<PlanetPreviewOptions> = {}): PlanetPreviewInfo {
  const { index, seed } = findSeed(type, Math.max(0, Math.floor(nth)));
  const { planet, disc, farStarsBehindDisc } = drawPlanet(seed, options);
  const { params } = planet;
  return {
    index,
    seed,
    type: params.type,
    family: params.family,
    radius: params.radius,
    programs: renderer?.info.programs?.length ?? 0,
    disc,
    farStarsBehindDisc,
  };
}

/**
 * Shows the planet or nebula for appearance seed `seed` (a uint32), whatever kind the schedule would
 * give it, replacing anything shown, and draws it once.
 */
export function showEncounterPreview(kind: EncounterKind, seed: number): EncounterPreviewInfo {
  const s = seed >>> 0;
  const side = encounterSide(s).side;
  if (kind === 'nebula') {
    const { params } = drawNebula(s);
    return { kind, seed: s, family: params.family, type: null, radius: params.radius, side, programs: renderer?.info.programs?.length ?? 0 };
  }
  const { params } = drawPlanet(s).planet;
  return { kind, seed: s, family: params.family, type: params.type, radius: params.radius, side, programs: renderer?.info.programs?.length ?? 0 };
}

/** Removes the preview canvas and frees what it shows and its renderer. */
export function hidePlanetPreview(): void {
  shown?.dispose();
  shown = null;
  if (farStars !== null) scene?.remove(farStars.mesh);
  farStars?.dispose();
  farStars = null;
  renderer?.dispose();
  renderer = null;
  canvas?.remove();
  canvas = null;
}
