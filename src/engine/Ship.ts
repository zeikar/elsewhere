/**
 * Ship simulation: travel position, speed and heading (docs/PLAN.md sections 6 and 9).
 *
 * The travel position is kept on the CPU only, as plain JS numbers (float64), and never goes into a
 * Three.js vector that reaches the GPU. The camera always sits at the origin; renderers use
 * `object position - ship position` and the heading. This module has no DOM or WebGL dependencies.
 */
import {
  DT_CAP_SECONDS,
  SHIP_DEFAULT_SPEED_LEVEL,
  SHIP_PITCH_DRIFT_AMPLITUDE_RAD,
  SHIP_PITCH_DRIFT_PERIOD_SECONDS,
  SHIP_SPEED_LEVELS,
  SHIP_SPEED_TAU_SECONDS,
  SHIP_YAW_DRIFT_AMPLITUDE_RAD,
  SHIP_YAW_DRIFT_PERIOD_SECONDS,
} from '../config';

/** A plain float64 3-vector. Deliberately not a Three.js `Vector3`. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ShipState {
  /** Accumulated simulation time in seconds; drives the heading drift. */
  time: number;
  /** Current speed in world units per second. */
  speed: number;
  /** Total distance travelled along the path, in world units. */
  distance: number;
  /** Travel position in world units (float64, CPU only). */
  position: Vec3;
  /** Unit direction of travel. */
  heading: Vec3;
  /** heading × speed, in world units per second (for the streak shader). */
  velocity: Vec3;
}

export interface ShipParams {
  /** Speed the ship eases toward, in world units per second. */
  targetSpeed: number;
  /** Time constant of the exponential speed approach, in seconds. */
  speedTau: number;
  yawAmplitude: number;
  yawPeriod: number;
  pitchAmplitude: number;
  pitchPeriod: number;
}

export const DEFAULT_SHIP_PARAMS: Readonly<ShipParams> = {
  targetSpeed: SHIP_SPEED_LEVELS[SHIP_DEFAULT_SPEED_LEVEL],
  speedTau: SHIP_SPEED_TAU_SECONDS,
  yawAmplitude: SHIP_YAW_DRIFT_AMPLITUDE_RAD,
  yawPeriod: SHIP_YAW_DRIFT_PERIOD_SECONDS,
  pitchAmplitude: SHIP_PITCH_DRIFT_AMPLITUDE_RAD,
  pitchPeriod: SHIP_PITCH_DRIFT_PERIOD_SECONDS,
};

/**
 * Clamps a raw frame delta to [0, DT_CAP_SECONDS]. Negative or NaN input gives 0; +Infinity gives
 * the cap.
 */
export function clampDt(dt: number): number {
  if (!(dt > 0)) return 0; // also catches NaN
  return Math.min(dt, DT_CAP_SECONDS);
}

/**
 * Writes the unit heading at simulation time `time` into `out` and returns it.
 * Yaw turns about +Y (positive toward +X) and pitch tilts toward +Y; at zero yaw and pitch the
 * heading is -Z, the default Three.js camera direction.
 */
export function headingAt(time: number, params: Readonly<ShipParams>, out: Vec3): Vec3 {
  const yaw = params.yawAmplitude * Math.sin((2 * Math.PI * time) / params.yawPeriod);
  const pitch = params.pitchAmplitude * Math.sin((2 * Math.PI * time) / params.pitchPeriod);
  const cosPitch = Math.cos(pitch);
  out.x = Math.sin(yaw) * cosPitch;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cosPitch;
  return out;
}

export interface ShipInit {
  time?: number;
  speed?: number;
  distance?: number;
  position?: Readonly<Vec3>;
}

/** Creates a ship state whose heading and velocity are consistent with its time and speed. */
export function createShipState(
  init: ShipInit = {},
  params: Readonly<ShipParams> = DEFAULT_SHIP_PARAMS,
): ShipState {
  const time = init.time ?? 0;
  const speed = init.speed ?? 0;
  const heading = headingAt(time, params, { x: 0, y: 0, z: 0 });
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
 * The position moves that distance along the heading at the middle of the step.
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
  const px = state.position.x;
  const py = state.position.y;
  const pz = state.position.z;
  const distance = state.distance + step;

  // Mid-step heading, written into out.heading as scratch before the final heading overwrites it.
  const mid = headingAt(state.time + dt / 2, params, out.heading);
  out.position.x = px + mid.x * step;
  out.position.y = py + mid.y * step;
  out.position.z = pz + mid.z * step;

  const heading = headingAt(time, params, out.heading);
  out.time = time;
  out.speed = speed;
  out.distance = distance;
  out.velocity.x = heading.x * speed;
  out.velocity.y = heading.y * speed;
  out.velocity.z = heading.z * speed;
  return out;
}
