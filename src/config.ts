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

/**
 * Performance instrumentation (docs/PLAN.md section 6, Performance): the engine keeps the last this
 * many frame intervals and frame work times, and reports their rolling mean and 95th percentile
 * (engine/FrameStats.ts). About 2 s at 60 FPS.
 */
export const PERF_FRAME_WINDOW = 120;

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
 * Seeded jitter on the encounter interval (docs/PLAN.md section 9, Phase 3): the cruise before
 * encounter `i` lasts `interval × (1 + jitter × u)`, with `u` drawn uniformly from [-1, 1) by the
 * encounter's appearance seed, so the mean interval is still ENCOUNTER_INTERVAL_SECONDS. With 40 s
 * and 0.2 every cruise lasts 32–48 s, so the first encounter still appears 30–60 s after load.
 */
export const ENCOUNTER_INTERVAL_JITTER = 0.2;

/**
 * Most encounters of one kind (planet or nebula) in a row. When the seeded draw would make one more,
 * the encounter is the other kind instead; the draw is biased to compensate, so the long-run share
 * of nebulae is still ENCOUNTER_NEBULA_SHARE. Ignored when every encounter is forced to one kind.
 */
export const ENCOUNTER_MAX_SAME_KIND_RUN = 3;

/**
 * Side of the path (docs/PLAN.md section 9, Phase 3): each encounter's planet or nebula sits to the
 * left or the right of the path (seeded, even odds), raised or lowered by an elevation angle drawn
 * from this range, in radians (0 is level with the path, positive is up).
 */
export const ENCOUNTER_SIDE_ELEVATION_RANGE = [-0.6, 0.6] as const;

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

/**
 * Base seed for encounter appearance: encounter `i` uses `hash(ENCOUNTER_BASE_SEED, i)`. It is the
 * same on every load, so it is chosen for its opening: an oceanic planet first (within the 30–60 s
 * of docs/PLAN.md section 9, Phase 2), then a nebula, then another planet and another nebula.
 */
export const ENCOUNTER_BASE_SEED = 0x91b3_a5ba;

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
/**
 * Lowest encounter minimum speed (units per second) at any speed level. `setCruiseSpeed` scales
 * ENCOUNTER_MIN_SPEED with the cruise speed, which would make it 5 at the slowest level (the
 * reduced-motion start): one encounter would take about 250 s, about 48 s of it in FLYBY. With this
 * floor it takes about 195 s, about 27 s in FLYBY.
 */
export const ENCOUNTER_MIN_SPEED_FLOOR = 10;
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
 * Planets (docs/PLAN.md section 6, Planets). `planetParams(seed)` in engine/Planet.ts draws every
 * value below from an encounter's appearance seed. Ranges are inclusive `[min, max]` pairs; radii are
 * in world units, angles in radians, speeds in radians per second, and noise values are in the
 * units of a unit sphere (the shared planet geometry).
 *
 * Radii stay compatible with the encounter plan: the closest approach is `radius × k`
 * (ENCOUNTER_SIDE_OFFSET_FACTOR) whatever the radius, every planet fits far inside the spawn
 * distance ENCOUNTER_DISTANCE, so it starts as a distant dot, and the atmosphere shell
 * (`radius × (1 + thickness)`) stays inside the clearance `radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`,
 * so the camera never enters it. ENCOUNTER_PLANET_RADIUS lies inside the combined radius range.
 */

/** Share of planets that are gas giants; the rest are rocky. */
export const PLANET_GAS_SHARE = 0.45;

/** Parameter ranges for rocky planets. */
export const PLANET_ROCKY_RANGES = {
  radius: [45, 110],
  /** Base frequency of the terrain noise. */
  noiseScale: [1.2, 2.8],
  /** Terrain noise octaves (an integer). */
  octaves: [5, 6],
  /** Domain-warp strength: higher gives more swirled continents. */
  warp: [0.1, 0.7],
  /** Height below which the surface is flat basin or sea (terrain heights are roughly in [-0.6, 0.6]). */
  seaLevel: [-0.3, 0.2],
  /** Polar ice: fraction of the latitude, from each pole, that is covered. 0 means no caps. */
  iceCap: [0, 0.3],
  /** Specular highlight strength on seas. 0 for dry worlds. */
  specular: [0, 0.5],
  /** Surface relief used for bump shading. */
  relief: [0.5, 1.5],
  /** Crater density: the chance that a cell of the crater lattice holds a crater. 0 means none. */
  craters: [0, 0.7],
  rotationSpeed: [0.008, 0.035],
  axialTilt: [0, 0.6],
  /** Atmosphere shell thickness, as a fraction of the radius. */
  atmosphereThickness: [0.035, 0.07],
  /** Atmosphere glow strength. 0 means airless (no glow is drawn). */
  atmosphereIntensity: [0, 1.2],
} as const;

