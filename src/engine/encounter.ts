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
  ENCOUNTER_SIDE_OFFSET_FACTOR,
  ENCOUNTER_SLOWDOWN_DISTANCE,
  ENCOUNTER_SPAWN_SCALE,
  ENCOUNTER_SPEEDUP_DISTANCE,
} from '../config';
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
  /** Remaining distance at which the encounter starts (= `D`). */
  spawnDistance: number;
  /** Lowest target speed, held around the closest approach, in world units per second. */
  minSpeed: number;
  /** Remaining distance at which the slowdown starts. */
  slowdownDistance: number;
  /** Half-width of the band around the closest approach where the target speed is `minSpeed`. */
  minSpeedDistance: number;
  /** Distance after that band over which the target speed returns to cruise. */
  speedupDistance: number;
  /** Distance after spawning over which opacity and scale ease up. */
  fadeInDistance: number;
  /** Size scale at spawn. */
  spawnScale: number;
  /** Distance before despawning over which opacity eases down. */
  fadeOutDistance: number;
  /** Distance past the closest approach at which the encounter ends with opacity 0. */
  despawnDistance: number;
}

export const DEFAULT_ENCOUNTER_PROFILE: Readonly<EncounterProfile> = {
  spawnDistance: ENCOUNTER_DISTANCE,
  minSpeed: ENCOUNTER_MIN_SPEED,
  slowdownDistance: ENCOUNTER_SLOWDOWN_DISTANCE,
  minSpeedDistance: ENCOUNTER_MIN_SPEED_DISTANCE,
  speedupDistance: ENCOUNTER_SPEEDUP_DISTANCE,
  fadeInDistance: ENCOUNTER_FADE_IN_DISTANCE,
  spawnScale: ENCOUNTER_SPAWN_SCALE,
  fadeOutDistance: ENCOUNTER_FADE_OUT_DISTANCE,
  despawnDistance: ENCOUNTER_DESPAWN_DISTANCE,
};

/** Smoothstep: 0 at or below `edge0`, 1 at or beyond `edge1`, C¹ in between. `edge0 > edge1` is allowed. */
function smoothstep(edge0: number, edge1: number, x: number): number {
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

/** Fade-in progress: 0 at the spawn distance (and before it), 1 once `fadeInDistance` has been travelled. */
function fadeIn(remaining: number, profile: Readonly<EncounterProfile>): number {
  return smoothstep(profile.spawnDistance, profile.spawnDistance - profile.fadeInDistance, remaining);
}

/**
 * Planet opacity in [0, 1] at `remaining` distance: 0 at the spawn distance, easing up to 1 over
 * `fadeInDistance`, and easing back down to 0 at `despawnDistance` past the closest approach.
 */
export function encounterOpacity(
  remaining: number,
  profile: Readonly<EncounterProfile> = DEFAULT_ENCOUNTER_PROFILE,
): number {
  const fadeOut = smoothstep(-profile.despawnDistance, profile.fadeOutDistance - profile.despawnDistance, remaining);
  return fadeIn(remaining, profile) * fadeOut;
}

/**
 * Planet size scale in [spawnScale, 1] at `remaining` distance: `spawnScale` at the spawn distance,
 * easing up to 1 over `fadeInDistance` and staying 1 after that, so the planet starts as a distant dot
 * and has its full radius well before the closest approach.
 */
export function encounterScale(
  remaining: number,
  profile: Readonly<EncounterProfile> = DEFAULT_ENCOUNTER_PROFILE,
): number {
  return profile.spawnScale + (1 - profile.spawnScale) * fadeIn(remaining, profile);
}
