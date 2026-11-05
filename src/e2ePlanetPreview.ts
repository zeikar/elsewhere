/**
 * E2E-only encounter preview, used through the test hook (src/e2eHook.ts) and absent from the
 * production build. The engine draws encounter objects wherever the encounter puts them; this
 * instead draws one chosen planet, nebula or asteroid, framed the same every time, on its own full-viewport
 * canvas (`#planet-preview`) laid over the scene, with its own renderer and a camera at the origin
 * looking down -Z, like the engine's. It is drawn once at a fixed time so screenshots are repeatable.
 *
 * - A planet sits at a fixed position relative to the camera, scaled by its radius so every planet
 *   is framed the same (a ringed one further off, so its ring fits). On request the far-star layer
 *   (FarStarfield, the engine's own) is drawn behind it, with the engine's render order, so a test
 *   can check that the planet hides the far stars behind its disc. Likewise the galaxy layer
 *   (Galaxies, the engine's own), with the test default trip's first galaxy aimed once straight
 *   behind the disc and once beside it. A ringed planet is oriented as for an encounter planned
 *   along -Z with the planet to the right (DEFAULT_PLANET_FRAME).
 * - `checkRingDepth` draws a ringed planet with and without its ring and compares the pixels by
 *   where the ring lies (in front of the disc, behind it, or over the sky), found by ray casting.
 *   Drawn airless too, it measures the atmosphere's glow where the ring crosses the halo.
 * - A nebula is seen as in its encounter, mid-APPROACH: planned along -Z on its seeded side of the
 *   path (`encounterSide`), with the camera NEBULA_PREVIEW_REMAINING short of the closest approach,
 *   fully faded in.
 * - An asteroid (one rock or a field) is framed like a planet, by its bounding radius, with its rocks
 *   laid out as for an encounter planned along -Z with the field to the right (DEFAULT_PLANET_FRAME).
 */
import { PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
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
import { Asteroid, asteroidParams } from './engine/Asteroid';
import { encounterOffset, planEncounter } from './engine/encounter';
import { FarStarfield } from './engine/FarStarfield';
import { Galaxies, generateGalaxies, type Galaxy } from './engine/Galaxies';
import { Nebula, nebulaParams } from './engine/Nebula';
import { Planet, planetParams, ringAxis, DEFAULT_PLANET_FRAME, type PlanetType } from './engine/Planet';
import { computeRenderSize } from './engine/renderSize';
import { hash } from './engine/seed';

/**
 * Planet centre relative to the camera, in planet radii: straight ahead, slightly right. A ringed
 * planet is moved back by its extent over PREVIEW_RING_EXTENT, so its ring fits the view.
 */
const PREVIEW_OFFSET_RADII = { x: 0.15, y: 0, z: -3.4 } as const;
const PREVIEW_RING_EXTENT = 1.6;

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
  /**
   * With the galaxies drawn: where the two copies of the galaxy are centred on the canvas, in CSS
   * pixels from the top-left corner (one behind the disc's centre, one beside the disc), its
   * angular size in degrees, and the radius of its quad along the major axis in CSS pixels (at the
   * centre of the view; a little more off-centre). `null` without them.
   */
  galaxies: { behind: { x: number; y: number }; beside: { x: number; y: number }; sizeDeg: number; radius: number } | null;
}

export interface PlanetPreviewOptions {
  /** Draw the far-star layer behind the planet. Default: false. */
  farStars?: boolean;
  /** Draw a galaxy straight behind the planet's disc and one beside it, on the galaxy layer. Default: false. */
  galaxies?: boolean;
}

export interface EncounterPreviewInfo {
  kind: EncounterKind;
  seed: number;
  family: string;
  /** Planet type, or `null` for a nebula or an asteroid. */
  type: PlanetType | null;
  /** Radius: a planet's, a nebula's core radius, or an asteroid field's bounding radius. */
  radius: number;
  /** Rocks of an asteroid (1 for a single rock), or `null` for a planet or a nebula. */
  rocks: number | null;
  /** Side of the path the object sits on in its encounter. */
  side: EncounterSide;
  /** Compiled shader programs in the preview renderer. */
  programs: number;
}