/** Parameter ranges for gas giants. */
export const PLANET_GAS_RANGES = {
  radius: [100, 170],
  /** Base frequency of the turbulence noise. */
  noiseScale: [1.4, 3.4],
  /** Turbulence noise octaves (an integer). */
  octaves: [4, 5],
  /** Band cycles from pole to pole (how many bands there are). */
  bandFrequency: [4, 14],
  /** Phase of the band pattern, in radians. */
  bandPhase: [0, 2 * Math.PI],
  /** How far the turbulence pushes the bands around. */
  turbulence: [0.2, 0.8],
  /** Size of the oval storm, as an angle on the sphere. 0 means no storm. */
  stormSize: [0, 0.22],
  /** Storm latitude and longitude, in radians. */
  stormLatitude: [-0.6, 0.6],
  stormLongitude: [-Math.PI, Math.PI],
  rotationSpeed: [0.015, 0.06],
  axialTilt: [0, 0.6],
  atmosphereThickness: [0.06, 0.12],
  atmosphereIntensity: [0.5, 1.2],
} as const;

/**
 * Largest seeded tints of a planet's colours, so no two planets of a palette family match exactly:
 * each channel of the family's palette colours (which also share a small brightness shift) and of
 * the atmosphere colour picked from the family's is multiplied by a factor within `1 ± this`.
 */
export const PLANET_PALETTE_TINT = 0.06;
export const PLANET_ATMOSPHERE_TINT = 0.1;

/** Range shared by both types for the starting rotation angle, in radians. */
export const PLANET_ROTATION_PHASE_RANGE = [0, 2 * Math.PI] as const;

/** Range for each component of the noise-domain offset, so each seed samples its own region of noise. */
export const PLANET_NOISE_OFFSET_RANGE = [-100, 100] as const;

/**
 * Direction toward the light (the "sun") in world space, used until the encounter supplies its own.
 * From the right, above and behind the camera's starting heading (-Z), so an approaching planet shows
 * its lit face with the terminator to one side.
 */
export const PLANET_LIGHT_DIRECTION = { x: 0.8, y: 0.3, z: 0.45 } as const;

/**
 * Direction toward the light during an encounter, in the encounter's own frame, so every planet is
 * lit the same way whatever the heading was when it was planned. `behind`: toward where the ship
 * came from (against the planned direction), so the approaching planet shows a lit face. `inward`:
 * from the planet toward the path, so the face turned to the ship at the closest approach is lit
 * too. `up`: along the third axis of the frame. Normalised when applied.
 */
export const PLANET_ENCOUNTER_LIGHT = { behind: 0.6, inward: 0.6, up: 0.3 } as const;

/** Width and height segments of the shared planet sphere geometry. */
export const PLANET_SPHERE_SEGMENTS = [96, 64] as const;

/*
 * Nebulae (docs/PLAN.md section 6, Nebulae (Phase 3)): layered, soft-blended planes shaded with a
 * cheap fBm fragment shader. An encounter is a planet or a nebula, chosen from the encounter's
 * appearance seed `hash(ENCOUNTER_BASE_SEED, index)`. Nebula encounters use the same planned-path
 * maths as planets (`planEncounter`), with their own distance, side offset, speed and fade curves.
 *
 * A nebula's `radius` (the encounter radius, used for the clearance) is its core radius: every
 * layer's centre lies within NEBULA_RANGES.layerOffset × radius of the axis through the nebula
 * centre along the planned path, so the path, `radius × NEBULA_SIDE_OFFSET_FACTOR` from that axis,
 * never crosses the bright core. The layers' soft outskirts (half-size NEBULA_RANGES.layerSize ×
 * radius) reach across the path, so the ship flies through faint wisps; each layer fades out as the
 * camera nears its plane (NEBULA_NEAR_FADE_*), so passing through never pops.
 */

/** Share of encounters that are nebulae; the rest are planets. */
export const ENCOUNTER_NEBULA_SHARE = 0.35;

/** Bounds the nebula share over any 1,000 consecutive encounter indices must stay within. */
export const ENCOUNTER_NEBULA_SHARE_BOUNDS = [0.3, 0.4] as const;

/**
 * `D` for nebulae: the nebula centre is placed this far ahead, which is also the spawn distance.
 * Further than for planets, since a nebula is much larger; the farthest layer stays well inside
 * CAMERA_FAR.
 */
