/**
 * E2E-only GPU cost estimate (issue #65), for where `EXT_disjoint_timer_query_webgl2` is missing
 * (Safari, for one) and as a cross-check where it is there. Absent from the production build.
 *
 * Estimate = shaded fragments per frame × a per-shader cost:
 *
 * - Shaded fragments: each drawn mesh's screen coverage in device pixels, found by casting a grid of
 *   view rays (GRID_X × GRID_Y) against a simple stand-in for its shape: a sphere for the planet
 *   surface, a rock, a comet's glow (its bounding sphere, so an overestimate); an
 *   annulus for a ring; the atmosphere's rim, between just inside the limb and the shell's edge
 *   (since issue #65 it is drawn there only; before, its shell's front faces were shaded over the
 *   whole disc as well, which the sphere stand-in below counted);
 *   the inscribed disc of a nebula layer's square (the shader discards outside
 *   it). Overlapping meshes all count (overdraw). The star layers, a few pixels per star on screen,
 *   are a rough allowance (STAR_PIXELS).
 * - Per-shader cost: SHADER_COST_OPS, ALU operations per fragment counted roughly from the GLSL (a
 *   simplex noise evaluation is about 90 operations, its analytic gradient about 40 more, a texture
 *   fetch is counted as 20). Every frame also clears and resolves the multisampled drawing buffer,
 *   CLEAR_RESOLVE_OPS per device pixel.
 *
 * It is a model, not a measurement: it ignores bandwidth, early depth rejection, discards and the
 * GPU's own balance of ALU to texture units. Use it for relative comparisons only (cruise against an
 * encounter, before against after), and prefer the timer where there is one.
 */
import { Matrix4, Vector3, type Material, type Mesh, type Object3D, type PerspectiveCamera } from 'three';

/** What a drawn mesh's fragments cost, by the shader it draws with. */
export type ShaderKind =
  | 'rocky surface (procedural)'
  | 'gas surface (procedural)'
  | 'rocky surface (baked)'
  | 'gas surface (baked)'
  | 'atmosphere'
  | 'ring'
  | 'comet glow'
  | 'nebula layer'
  | 'stars'
  | 'other';

/** ALU operations per shaded fragment, roughly counted from each shader (see the module comment). */
export const SHADER_COST_OPS: Readonly<Record<ShaderKind, number>> = {
  // Domain warp (3 noise + gradient), 3 broad and 3–4 fine octaves with gradients, tone, grain and
  // ice noise, the 27-cell crater loop when the planet has craters, and the lighting.
  'rocky surface (procedural)': 2000,
  // 4–5 turbulence octaves, a streak noise, 3 fine streak octaves, the storm and band trigonometry.
  'gas surface (procedural)': 1000,
  // Two cube-map fetches (albedo and ice; relief and height), the sea mask from the height, lighting.
  'rocky surface (baked)': 110,
  // One cube-map fetch (albedo), lighting and limb darkening.
  'gas surface (baked)': 70,
  // The analytic rim glow along the view ray.
  atmosphere: 55,
  // Four 1D value noises, lighting, the planet's shadow, and the glow behind the far side.
  ring: 150,
  // The coma's or a tail's glow along the view ray.
  'comet glow': 100,
  // Warp (2 noise), 4–5 octaves, a ridge noise, colour and premultiplied blending.
  'nebula layer': 750,
  stars: 25,
  other: 50,
};

/** Operations per device pixel per frame for clearing and resolving the 4× multisampled drawing buffer. */
export const CLEAR_RESOLVE_OPS = 4;

/** Device pixels each on-screen star covers, at DPR 1 (streaks are longer; a rough allowance). */
const STAR_PIXELS = 9;

const GRID_X = 128;
const GRID_Y = 72;

export interface FrameCostEstimate {
  /** Device pixels in the drawing buffer. */
  pixels: number;
  /** Estimated shaded fragments per frame, by shader (device pixels, overdraw included). */
  fragments: Partial<Record<ShaderKind, number>>;
  /** All shaded fragments per frame. */
  totalFragments: number;
  /** Estimated work per frame, in millions of operations: fragments × SHADER_COST_OPS plus the clear and resolve. */
  mops: number;
}

/** The shader a mesh's material draws with, told apart by its uniforms and defines. */
export function shaderKind(mesh: Mesh): ShaderKind {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | (Material & { uniforms?: Record<string, { value: unknown }>; defines?: Record<string, unknown> })
    | undefined;
  if (material === undefined) return 'other';
  const uniforms = material.uniforms ?? {};
  const defines = material.defines ?? {};
  if ((mesh.geometry as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry === true) return 'stars';
  if (uniforms.uRing !== undefined) {
    const which = uniforms.uRing.value as number;
    return which > 1.5 ? 'comet glow' : which > 0.5 ? 'ring' : 'atmosphere';
  }
  if (uniforms.uLayerFade !== undefined) return 'nebula layer';
  const baked = defines.PLANET_BAKED !== undefined;
  if (defines.PLANET_GAS !== undefined) return baked ? 'gas surface (baked)' : 'gas surface (procedural)';
  if (baked) return 'rocky surface (baked)';
  if (uniforms.uWarp !== undefined) return 'rocky surface (procedural)';
  return 'other';
}

const rays = new Float32Array(GRID_X * GRID_Y * 3);
const v = new Vector3();
const centre = new Vector3();
const normal = new Vector3();
const inverse = new Matrix4();

/** Fills `rays` with unit view directions through the grid cells' centres (camera at its world position). */
function castGrid(camera: PerspectiveCamera): Vector3 {
  camera.updateMatrixWorld();
  const origin = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  inverse.copy(camera.projectionMatrixInverse);
  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      v.set(((gx + 0.5) / GRID_X) * 2 - 1, ((gy + 0.5) / GRID_Y) * 2 - 1, 0.5)
        .applyMatrix4(inverse)
        .applyMatrix4(camera.matrixWorld)
        .sub(origin)
        .normalize();
      const i = (gy * GRID_X + gx) * 3;
      rays[i] = v.x;
      rays[i + 1] = v.y;
      rays[i + 2] = v.z;
    }
  }
  return origin;
}