let canvas: HTMLCanvasElement | null = null;
let renderer: WebGLRenderer | null = null;
let shown: Planet | Nebula | Asteroid | null = null;
let farStars: FarStarfield | null = null;
let galaxies: Galaxies | null = null;
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
  if (galaxies !== null) scene.remove(galaxies.mesh);
  galaxies?.dispose();
  galaxies = null;
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
): Pick<PlanetPreviewInfo, 'disc' | 'farStarsBehindDisc' | 'galaxies'> & { planet: Planet } {
  const { renderer: r, scene: s, camera: c } = prepare();
  const params = planetParams(seed);
  const planet = new Planet(params);
  shown = planet;
  const radius = params.radius;
  const back = params.ring === null ? 1 : Math.max(1, params.extent / PREVIEW_RING_EXTENT);
  planet.object.position.set(PREVIEW_OFFSET_RADII.x * radius, PREVIEW_OFFSET_RADII.y * radius, PREVIEW_OFFSET_RADII.z * radius * back);
  planet.update(PREVIEW_TIME);
  s.add(planet.object);
  const stars = options.farStars === true ? addFarStars(s) : null;
  const p = planet.object.position;
  const distance = p.length();
  const angularRadius = Math.asin(Math.min(1, planet.object.scale.x / distance));
  const toCss = (d: { x: number; y: number; z: number }) => {
    const ndc = c.position.clone().add(new Vector3(d.x, d.y, d.z)).project(c);
    return { x: (ndc.x + 1) * (window.innerWidth / 2), y: (1 - ndc.y) * (window.innerHeight / 2) };
  };
  let galaxyInfo: PlanetPreviewInfo['galaxies'] = null;
  if (options.galaxies === true) {
    // The test default trip's first galaxy, aimed at the disc's centre, and turned (about +Y) to
    // 2.1 angular radii left of it, well clear of the disc and its atmosphere glow.
    const template = generateGalaxies(ENCOUNTER_BASE_SEED)[0]!;
    const behind = { x: p.x / distance, y: p.y / distance, z: p.z / distance };
    const turn = 2.1 * angularRadius;
    const beside = {
      x: behind.x * Math.cos(turn) + behind.z * Math.sin(turn),
      y: behind.y,
      z: -behind.x * Math.sin(turn) + behind.z * Math.cos(turn),
    };
    const copies: Galaxy[] = [
      { ...template, direction: behind },
      { ...template, direction: beside },
    ];
    galaxies = new Galaxies(copies);
    s.add(galaxies.mesh);
    const focal = window.innerHeight / 2 / Math.tan(((c.fov / 2) * Math.PI) / 180);
    galaxyInfo = {
      behind: toCss(behind),
      beside: toCss(beside),
      sizeDeg: (template.size * 180) / Math.PI,
      radius: Math.tan(template.size / 2) * focal,
    };
  }
  r.render(s, c);

  // The disc: centre projected, radius from the angular radius (the camera looks down -Z unrotated).
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
  return { planet, disc, farStarsBehindDisc, galaxies: galaxyInfo };
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

/** Draws the asteroid for appearance seed `seed`, framed by its bounding radius, replacing anything shown. */
function drawAsteroid(seed: number): Asteroid {
  const { renderer: r, scene: s, camera: c } = prepare();
  const params = asteroidParams(seed);
  const asteroid = new Asteroid(params);
  shown = asteroid;
  const radius = params.radius;
  asteroid.object.position.set(PREVIEW_OFFSET_RADII.x * radius, PREVIEW_OFFSET_RADII.y * radius, PREVIEW_OFFSET_RADII.z * radius);
  asteroid.update(PREVIEW_TIME);
  s.add(asteroid.object);
  r.render(s, c);
  return asteroid;
}

/**
 * Shows the `nth` (default: the first) encounter planet of `type`, replacing anything shown, and
 * draws it once, with the far stars behind it when `options.farStars` is set.
 */
export function showPlanetPreview(type: PlanetType, nth = 0, options: Readonly<PlanetPreviewOptions> = {}): PlanetPreviewInfo {
  const { index, seed } = findSeed(type, Math.max(0, Math.floor(nth)));
  const { planet, disc, farStarsBehindDisc, galaxies: galaxyInfo } = drawPlanet(seed, options);
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
    galaxies: galaxyInfo,
  };
}

/**
 * Shows the planet, nebula or asteroid for appearance seed `seed` (a uint32), whatever kind the
 * schedule would give it, replacing anything shown, and draws it once.
 */
export function showEncounterPreview(kind: EncounterKind, seed: number): EncounterPreviewInfo {
  const s = seed >>> 0;
  const side = encounterSide(s).side;
  const programs = () => renderer?.info.programs?.length ?? 0;
  if (kind === 'nebula') {
    const { params } = drawNebula(s);
    return { kind, seed: s, family: params.family, type: null, radius: params.radius, rocks: null, side, programs: programs() };
  }
  if (kind === 'asteroid') {
    const { params } = drawAsteroid(s);
    return { kind, seed: s, family: params.family, type: null, radius: params.radius, rocks: params.rocks.length, side, programs: programs() };
  }
  const { params } = drawPlanet(s).planet;
  return { kind, seed: s, family: params.family, type: params.type, radius: params.radius, rocks: null, side, programs: programs() };
}