export const NEBULA_ENCOUNTER_DISTANCE = 2600;

/** `k` for nebulae: the path passes `radius × k` from the nebula centre (see the section comment). */
export const NEBULA_SIDE_OFFSET_FACTOR = 1.7;

/**
 * Nebula speed profile (see the planet one above): a gentler slowdown with a higher minimum speed, so
 * the wisps keep streaming past while the ship drifts through them.
 */
export const NEBULA_MIN_SPEED = 24;
export const NEBULA_SLOWDOWN_DISTANCE = 1200;
export const NEBULA_MIN_SPEED_DISTANCE = 120;
export const NEBULA_SPEEDUP_DISTANCE = 600;

/**
 * Nebula fade (see the planet one above). A nebula does not grow from a dot (its spawn scale is 1):
 * it is far beyond the star cube when it spawns and fades in from opacity 0. It ends shortly after
 * every layer is behind the camera.
 */
export const NEBULA_FADE_IN_DISTANCE = 1400;
export const NEBULA_FADE_OUT_DISTANCE = 700;
export const NEBULA_DESPAWN_DISTANCE = 1400;

/**
 * Per-layer near-camera fade (like the stars' near fade): a layer's opacity eases (smoothstep) from 1
 * at NEBULA_NEAR_FADE_MIN_DISTANCE + NEBULA_NEAR_FADE_DISTANCE from the camera to its plane down to 0
 * at NEBULA_NEAR_FADE_MIN_DISTANCE, and the layer is not drawn closer than that.
 */
export const NEBULA_NEAR_FADE_MIN_DISTANCE = 40;
export const NEBULA_NEAR_FADE_DISTANCE = 360;

/**
 * Smallest nebula layer alpha that is drawn. A fragment whose combined alpha (encounter fade × near
 * fade × edge-on fade) is below this is discarded before any noise is evaluated, and a layer whose
 * encounter fade × near fade is below it is not drawn at all. Even the brightest possible fragment
 * then changes an 8-bit channel by under half a step, so skipping it leaves every pixel as it was
 * (no edge where the cut-off falls, no pop when a layer is hidden). Checked in Nebula.test.ts.
 */
export const NEBULA_MIN_ALPHA = 1 / 1024;

/**
 * Parameter ranges for `nebulaParams(seed)` in engine/Nebula.ts (inclusive `[min, max]` pairs).
 * Lengths given "in radii" are multiples of the nebula's core radius.
 */
export const NEBULA_RANGES = {
  /** Core radius in world units (the encounter radius). */
  radius: [240, 360],
  /** Number of layers (an integer). */
  layerCount: [4, 8],
  /** Layer half-size (half the side of its square), in radii. */
  layerSize: [1.9, 2.8],
  /** Largest distance of a layer centre from the nebula's axis, in radii. */
  layerOffset: [0.2, 0.5],
  /** Half the depth (along the path) the layers are spread over, in radii. */
  depthSpread: [1.0, 1.5],
  /** Largest tilt of a layer away from facing the path, in radians. */
  tilt: [0.05, 0.22],
  /** Base frequency of the cloud noise across a layer (a layer spans [-1, 1]). */
  noiseScale: [1.3, 2.2],
  /** Cloud noise octaves (an integer). */
  octaves: [4, 5],
  /** Domain-warp strength: higher gives more swirled, filamentary clouds. */
  warp: [0.5, 1.1],
  /** How much of each layer is cloud: higher fills more of it. */
  coverage: [0.45, 0.75],
  /** Brightness of the nebula's gas colour. */
  intensity: [0.55, 0.85],
  /** Per-layer factor on that brightness, so the layers differ a little (layer intensity = intensity × this). */
  layerIntensityJitter: [0.75, 1.1],
  /** How much a layer's densest gas covers what is behind it (the rest of its light is glow). */
  absorption: [0.45, 0.7],
  /** Brightness of the glowing core at the nebula centre. */
  core: [0.015, 0.04],
  /** Speed at which the clouds slowly churn, in noise units per second. */
  churn: [0.004, 0.012],
  /**
   * Shape: how elongated the cloud outline is (1 is round; the long axis is this times the short
   * one, at the same area), along a seeded axis `orientation` (radians, in the layer planes, shared
   * by every layer so the nebula reads as one elongated cloud).
   */
  elongation: [1, 2],
  orientation: [0, Math.PI],
  /** How ragged the outline is: how far the low-frequency warp pushes the cloud's edge around. */
  raggedness: [0.15, 0.5],
} as const;

/** Range for each component of a layer's noise-domain offset. */
export const NEBULA_NOISE_OFFSET_RANGE = [-100, 100] as const;

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
