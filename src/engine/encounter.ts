/**
 * Encounter planning (docs/PLAN.md section 6, Planets): plan the path first, then place the planet
 * beside it, and derive the target speed, opacity and size scale from the distance along that path.
 *
 * Pure float64 maths on plain `Vec3`s, with no Three.js or DOM dependencies. The ship is assumed to
 * hold the planned heading for the encounter, so the closest approach is fixed when it is planned.
 *
 * Distances along the path are "remaining" distances: the signed distance from the ship to the point
 * of closest approach, measured along the planned direction. It is `D` when the encounter starts,
 * 0 at the closest approach and negative after passing.
 */
import {
  ENCOUNTER_DESPAWN_DISTANCE,
  ENCOUNTER_DISTANCE,
  ENCOUNTER_FADE_IN_DISTANCE,
  ENCOUNTER_FADE_OUT_DISTANCE,
  ENCOUNTER_MIN_SPEED,
  ENCOUNTER_MIN_SPEED_DISTANCE,
  ENCOUNTER_MIN_SPEED_FLOOR,
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  ENCOUNTER_SPEEDUP_DISTANCE,
} from '../config';
import type { ViewFrustum } from './renderSize';
import type { Vec3 } from './Ship';

export interface Encounter {
  /** Ship position when the encounter was planned (float64, CPU only). */
  origin: Vec3;
  /** Planet centre relative to `origin`: `direction × D + side × radius × k`. Small, so exact enough. */
  offset: Vec3;
  /**
   * Absolute planet centre, `origin + offset`. Each component is rounded to the float64 spacing at
   * that magnitude, so use `encounterOffset` for positions relative to the ship.
   */
  center: Vec3;
  /** Unit direction of the planned straight path (the heading when planned). */
  direction: Vec3;
  /** Unit vector from the path toward the planet centre, perpendicular to `direction`. */
  side: Vec3;
  /** Planet radius in world units. */
  radius: number;
  /** Closest distance between the path and the planet centre: `radius × k`. */
  closestDistance: number;
  /**
   * Remaining distance when the encounter was planned (the `D` it was planned with). The fade-in
   * starts here, so the planet always appears at opacity 0 whatever `D` is.
   */
  spawnDistance: number;
}

/**
 * Plans an encounter: the planet centre is `D` ahead of `shipPos` along `heading`, offset sideways by
 * `radius × k`, so the straight path passes the centre at exactly `radius × k`.
 *
 * The side is to the right of the heading (perpendicular to it and to world +Y), rotated about the
 * heading by `sideAngle` radians toward world up. `heading` need not be normalised.
 */