/** Per-class pixel differences between a ringed planet drawn with and without its ring (0–255 per channel). */
export interface RingDepthClass {
  /** Sampled pixels in the class. */
  n: number;
  /** Mean over those pixels of the largest channel difference. */
  meanDiff: number;
  /** Largest channel difference in the class. */
  maxDiff: number;
}

/**
 * The atmosphere's glow at pixels where the ring is seen through the halo, past the limb: each
 * pixel's drawing with the atmosphere less its drawing airless, summed over the three channels
 * (0–765). Only pixels whose glow without the ring is at least RING_HALO_MIN_GLOW are counted.
 */
export interface RingHaloClass {
  /** Pixels in the class. */
  n: number;
  /** Mean glow with the ring hidden. */
  glowWithout: number;
  /** Mean glow with the ring drawn. */
  glowWith: number;
  /** Pixels whose glow with the ring drawn is 0 or less. */
  zeroed: number;
}

/** Glow (summed over the three channels) a pixel needs, with the ring hidden, to count in a RingHaloClass. */
const RING_HALO_MIN_GLOW = 24;

export interface RingDepthInfo {
  seed: number;
  family: string;
  /**
   * Halo pixels where the ring is nearer than the planet, so in front of the glow: the glow must
   * show through the ring, dimmed by its opacity. Sampled at every pixel.
   */
  haloFront: RingHaloClass;
  /** Halo pixels where the ring is further than the planet, so behind the glow: the glow must show whole. */
  haloBehind: RingHaloClass;
  /** Pixels where the ring lies in front of the planet's disc: the ring must show. */
  frontOfDisc: RingDepthClass;
  /** Pixels where the ring lies behind the disc: the planet must hide it (no difference at all). */
  behindDisc: RingDepthClass;
  /** Pixels where the ring is seen against the sky: the ring must show. */
  overSky: RingDepthClass;
  /** Pixels on neither: nothing may change. */
  elsewhere: RingDepthClass;
}

/**
 * Draws the ringed planet for appearance seed `seed` as `showEncounter` frames it, once with its
 * ring and once with the ring hidden, and compares the two drawings pixel by pixel, sorted by what a
 * ray through each pixel meets first: the ring in front of the disc, the disc in front of the ring,
 * the ring alone, or neither. Pixels within two pixels of the disc's limb or the ring's edges (where
 * antialiasing blends classes) are left out. Both are drawn again airless (atmosphere intensity 0),
 * for the glow where the ring crosses the halo (`haloFront`, `haloBehind`). Leaves the planet shown, with its
 * ring and atmosphere.
 */
