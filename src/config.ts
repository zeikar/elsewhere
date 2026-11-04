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
 * Encounters (docs/PLAN.md section 6, Planets). An encounter plans a straight path along the heading
 * at the moment it starts, and places the planet beside it. Distances are in world units, measured
 * along that path from the point of closest approach: positive while approaching, negative after
 * passing. Values are first tunings until the autopilot and planets land.
 */

/**
 * Encounter interval (docs/PLAN.md section 9, Phase 2): seconds of cruise before each encounter
 * starts, counted from load and again from the end of each encounter. With the default speed the
 * first planet appears as a distant dot this long after load, inside the 30–60 s the plan asks for.
 */
export const ENCOUNTER_INTERVAL_SECONDS = 40;

/**
 * Over the last this many seconds of the cruise, the heading drift eases to a stop, so the heading
 * is already still when the encounter is planned and stays held through APPROACH and FLYBY. It
 * resumes gradually in DEPARTURE, continuing from where it stopped.
 */
export const ENCOUNTER_DRIFT_SETTLE_SECONDS = 5;

/** Remaining distance to the closest approach at which APPROACH becomes FLYBY. */
export const ENCOUNTER_FLYBY_DISTANCE = 300;

/** Planet radius in world units. A fixed placeholder until seeded planet parameters land. */
export const ENCOUNTER_PLANET_RADIUS = 120;

/** Base seed for encounter appearance: encounter `i` uses `hash(ENCOUNTER_BASE_SEED, i)`. */
export const ENCOUNTER_BASE_SEED = 0x91a7_e7a5;

/**
 * `D`: the planet is placed this far ahead along the heading when the encounter starts, so it is
 * also the spawn distance. Kept well inside CAMERA_FAR.
 */
export const ENCOUNTER_DISTANCE = 1600;

/** `k`: the planet centre sits `radius × k` to the side of the path, which is the closest approach. */
export const ENCOUNTER_SIDE_OFFSET_FACTOR = 2;

/**
 * Required clearance: the closest approach to the centre must be at least `radius × (1 + margin)`,
 * so ENCOUNTER_SIDE_OFFSET_FACTOR must stay above 1 + this margin and the path never meets the sphere.
 */
export const ENCOUNTER_CLEARANCE_MARGIN = 0.25;

/**
 * Speed profile. The target speed is the cruise speed until ENCOUNTER_SLOWDOWN_DISTANCE before the
 * closest approach, then eases down to ENCOUNTER_MIN_SPEED (units per second), which it holds within
 * ENCOUNTER_MIN_SPEED_DISTANCE either side of the closest approach, then eases back up to cruise over
 * ENCOUNTER_SPEEDUP_DISTANCE. The ship follows it through its exponential speed approach
 * (SHIP_SPEED_TAU_SECONDS), so the slowdown spans several time constants even at the top speed.
 */
export const ENCOUNTER_MIN_SPEED = 15;
export const ENCOUNTER_SLOWDOWN_DISTANCE = 800;
export const ENCOUNTER_MIN_SPEED_DISTANCE = 40;
export const ENCOUNTER_SPEEDUP_DISTANCE = 800;

/**
 * Fade. From the spawn distance (the encounter's `D`, ENCOUNTER_DISTANCE by default), opacity eases
 * up from 0 to 1 and the size scale from ENCOUNTER_SPAWN_SCALE to 1 over ENCOUNTER_FADE_IN_DISTANCE,
 * so the planet starts as a distant dot. After passing, opacity eases back down to 0 over ENCOUNTER_FADE_OUT_DISTANCE, reaching
 * 0 at ENCOUNTER_DESPAWN_DISTANCE past the closest approach. The fade distances are long enough that
 * at the top cruise speed one capped frame changes opacity by less than 2%.
 */
export const ENCOUNTER_FADE_IN_DISTANCE = 1200;
export const ENCOUNTER_SPAWN_SCALE = 0.15;
export const ENCOUNTER_FADE_OUT_DISTANCE = 1200;
export const ENCOUNTER_DESPAWN_DISTANCE = 1500;

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