export function planEncounter(
  shipPos: Readonly<Vec3>,
  heading: Readonly<Vec3>,
  radius: number,
  D: number = ENCOUNTER_DISTANCE,
  k: number = ENCOUNTER_SIDE_OFFSET_FACTOR,
  sideAngle = 0,
): Encounter {
  if (!(radius > 0)) throw new RangeError(`planEncounter: radius must be positive, got ${radius}`);
  if (!(k > 1)) throw new RangeError(`planEncounter: k must be greater than 1, got ${k}`);
  const len = Math.hypot(heading.x, heading.y, heading.z);
  if (!(len > 0) || !Number.isFinite(len)) throw new RangeError('planEncounter: heading must be a non-zero vector');
  const dx = heading.x / len;
  const dy = heading.y / len;
  const dz = heading.z / len;

  // right = direction × up(0, 1, 0); if the heading is (nearly) vertical, use direction × (1, 0, 0).
  let rx = -dz;
  let ry = 0;
  let rz = dx;
  let rl = Math.hypot(rx, rz);
  if (rl < 1e-6) {
    rx = 0;
    ry = dz;
    rz = -dy;
    rl = Math.hypot(ry, rz);
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up = right × direction completes the frame; rotate right toward up by sideAngle.
  const ux = ry * dz - rz * dy;
  const uy = rz * dx - rx * dz;
  const uz = rx * dy - ry * dx;
  const c = Math.cos(sideAngle);
  const s = Math.sin(sideAngle);
  const side = { x: c * rx + s * ux, y: c * ry + s * uy, z: c * rz + s * uz };

  const closestDistance = radius * k;
  const offset = {
    x: dx * D + side.x * closestDistance,
    y: dy * D + side.y * closestDistance,
    z: dz * D + side.z * closestDistance,
  };
  return {
    origin: { x: shipPos.x, y: shipPos.y, z: shipPos.z },
    offset,
    center: { x: shipPos.x + offset.x, y: shipPos.y + offset.y, z: shipPos.z + offset.z },
    direction: { x: dx, y: dy, z: dz },
    side,
    radius,
    closestDistance,
    spawnDistance: D,
  };
}

/**
 * Writes the planet centre relative to the ship (`planet - ship`) into `out` and returns it.
 *
 * Computed as `(origin - ship) + offset`: the ship stays near `origin` during an encounter, so the
 * first difference is exact in float64 even at very large coordinates (Sterbenz), and the result
 * keeps full precision where `center - ship` would not.
 */
export function encounterOffset(encounter: Readonly<Encounter>, shipPos: Readonly<Vec3>, out: Vec3): Vec3 {
  const { origin, offset } = encounter;
  out.x = origin.x - shipPos.x + offset.x;
  out.y = origin.y - shipPos.y + offset.y;
  out.z = origin.z - shipPos.z + offset.z;
  return out;
}

/** Signed distance from the ship to the closest approach along the planned path (see the module comment). */
export function encounterRemaining(encounter: Readonly<Encounter>, shipPos: Readonly<Vec3>): number {
  const { origin, offset, direction } = encounter;
  return (
    (origin.x - shipPos.x + offset.x) * direction.x +
    (origin.y - shipPos.y + offset.y) * direction.y +
    (origin.z - shipPos.z + offset.z) * direction.z
  );
}

export interface EncounterProfile {
  /** Lowest target speed, held around the closest approach, in world units per second. */
  minSpeed: number;
  /**
   * Lowest value `setCruiseSpeed` scales `minSpeed` down to at the slower speed levels (units per
   * second), so the flyby does not crawl there. Not used by the target speed itself.
   */
  minSpeedFloor: number;
  /** Remaining distance at which the slowdown starts. */
  slowdownDistance: number;
  /** Half-width of the band around the closest approach where the target speed is `minSpeed`. */
  minSpeedDistance: number;
  /** Distance after that band over which the target speed returns to cruise. */
  speedupDistance: number;
  /** Distance after spawning over which opacity (and, below 1, the size scale) eases up. */
  fadeInDistance: number;
  /** Size scale at spawn. 1 for planets, nebulae and asteroids: they keep their world size throughout. */
  spawnScale: number;
  /** Distance before despawning over which opacity eases down. */
  fadeOutDistance: number;
  /** Distance past the closest approach at which the encounter ends with opacity 0. */
  despawnDistance: number;
}

export const DEFAULT_ENCOUNTER_PROFILE: Readonly<EncounterProfile> = {
  minSpeed: ENCOUNTER_MIN_SPEED,
  minSpeedFloor: ENCOUNTER_MIN_SPEED_FLOOR,
  slowdownDistance: ENCOUNTER_SLOWDOWN_DISTANCE,
  minSpeedDistance: ENCOUNTER_MIN_SPEED_DISTANCE,
  speedupDistance: ENCOUNTER_SPEEDUP_DISTANCE,
  fadeInDistance: ENCOUNTER_FADE_IN_DISTANCE,
  // A planet keeps its world size from spawn to despawn, so its apparent size comes from
  // perspective alone; it starts as a distant dot because it is far away (see ENCOUNTER_DISTANCE).
  spawnScale: 1,
  fadeOutDistance: ENCOUNTER_FADE_OUT_DISTANCE,
  despawnDistance: ENCOUNTER_DESPAWN_DISTANCE,
};

/**
 * Half-angle, in radians, of the narrowest cone around the camera's forward axis that contains the
 * whole view of a camera with vertical field of view `fovDeg` (degrees) at aspect ratio `aspect`
 * (width / height): the angle from the forward axis to the view's corners. The cone does not depend
 * on the camera's roll, and contains the view at every narrower aspect ratio too, since the vertical
 * field of view is fixed and a narrower screen only shows less at the sides. At `aspect` = 21:9
 * (config.ts, VIEW_WIDEST_ASPECT) it also contains the view at every wider aspect ratio, where the
 * engine narrows the vertical field of view instead (`cameraFovDeg` in renderSize.ts), so an object
 * outside it is off every screen. The autopilot tests the live view itself (`frustumSphereMargin`).
 */
export function viewConeHalfAngle(fovDeg: number, aspect: number): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  return Math.atan(tanHalf * Math.hypot(1, aspect));
}

