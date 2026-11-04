/**
 * Tunable settings (docs/PLAN.md section 8: speeds, star count, DPR cap, timings, etc.).
 * Values other than the DPR cap are placeholders until the features that use them land.
 */

/** Upper bound on the device pixel ratio applied to the renderer (docs/PLAN.md section 6, Performance). */
export const DPR_CAP = 2;

/** Camera vertical field of view in degrees, and clip planes in world units. Placeholders until the starfield is tuned. */
export const CAMERA_FOV_DEG = 60;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 10000;

/** Renderer clear colour (deep space). */
export const CLEAR_COLOR = 0x000000;

/** Largest simulation step per frame, in seconds (docs/PLAN.md section 6, Time and speed). */
export const DT_CAP_SECONDS = 0.1;

/** Delay before the UI and cursor hide with no input, in milliseconds (docs/PLAN.md section 7). Placeholder. */
export const UI_HIDE_DELAY_MS = 2500;

/**
 * Ship cruise speeds, in world units per second, slowest first (docs/PLAN.md section 6, Time and speed).
 * Placeholder values until the starfield and the Speed setting are tuned against them.
 */
export const SHIP_SPEED_LEVELS = [20, 60, 150] as const;

/** Index into SHIP_SPEED_LEVELS used when travel starts. */
export const SHIP_DEFAULT_SPEED_LEVEL = 1;

/**
 * Time constant of the exponential approach to the target speed, in seconds: each `tau` seconds the
 * gap between the current and target speed shrinks to 1/e (about 37%) of what it was.
 */
export const SHIP_SPEED_TAU_SECONDS = 2;

/**
 * Slow heading drift (docs/PLAN.md section 9, Phase 1): yaw and pitch follow low-frequency sines of
 * the accumulated simulation time. Amplitudes are in radians, periods in seconds. Pitch stays well
 * away from the poles.
 */
export const SHIP_YAW_DRIFT_AMPLITUDE_RAD = 0.6;
export const SHIP_YAW_DRIFT_PERIOD_SECONDS = 240;
export const SHIP_PITCH_DRIFT_AMPLITUDE_RAD = 0.2;
export const SHIP_PITCH_DRIFT_PERIOD_SECONDS = 150;

/**
 * Largest allowed angular change of the heading, in radians per second, so turns stay smooth.
 * The drift settings above must stay below it: their peak rate is about
 * sqrt((yawAmp * 2π / yawPeriod)² + (pitchAmp * 2π / pitchPeriod)²) ≈ 0.018 rad/s.
 */
export const SHIP_MAX_TURN_RATE_RAD_PER_S = 0.03;

/*
 * Starfield (docs/PLAN.md section 6, Starfield). Distances are in world units, the same units as the
 * ship speeds above; pixel sizes are CSS pixels and are multiplied by the applied DPR on the GPU.
 */

/** Number of stars (one instanced quad each). */
export const STAR_COUNT = 12000;

/** Side `L` of the cube the stars live in, centred on the camera and wrapped as the ship moves. */
export const STAR_CUBE_SIZE = 1200;

/** Streak tail = head + ship velocity × this time, in seconds. Longer means longer streaks. */
export const STAR_STREAK_TIME_SECONDS = 0.06;

/** Star width in CSS pixels before the per-star size factor. A still star is a dot this wide. */
export const STAR_BASE_SIZE_PX = 1.6;

/** Range of the per-star size factor (multiplies STAR_BASE_SIZE_PX). Skewed toward the small end. */
export const STAR_SIZE_MIN = 0.7;
export const STAR_SIZE_MAX = 1.8;

/** Range of the per-star brightness. Skewed toward the dim end, with a few bright stars. */
export const STAR_BRIGHTNESS_MIN = 0.45;
export const STAR_BRIGHTNESS_MAX = 1;

/**
 * Fading, so wrapping never pops a star in or out. A star fades to 0 over the last
 * STAR_EDGE_FADE_WIDTH units before the cube boundary, and over the last STAR_NEAR_FADE_DISTANCE
 * units before the camera.
 */
export const STAR_EDGE_FADE_WIDTH = 150;
export const STAR_NEAR_FADE_DISTANCE = 4;

/** Depth cue: brightness falls off as 1 / (1 + (distance / STAR_DIM_DISTANCE)²). */
export const STAR_DIM_DISTANCE = 380;

/** Stars closer than this grow (size × STAR_GROWTH_DISTANCE / distance), up to STAR_MAX_GROWTH times. */
export const STAR_GROWTH_DISTANCE = 60;
export const STAR_MAX_GROWTH = 2;

/** Longest drawn streak, in CSS pixels, so a star passing right by the camera never spans the screen. */
export const STAR_MAX_STREAK_PX = 360;

/** Seed for the star layout, so every run starts from the same sky. */
export const STAR_SEED = 0x5eed_57a2;

/*
 * Reduced motion (docs/PLAN.md section 7): under `prefers-reduced-motion: reduce`, travel starts at a
 * slower speed level with shorter streaks. The user can still raise the speed from there.
 */

/** Index into SHIP_SPEED_LEVELS used when travel starts with reduced motion. */
export const REDUCED_MOTION_SPEED_LEVEL = 0;

/** Streak time, in seconds, with reduced motion (see STAR_STREAK_TIME_SECONDS). */
export const REDUCED_MOTION_STREAK_TIME_SECONDS = 0.03;

export interface InitialSpeedSettings {
  /** Index into SHIP_SPEED_LEVELS that travel starts at. */
  speedLevel: number;
  /** Starfield streak time, in seconds. */
  streakTime: number;
}

/** Starting speed level and streak time, depending on whether the user prefers reduced motion. */
export function initialSpeedSettings(prefersReducedMotion: boolean): InitialSpeedSettings {
  return prefersReducedMotion
    ? { speedLevel: REDUCED_MOTION_SPEED_LEVEL, streakTime: REDUCED_MOTION_STREAK_TIME_SECONDS }
    : { speedLevel: SHIP_DEFAULT_SPEED_LEVEL, streakTime: STAR_STREAK_TIME_SECONDS };
}
