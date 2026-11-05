/**
 * Ship simulation: travel position, speed and heading (docs/PLAN.md sections 6 and 9).
 *
 * The travel position is kept on the CPU only, as plain JS numbers (float64), and never goes into a
 * Three.js vector that reaches the GPU. The camera always sits at the origin; renderers use
 * `object position - ship position` and the heading. This module has no DOM or WebGL dependencies.
 *
 * The heading is fixed (SHIP_HEADING, -Z): the ship never turns, so the camera's rotation never
 * changes and the far stars and galaxies stay still. Only the speed changes, and the ship moves in a
 * straight line along the heading.
 */
import { DT_CAP_SECONDS, SHIP_DEFAULT_SPEED_LEVEL, SHIP_HEADING, SHIP_SPEED_LEVELS, SHIP_SPEED_TAU_SECONDS } from '../config';

/** A plain float64 3-vector. Deliberately not a Three.js `Vector3`. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ShipState {
  /** Accumulated simulation time in seconds. */
  time: number;
  /** Current speed in world units per second. */
  speed: number;
  /** Total distance travelled along the path, in world units. */
  distance: number;
  /** Travel position in world units (float64, CPU only). */
  position: Vec3;
  /** Unit direction of travel: always SHIP_HEADING (-Z). */
  heading: Vec3;
  /** heading × speed, in world units per second (for the streak shader). */
  velocity: Vec3;
}

export interface ShipParams {
  /** Speed the ship eases toward, in world units per second. */
  targetSpeed: number;
  /** Time constant of the exponential speed approach, in seconds. */
  speedTau: number;
}

export const DEFAULT_SHIP_PARAMS: Readonly<ShipParams> = {
  targetSpeed: SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL],
  speedTau: SHIP_SPEED_TAU_SECONDS,
};

/**
 * Clamps a raw frame delta to [0, DT_CAP_SECONDS]. Negative or NaN input gives 0; +Infinity gives
 * the cap.
 */
export function clampDt(dt: number): number {
  if (!(dt > 0)) return 0; // also catches NaN
  return Math.min(dt, DT_CAP_SECONDS);
}

export interface ShipInit {
  time?: number;
  speed?: number;
  distance?: number;
  position?: Readonly<Vec3>;
}

/** Creates a ship state heading along SHIP_HEADING, with the velocity for its speed. */
export function createShipState(init: ShipInit = {}): ShipState {
  const time = init.time ?? 0;
  const speed = init.speed ?? 0;
  const heading = { x: SHIP_HEADING.x, y: SHIP_HEADING.y, z: SHIP_HEADING.z };
  const position = init.position ?? { x: 0, y: 0, z: 0 };
  return {
    time,
    speed,
    distance: init.distance ?? 0,
    position: { x: position.x, y: position.y, z: position.z },
    heading,
    velocity: { x: heading.x * speed, y: heading.y * speed, z: heading.z * speed },
  };
}

/**
 * Advances the ship by `dt` seconds (clamped with `clampDt`) and returns the new state.
 *
 * `state` is never modified. The result is written into `out` (a fresh state by default) so a frame
 * loop can reuse one object and allocate nothing; `out` may also be `state` itself.
 *
 * Speed follows the exact solution of dv/dt = (target - v) / tau, and the distance is its exact
 * integral over the step, so results do not depend on how a span of time is split into frames.
 * The position moves that distance along the fixed heading.
 */
export function updateShip(
  state: Readonly<ShipState>,
  rawDt: number,
  params: Readonly<ShipParams> = DEFAULT_SHIP_PARAMS,
  out: ShipState = createShipState(),
): ShipState {
  const dt = clampDt(rawDt);
  const { targetSpeed, speedTau } = params;

  const gap = state.speed - targetSpeed;
  const decay = Math.exp(-dt / speedTau);
  const speed = targetSpeed + gap * decay;
  // ∫ (target + gap·e^(-t/tau)) dt over [0, dt]. -expm1(-x) is 1 - e^(-x) without cancellation.
  const step = targetSpeed * dt - gap * speedTau * Math.expm1(-dt / speedTau);

  const time = state.time + dt;
  const distance = state.distance + step;
  const heading = out.heading;
  heading.x = SHIP_HEADING.x;
  heading.y = SHIP_HEADING.y;
  heading.z = SHIP_HEADING.z;
  out.position.x = state.position.x + heading.x * step;
  out.position.y = state.position.y + heading.y * step;
  out.position.z = state.position.z + heading.z * step;

  out.time = time;
  out.speed = speed;
  out.distance = distance;
  out.velocity.x = heading.x * speed;
  out.velocity.y = heading.y * speed;
  out.velocity.z = heading.z * speed;
  return out;
}