/** Angle between `a` and `b`, in radians (neither need be normalised; 0 if either is zero). */
export function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z);
}

/**
 * Half-angle, in radians, of the narrowest cone around the camera's forward axis that contains
 * `view`: the angle from the forward axis to its corners (`viewConeHalfAngle` for that view).
 */
export function frustumConeHalfAngle(view: Readonly<ViewFrustum>): number {
  return Math.atan(Math.tan(view.halfFovY) * Math.hypot(1, view.aspect));
}

/**
 * How far, in world units, a sphere of radius `radius` centred at `offset` from the camera lies
 * outside `view` for a camera looking along `forward` with world +Y up (as `lookAt` sets it): the
 * distance from the centre to the view's infinite pyramid (bounded by its four side planes), minus
 * the radius. Positive means no part of the sphere is on screen; zero or negative means some part may
 * be (inside the pyramid the distance counts negative, to its nearest side plane). Exact, so it is
 * positive as soon as the sphere has left the screen, also past a corner. Pure and allocation-free.
 *
 * Monotonic along the heading: with `forward` held, moving the camera forward never brings a sphere
 * back into view. The pyramid `K` contains `forward`, so `K + t·forward ⊂ K` for t ≥ 0, and the
 * distance from `c - t·forward` to `K` never decreases as t grows.
 *
 * A (nearly) vertical `forward`, where `lookAt` has no up to go by and the roll is undefined, falls
 * back to the cone around the forward axis that contains the view whatever its roll
 * (`frustumConeHalfAngle`), and measures the margin along that cone.
 */
export function frustumSphereMargin(
  offset: Readonly<Vec3>,
  forward: Readonly<Vec3>,
  radius: number,
  view: Readonly<ViewFrustum>,
): number {
  const fl = Math.hypot(forward.x, forward.y, forward.z);
  const fx = forward.x / fl;
  const fy = forward.y / fl;
  const fz = forward.z / fl;
  // right = forward × up(0, 1, 0), up' = right × forward: the camera basis lookAt builds.
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz);
  if (!(rl > 1e-9)) {
    const d = Math.hypot(offset.x, offset.y, offset.z);
    const angle = angleBetween(forward, offset) - frustumConeHalfAngle(view);
    return angle >= Math.PI / 2 ? d - radius : d * Math.sin(Math.max(0, angle)) - radius;
  }
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  // Camera coordinates, folded into the top-right quadrant: the pyramid is symmetric about both axes.
  const a = Math.abs(offset.x * rx + offset.z * rz);
  const b = Math.abs(offset.x * ux + offset.y * uy + offset.z * uz);
  const c = offset.x * fx + offset.y * fy + offset.z * fz;
  const ty = Math.tan(view.halfFovY);
  const tx = ty * view.aspect;
  // Signed distances to the right and top side planes (outward normals (1, 0, -tx) and (0, 1, -ty)).
  const nx = Math.hypot(1, tx);
  const ny = Math.hypot(1, ty);
  const dR = (a - tx * c) / nx;
  const dT = (b - ty * c) / ny;
  if (dR <= 0 && dT <= 0) return Math.max(dR, dT) - radius;
  // Outside: the nearest point of the pyramid lies inside a face, on the corner edge, or at the apex.
  let best = Math.hypot(a, b, c);
  if (dR > 0) {
    // Foot on the right plane: (a, b, c) - dR × (1, 0, -tx) / nx; inside the face if within the top.
    const zr = c + (dR * tx) / nx;
    if (zr >= 0 && b <= ty * zr) best = Math.min(best, dR);
  }
  if (dT > 0) {
    const zt = c + (dT * ty) / ny;
    if (zt >= 0 && a <= tx * zt) best = Math.min(best, dT);
  }
  const el = Math.hypot(tx, ty, 1);
  const t = (a * tx + b * ty + c) / el;
  if (t > 0) best = Math.min(best, Math.hypot(a - (tx * t) / el, b - (ty * t) / el, c - t / el));
  return best - radius;
}