/** Grid rays (from `origin`) that hit the sphere at `c` of radius `r` in front of the camera. */
function sphereHits(origin: Vector3, c: Vector3, r: number): number {
  const ox = c.x - origin.x;
  const oy = c.y - origin.y;
  const oz = c.z - origin.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  let hits = 0;
  for (let i = 0; i < rays.length; i += 3) {
    const b = rays[i]! * ox + rays[i + 1]! * oy + rays[i + 2]! * oz;
    const disc = b * b - cc;
    if (disc < 0) continue;
    // In front of the camera (a ray from inside the sphere hits its far side, still in front).
    if (b + Math.sqrt(disc) > 0) hits++;
  }
  return hits;
}

/** Grid rays that hit the flat ring `inner`–`outer` from `c` in the plane with unit normal `n`, in front of the camera. */
function annulusHits(origin: Vector3, c: Vector3, n: Vector3, inner: number, outer: number): number {
  const ox = c.x - origin.x;
  const oy = c.y - origin.y;
  const oz = c.z - origin.z;
  const num = ox * n.x + oy * n.y + oz * n.z;
  let hits = 0;
  for (let i = 0; i < rays.length; i += 3) {
    const dx = rays[i]!;
    const dy = rays[i + 1]!;
    const dz = rays[i + 2]!;
    const denom = dx * n.x + dy * n.y + dz * n.z;
    if (Math.abs(denom) < 1e-9) continue;
    const t = num / denom;
    if (t <= 0) continue;
    const r = Math.hypot(dx * t - ox, dy * t - oy, dz * t - oz);
    if (r >= inner && r <= outer) hits++;
  }
  return hits;
}

/**
 * Estimates the GPU work of drawing `scene` from `camera` into a `width` × `height` drawing buffer
 * (device pixels) at pixel ratio `dpr`: see the module comment.
 */
export function estimateFrameCost(scene: Object3D, camera: PerspectiveCamera, width: number, height: number, dpr: number): FrameCostEstimate {
  const pixels = width * height;
  const perRay = pixels / (GRID_X * GRID_Y);
  const origin = castGrid(camera);
  const fragments: Partial<Record<ShaderKind, number>> = {};
  // Share of the sphere of directions the view covers, for the star allowance.
  const viewShare = Math.min(1, (4 * Math.tan(((camera.fov / 2) * Math.PI) / 180) ** 2 * camera.aspect) / (4 * Math.PI));
  scene.updateMatrixWorld();
  scene.traverseVisible((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh !== true) return;
    const kind = shaderKind(mesh);
    const geometry = mesh.geometry;
    let count: number;
    if (kind === 'stars') {
      const instances = (geometry as { instanceCount?: number }).instanceCount ?? 0;
      count = Math.min(pixels, (Number.isFinite(instances) ? instances : 0) * viewShare * STAR_PIXELS * dpr * dpr);
    } else {
      centre.setFromMatrixPosition(mesh.matrixWorld);
      const scale = mesh.matrixWorld.getMaxScaleOnAxis();
      const parameters = (geometry as { parameters?: Record<string, number> }).parameters ?? {};
      if (geometry.type === 'RingGeometry') {
        normal.set(0, 1, 0).transformDirection(mesh.matrixWorld);
        count = annulusHits(origin, centre, normal, (parameters.innerRadius ?? 0) * scale, (parameters.outerRadius ?? 1) * scale) * perRay;
      } else if (geometry.type === 'PlaneGeometry') {
        // A nebula layer: the unit square's inscribed disc (the shader discards outside it).
        normal.set(0, 0, 1).transformDirection(mesh.matrixWorld);
        count = annulusHits(origin, centre, normal, 0, 0.5 * (parameters.width ?? 1) * scale) * perRay;
      } else if (kind === 'atmosphere') {
        // The camera-facing annulus (Planet.ts, atmosphereGeometry): the rays past (just inside) the
        // limb and within the shell, which is `scale` across; the planet is 1 + thickness smaller.
        const material = mesh.material as unknown as { uniforms: { uThickness?: { value: number } } };
        const planet = scale / (1 + (material.uniforms.uThickness?.value ?? 0));
        count = Math.max(0, sphereHits(origin, centre, scale) - sphereHits(origin, centre, 0.98 * planet)) * perRay;
      } else {
        if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
        const sphere = geometry.boundingSphere!;
        v.copy(sphere.center).applyMatrix4(mesh.matrixWorld);
        count = sphereHits(origin, v, sphere.radius * scale) * perRay;
      }
    }
    if (count > 0) fragments[kind] = (fragments[kind] ?? 0) + count;
  });
  let totalFragments = 0;
  let ops = pixels * CLEAR_RESOLVE_OPS;
  for (const [kind, count] of Object.entries(fragments) as [ShaderKind, number][]) {
    totalFragments += count;
    ops += count * SHADER_COST_OPS[kind];
  }
  return { pixels, fragments, totalFragments, mops: ops / 1e6 };
}