export function checkRingDepth(seed: number): RingDepthInfo {
  const s = seed >>> 0;
  const { planet } = drawPlanet(s);
  const ring = planet.ring;
  if (ring === null) throw new Error(`seed ${s}: no ring`);
  if (planet.atmosphere === null) throw new Error(`seed ${s}: no atmosphere`);
  // Airless: the atmosphere's intensity, which the ring's glow over its far side shares, at 0.
  const intensity = planet.uniforms.uAtmosphereIntensity;
  const lit = intensity.value;
  const { renderer: r, scene: sc, camera: c } = prepareKeep();
  const gl = r.getContext();
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const read = (): Uint8Array => {
    r.render(sc, c);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  const withRing = read();
  intensity.value = 0;
  const withRingAirless = read();
  ring.visible = false;
  const withoutAirless = read();
  intensity.value = lit;
  const without = read();
  ring.visible = true;
  r.render(sc, c);

  // Geometry, in the camera's frame (the camera sits at the origin, unrotated).
  planet.object.updateMatrixWorld(true);
  const centre = planet.object.position;
  const radius = planet.object.scale.x;
  const axis = ringAxis(planet.params.ring!, DEFAULT_PLANET_FRAME, { x: 0, y: 0, z: 0 });
  const inner = planet.params.ring!.inner * radius;
  const outer = planet.params.ring!.outer * radius;
  const shell = radius * (1 + planet.params.atmosphereThickness);
  const inverse = c.projectionMatrixInverse;
  const ray = new Vector3();
  /**
   * Set by `classify`, for a pixel where the ring is seen against the sky within the atmosphere
   * shell's outline: whether the ring is nearer than the planet (`front`) or further (`behind`).
   */
  const seen: { halo: 'front' | 'behind' | null } = { halo: null };
  /** What the ray through drawing-buffer pixel (px, py) (from the bottom left) meets first. */
  const classify = (px: number, py: number): 'frontOfDisc' | 'behindDisc' | 'overSky' | 'elsewhere' | 'edge' => {
    seen.halo = null;
    ray.set(((px + 0.5) / width) * 2 - 1, ((py + 0.5) / height) * 2 - 1, 0.5).applyMatrix4(inverse).normalize();
    // The sphere.
    const b = ray.dot(centre);
    const disc = b * b - (centre.lengthSq() - radius * radius);
    const sphereT = disc >= 0 ? b - Math.sqrt(disc) : Number.POSITIVE_INFINITY;
    // How far the ray passes inside the limb, in radii (negative outside).
    const limb = (radius - Math.sqrt(Math.max(0, centre.lengthSq() - b * b))) / radius;
    // The ring plane.
    const denom = ray.x * axis.x + ray.y * axis.y + ray.z * axis.z;
    const ringT = Math.abs(denom) < 1e-9 ? Number.NaN : (centre.x * axis.x + centre.y * axis.y + centre.z * axis.z) / denom;
    let ringR = Number.NaN;
    if (ringT > 0) ringR = Math.hypot(ray.x * ringT - centre.x, ray.y * ringT - centre.y, ray.z * ringT - centre.z);
    // Two pixels, in world units at the planet's distance.
    const pixel = (2 * centre.length() * 2 * Math.tan(((c.fov / 2) * Math.PI) / 180)) / height;
    if (Math.abs(limb * radius) < pixel) return 'edge';
    const onRing = ringR >= inner && ringR <= outer;
    if (Math.abs(ringR - inner) < pixel || Math.abs(ringR - outer) < pixel) return 'edge';
    if (!onRing) return 'elsewhere';
    if (!Number.isFinite(sphereT)) {
      if (centre.lengthSq() - b * b < shell * shell) seen.halo = ringT < b ? 'front' : 'behind';
      return 'overSky';
    }
    return ringT < sphereT ? 'frontOfDisc' : 'behindDisc';
  };
  const empty = (): RingDepthClass => ({ n: 0, meanDiff: 0, maxDiff: 0 });
  const emptyHalo = (): RingHaloClass => ({ n: 0, glowWithout: 0, glowWith: 0, zeroed: 0 });
  const info: RingDepthInfo = {
    seed: s,
    family: planet.params.family,
    haloFront: emptyHalo(),
    haloBehind: emptyHalo(),
    frontOfDisc: empty(),
    behindDisc: empty(),
    overSky: empty(),
    elsewhere: empty(),
  };
  const glow = (lit: Uint8Array, airless: Uint8Array, i: number): number =>
    lit[i]! - airless[i]! + (lit[i + 1]! - airless[i + 1]!) + (lit[i + 2]! - airless[i + 2]!);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const k = classify(px, py);
      if (k === 'edge') continue;
      const i = (py * width + px) * 4;
      const h = seen.halo;
      if (h !== null) {
        const glowWithout = glow(without, withoutAirless, i);
        if (glowWithout >= RING_HALO_MIN_GLOW) {
          const glowWith = glow(withRing, withRingAirless, i);
          const cls = h === 'front' ? info.haloFront : info.haloBehind;
          cls.n++;
          cls.glowWithout += glowWithout;
          cls.glowWith += glowWith;
          if (glowWith <= 0) cls.zeroed++;
        }
      }
      // The ring-depth classes keep to every third pixel either way.
      if (px % 3 !== 0 || py % 3 !== 0) continue;
      const diff = Math.max(
        Math.abs(withRing[i]! - without[i]!),
        Math.abs(withRing[i + 1]! - without[i + 1]!),
        Math.abs(withRing[i + 2]! - without[i + 2]!),
      );
      const cls = info[k];
      cls.n++;
      cls.meanDiff += diff;
      cls.maxDiff = Math.max(cls.maxDiff, diff);
    }
  }
  for (const cls of [info.frontOfDisc, info.behindDisc, info.overSky, info.elsewhere]) cls.meanDiff = cls.n > 0 ? cls.meanDiff / cls.n : 0;
  for (const cls of [info.haloFront, info.haloBehind]) {
    cls.glowWithout = cls.n > 0 ? cls.glowWithout / cls.n : 0;
    cls.glowWith = cls.n > 0 ? cls.glowWith / cls.n : 0;
  }
  return info;
}

/** The preview's renderer, scene and camera as they are, without clearing what is shown. */
function prepareKeep(): { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera } {
  if (renderer === null || scene === null || camera === null) throw new Error('no preview');
  return { renderer, scene, camera };
}

/** Removes the preview canvas and frees what it shows and its renderer. */
export function hidePlanetPreview(): void {
  shown?.dispose();
  shown = null;
  if (farStars !== null) scene?.remove(farStars.mesh);
  farStars?.dispose();
  farStars = null;
  if (galaxies !== null) scene?.remove(galaxies.mesh);
  galaxies?.dispose();
  galaxies = null;
  renderer?.dispose();
  renderer = null;
  canvas?.remove();
  canvas = null;
}