/** Smoothstep: 0 at or below `edge0`, 1 at or beyond `edge1`, C¹ in between. `edge0 > edge1` is allowed. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Target speed for the ship at `remaining` distance to the closest approach, in world units per
 * second: `cruiseSpeed` far from the planet, easing (smoothstep) down to the minimum speed, which is
 * held within `minSpeedDistance` of the closest approach, then easing back up to `cruiseSpeed`.
 * Continuous, non-increasing while approaching and non-decreasing after passing. A cruise speed below
 * the minimum is returned unchanged (an encounter never speeds the ship up).
 *
 * Meant to be fed to Ship's `targetSpeed` every frame: the ship's exponential approach lags it by
 * about `speedTau`, so the profile changes over distances the ship covers in several time constants.
 */
export function encounterTargetSpeed(
  remaining: number,
  cruiseSpeed: number,
  profile: Readonly<EncounterProfile> = DEFAULT_ENCOUNTER_PROFILE,
): number {
  const { minSpeedDistance: hold, slowdownDistance, speedupDistance } = profile;
  const minSpeed = Math.min(profile.minSpeed, cruiseSpeed);
  const w =
    remaining >= 0
      ? smoothstep(hold, slowdownDistance, remaining)
      : smoothstep(-hold, -hold - speedupDistance, remaining);
  return minSpeed + (cruiseSpeed - minSpeed) * w;
}

/**
 * Fade-in progress: 0 at the encounter's spawn distance (and before it), 1 once `fadeInDistance` has
 * been travelled. The spawn distance comes from the encounter itself, so it always matches its `D`.
 */
function fadeIn(encounter: Readonly<Encounter>, remaining: number, profile: Readonly<EncounterProfile>): number {
  const { spawnDistance } = encounter;
  return smoothstep(spawnDistance, spawnDistance - profile.fadeInDistance, remaining);
}

/**
 * Planet opacity in [0, 1] at `remaining` distance: 0 at the encounter's spawn distance, easing up
 * to 1 over `fadeInDistance`, and easing back down to 0 at `despawnDistance` past the closest approach.
 */
export function encounterOpacity(
  encounter: Readonly<Encounter>,
  remaining: number,
  profile: Readonly<EncounterProfile> = DEFAULT_ENCOUNTER_PROFILE,
): number {
  const fadeOut = smoothstep(-profile.despawnDistance, profile.fadeOutDistance - profile.despawnDistance, remaining);
  return fadeIn(encounter, remaining, profile) * fadeOut;
}

/**
 * Size scale in [spawnScale, 1] at `remaining` distance: `spawnScale` at the encounter's spawn
 * distance, easing up to 1 over `fadeInDistance` and staying 1 after that. Both default profiles
 * (planets, nebulae and asteroids) have a spawn scale of 1, so it is 1 throughout: the object keeps its world
 * size and only its opacity fades.
 */
export function encounterScale(
  encounter: Readonly<Encounter>,
  remaining: number,
  profile: Readonly<EncounterProfile> = DEFAULT_ENCOUNTER_PROFILE,
): number {
  return profile.spawnScale + (1 - profile.spawnScale) * fadeIn(encounter, remaining, profile);
}
