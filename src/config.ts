/**
 * Tunable settings (docs/PLAN.md section 8: speeds, star count, DPR cap, timings, etc.).
 * Values other than the DPR cap are placeholders until the features that use them land.
 */

/** Upper bound on the device pixel ratio applied to the renderer (docs/PLAN.md section 6, Performance). */
export const DPR_CAP = 2;

/**
 * Camera vertical field of view in degrees, and clip planes in world units. Placeholders until the
 * starfield is tuned. The vertical field of view is CAMERA_FOV_DEG up to 21:9 and narrower beyond it
 * (VIEW_WIDEST_ASPECT, `cameraFovDeg` in engine/renderSize.ts); the live value is the camera's `fov`.
 */
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
 *
 * The sky has two layers. The STAR_* settings are the near layer: fine dust and near stars in a
 * wrapped cube around the camera, which streak with speed and give the sense of motion. They are
 * faint, small and nearly colourless dust, with an occasional brighter mote, and carry the speed
 * mostly through the length of their streaks, so they read as dust rushing past rather than as the
 * sky. The FAR_STAR_* settings below are the far layer: stars at effectively infinite distance,
 * which only turn with the camera, so they give a fixed backdrop that planets and nebulae are seen
 * against. The far stars are drawn brighter than the dust, with a subtle colour temperature, so they
 * read as the sky (docs/PLAN.md section 9, Phase 4: sky legibility).
 */

/** Number of near stars (one instanced quad each). */
export const STAR_COUNT = 8000;

/** Side `L` of the cube the stars live in, centred on the camera and wrapped as the ship moves. */
export const STAR_CUBE_SIZE = 1200;

/** Streak tail = head + ship velocity × this time, in seconds. Longer means longer streaks. */
export const STAR_STREAK_TIME_SECONDS = 0.06;

/** Star width in CSS pixels before the per-star size factor. A still star is a dot this wide. */
export const STAR_BASE_SIZE_PX = 1.4;

/** Range of the per-star size factor (multiplies STAR_BASE_SIZE_PX). Skewed toward the small end. */
export const STAR_SIZE_MIN = 0.7;
export const STAR_SIZE_MAX = 1.5;

/**
 * Range of the dust brightness, skewed toward the dim end. It is well below the far stars'
 * (FAR_STAR_BRIGHTNESS_*), and the shader dims it further with distance (STAR_DIM_DISTANCE).
 */
export const STAR_BRIGHTNESS_MIN = 0.1;
export const STAR_BRIGHTNESS_MAX = 0.4;

/**
 * The brightest STAR_MOTE_FRACTION of the near stars are brighter motes, from STAR_BRIGHTNESS_MAX up
 * to STAR_MOTE_BRIGHTNESS_MAX, so a few streaks still catch the eye at speed.
 */
export const STAR_MOTE_FRACTION = 0.04;
export const STAR_MOTE_BRIGHTNESS_MAX = 0.75;

/** How much of the star colour tints the dust keeps: 0 is grey, 1 the full tint. Mostly neutral. */
export const STAR_TINT_STRENGTH = 0.3;

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

/**
 * Far stars: directions on the unit sphere, drawn at infinity, so they have no parallax and never
 * move with the ship's travel, only with the camera's rotation. Always round dots (no streaks). About
 * 12% of them are in view at once (a 60° vertical field of view at 16:9), about 470.
 */
export const FAR_STAR_COUNT = 4000;

/** Far star width in CSS pixels before the per-star size factor. */
export const FAR_STAR_BASE_SIZE_PX = 1.4;

/** Range of the far stars' size factor (multiplies FAR_STAR_BASE_SIZE_PX). Skewed toward the small end. */
export const FAR_STAR_SIZE_MIN = 0.7;
export const FAR_STAR_SIZE_MAX = 2;

/**
 * Range of the far stars' brightness: min + (max - min) × u^FAR_STAR_BRIGHTNESS_EXPONENT for u
 * uniform in [0, 1). Skewed toward the faint end, with a heavier bright tail than the dust, so a few
 * stars stand out. Even the faintest is about as bright as typical dust before its distance dimming.
 */
export const FAR_STAR_BRIGHTNESS_MIN = 0.25;
export const FAR_STAR_BRIGHTNESS_MAX = 1;
export const FAR_STAR_BRIGHTNESS_EXPONENT = 2;

/** Seed for the far star layout. */
export const FAR_STAR_SEED = 0xfa7_5ea5;

/*
 * Distant galaxies (docs/PLAN.md section 6, Variety): a seeded handful of small, faint spiral and
 * elliptical galaxies on the far layer, drawn like the far stars (at infinity, turned by the camera's
 * rotation only). Unlike the far stars they come from the trip seed, so every trip has its own and a
 * shared seed replays them. Sizes are angles in the sky, so they stay the same whatever the field of
 * view or the canvas size.
 */

/**
 * Chance of a trip having 0, 1, 2 or 3 galaxies (index = count; the weights sum to 1). Mostly one or
 * two, so they stay rare enough to be a find.
 */
export const GALAXY_COUNT_WEIGHTS: readonly number[] = [0.15, 0.4, 0.3, 0.15];

/** Range of a galaxy's angular diameter along its major axis, in degrees. Skewed toward the small end. */
export const GALAXY_SIZE_MIN_DEG = 1.2;
export const GALAXY_SIZE_MAX_DEG = 3.5;

/** Share of the galaxies that are spirals (the rest are ellipticals). */
export const GALAXY_SPIRAL_SHARE = 0.65;

/**
 * Galaxies sit where the heading drift sweeps the view: within the yaw and pitch drift amplitudes
 * (SHIP_*_DRIFT_AMPLITUDE_RAD) of -Z, plus this margin, so each comes into view during a drift cycle.
 */
export const GALAXY_PLACEMENT_MARGIN_RAD = 0.25;

/** Smallest angle between two galaxies, in degrees, so they never overlap. */
export const GALAXY_MIN_SEPARATION_DEG = 10;

/**
 * Peak brightness of a galaxy's core glow, and of its disc (the arms or the oval falloff), before the
 * colour tint. Both well below the brighter far stars, so the galaxies read as faint, distant smudges.
 */
export const GALAXY_CORE_BRIGHTNESS_MIN = 0.3;
export const GALAXY_CORE_BRIGHTNESS_MAX = 0.5;
export const GALAXY_DISC_BRIGHTNESS_MIN = 0.12;
export const GALAXY_DISC_BRIGHTNESS_MAX = 0.2;

/*
 * Encounters (docs/PLAN.md section 6, Planets). An encounter plans a straight path along the heading
 * at the moment it starts, and places the planet beside it. Distances are in world units, measured
 * along that path from the point of closest approach: positive while approaching, negative after
 * passing. Values are first tunings until the autopilot and planets land.
 */

/**
 * Encounter interval (docs/PLAN.md section 9, Phase 2): seconds of cruise before each encounter
 * starts, counted from load and again from the end of each encounter. Above the arrival speed the
 * cruise also holds the return to warp at its start and the drop out of warp at its end (see
 * ENCOUNTER_ARRIVAL_SPEED); both count toward the interval, so the schedule is the same at every
 * speed level. The first planet appears as a distant dot this long after load, inside the 30–60 s
 * the plan asks for.
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
 * Most encounters of one kind in a row. Planets and asteroids are both solid bodies and count as one
 * run here, so this caps runs of nebulae and runs of solid bodies, and with them runs of every kind
 * (planet, nebula or asteroid). When the seeded draw would make one more, the encounter is the other
 * class instead; the draw is biased to compensate, so the long-run share of nebulae is still
 * ENCOUNTER_NEBULA_SHARE. Ignored when every encounter is forced to one kind.
 */
export const ENCOUNTER_MAX_SAME_KIND_RUN = 3;

/**
 * Side of the path (docs/PLAN.md section 9, Phase 3): each encounter's object sits to the
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

/**
 * Dropping out of warp (docs/PLAN.md section 1: cruise is the screensaver, an encounter is the
 * exploration). Every encounter is flown as if the cruise speed were at most this arrival speed, in
 * units per second: `setCruiseSpeed` scales the encounter speed profile for min(cruise speed, arrival
 * speed), so at every speed level at or above the default the encounter, from its spawn to its end,
 * has exactly the default level's speed profile, and the slower levels (the reduced-motion start)
 * keep theirs. It is the default level's cruise speed (checked in Autopilot.test.ts).
 *
 * Above the arrival speed, the target speed eases (smoothstep) from the cruise speed down to the
 * arrival speed over ENCOUNTER_WARP_EXIT_SECONDS at the end of the cruise, and that ease ends
 * ENCOUNTER_WARP_EXIT_LEAD_SECONDS before the encounter starts. The ship lags its target by about
 * SHIP_SPEED_TAU_SECONDS, so the lead lets the lag settle: from the top speed the ship is within
 * about 3 units per second of the arrival speed at the spawn, and within 0.5 when the object
 * reaches opacity 0.1 (the spawn bound is checked in Autopilot.test.ts, the opacity bound in both
 * Autopilot.test.ts and EncounterView.test.ts). After the encounter, the target eases back
 * up to the cruise speed over ENCOUNTER_WARP_ENTRY_SECONDS at the start of the next cruise (the first
 * cruise, from load, starts at the cruise speed: the ship accelerates from rest). All
 * three are cruise time, so they count toward the encounter interval. A cruise too short for them (an
 * interval below their sum, as in tests) never reaches the full cruise speed, and is still back at
 * the arrival speed ENCOUNTER_WARP_EXIT_LEAD_SECONDS before the encounter starts.
 */
export const ENCOUNTER_ARRIVAL_SPEED = 60;
export const ENCOUNTER_WARP_EXIT_SECONDS = 10;
export const ENCOUNTER_WARP_EXIT_LEAD_SECONDS = 3;
export const ENCOUNTER_WARP_ENTRY_SECONDS = 8;

/**
 * Speed driven by visibility (docs/PLAN.md section 9, Phase 4): after the closest approach, an
 * encounter ends as soon as its object is out of view, and the ship eases straight back into warp,
 * instead of crawling on to the despawn distance with the object already behind the camera.
 *
 * "Out of view" is a pure function of the simulation state (the ship's position and heading and the
 * encounter plan) and the base vertical field of view (CAMERA_FOV_DEG), never of the browser's
 * viewport. Up to VIEW_WIDEST_ASPECT (width / height), 21:9, the vertical field of view is fixed, so
 * a wider screen only shows more at the sides. Beyond it the engine narrows the vertical field of
 * view so the horizontal one stays at the 21:9 one (`cameraFovDeg` in engine/renderSize.ts: a wider
 * screen shows less at the top and bottom instead). The autopilot tests against the cone around the
 * camera's forward axis that contains the whole view at 21:9 (its half-angle reaches the view's
 * corners, about 55.7°; `viewConeHalfAngle`), which contains the view at every other aspect ratio
 * too, so an object outside it is off-screen on every screen, whatever the camera's roll. The
 * criterion for each kind:
 *
 * - A planet is out of view once the sphere of radius `radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`,
 *   which holds everything drawn for it (the atmosphere shell included, see Planets below), lies
 *   wholly outside the cone. With `k` from 1.6 to 6 that is from a few units after the closest
 *   approach to well before it, so a planet encounter ends at or just after the closest approach.
 * - A nebula is large and soft, and its layers reach across the path, so it is out of view only once
 *   every layer lies behind the camera: the ship is past the farthest any layer reaches along the path
 *   (`nebulaViewExtent`, a bound drawn from NEBULA_RANGES in core radii), and the heading has not
 *   turned so far back that the cone could reach behind (checked from the heading, so it holds while
 *   the drift resumes).
 *
 * Until then the target speed is exactly the distance-based profile it always was, so while the object
 * is in view the ship is never faster than before. The encounter interval still counts the cruise
 * from the end of each encounter, which now comes sooner: the schedule (each encounter's kind, side
 * and cruise length) is unchanged, only the wall time between encounters is shorter.
 *
 * The next cruise eases the target up from the speed the encounter ended at (near the minimum speed)
 * with the warp entry ease above, over ENCOUNTER_WARP_ENTRY_SECONDS, stretched where needed so its
 * slope never exceeds ENCOUNTER_WARP_ENTRY_MAX_RATE (units per second per second): about the slope of
 * the return from the arrival speed to the top level (1.5 × 90 / 8 ≈ 16.9), so returning from the
 * minimum speed is never steeper than the return to warp was. At the slowest level (the reduced-motion
 * start) the return is from 4 to 20 units per second, a slope of at most 3. The heading drift resumes
 * from where the encounter left it over ENCOUNTER_DRIFT_SETTLE_SECONDS.
 */
export const VIEW_WIDEST_ASPECT = 21 / 9;
export const ENCOUNTER_WARP_ENTRY_MAX_RATE = 17;

/** Remaining distance to the closest approach at which APPROACH becomes FLYBY. */
export const ENCOUNTER_FLYBY_DISTANCE = 300;

/** Planet radius in world units. A fixed placeholder until seeded planet parameters land. */
export const ENCOUNTER_PLANET_RADIUS = 48;

/**
 * The test default trip seed. Encounter `i` of a trip uses the appearance seed `hash(tripSeed, i)`.
 * In production the trip seed is random on each load, or taken from `?seed=` (src/tripSeed.ts).
 * This value is the default of `DEFAULT_AUTOPILOT_PARAMS.baseSeed` and of `EngineOptions.tripSeed`,
 * and the e2e suite passes it as `?seed=91b3a5ba`, so tests stay deterministic. It is chosen for its
 * opening: an oceanic planet first, then a nebula, then another planet and another nebula (and an
 * asteroid fifth, at index 4: the asteroid draw, ENCOUNTER_ASTEROID_SHARE, leaves the first four as
 * they were). Every
 * trip seed starts with a planet (`encounterKindAt`) within the 30–60 s of docs/PLAN.md section 9,
 * Phase 2 (see ENCOUNTER_INTERVAL_JITTER).
 */
export const ENCOUNTER_BASE_SEED = 0x91b3_a5ba;

/**
 * `D`: the planet is placed this far ahead along the heading when the encounter starts, so it is
 * also the spawn distance. Kept well inside CAMERA_FAR. A planet keeps its world size for the whole
 * encounter, so this and the planet radii (PLANET_ROCKY_RANGES, PLANET_GAS_RANGES, PLANET_ICY_RADIUS)
 * set how small it first appears: at spawn a median planet's disc spans under 3.5% of the view
 * height and the largest under 9% (about 37 and 97 px at 1080p), and the widest ring, thin and
 * translucent, under 23%; it fades in from opacity 0 there (checked in Planet.test.ts). At the default speed level and above
 * (every level at or above the arrival speed) the spawn is about 54 s before the closest approach.
 */
export const ENCOUNTER_DISTANCE = 2400;

/**
 * `k`: the planet centre sits `radius × k` to the side of the path, which is the closest approach.
 * The default for a planet that brings no pass factor of its own (`PlanetSpec.passFactor`); every
 * seeded planet does (PLANET_PASS_FACTOR_RANGE).
 */
export const ENCOUNTER_SIDE_OFFSET_FACTOR = 2;

/**
 * Required clearance: the closest approach to the centre must be at least `radius × (1 + margin)`,
 * so ENCOUNTER_SIDE_OFFSET_FACTOR must stay above 1 + this margin and the path never meets the sphere.
 * A ringed planet needs `radius × ring outer radius × (1 + margin)` (`planetPassFactor` in
 * engine/Autopilot.ts), so the path never comes near the ring either.
 */
export const ENCOUNTER_CLEARANCE_MARGIN = 0.25;

/**
 * Speed profile. The target speed is the cruise speed until ENCOUNTER_SLOWDOWN_DISTANCE before the
 * closest approach, then eases down to ENCOUNTER_MIN_SPEED (units per second), which it holds within
 * ENCOUNTER_MIN_SPEED_DISTANCE either side of the closest approach, then eases back up to cruise over
 * ENCOUNTER_SPEEDUP_DISTANCE. The ship follows it through its exponential speed approach
 * (SHIP_SPEED_TAU_SECONDS), so it lags the target speed, most at the top speed (see below).
 *
 * The minimum speed and its band are tuned for the planet radii: the closest approach is
 * `radius × k`, so how fast the planet sweeps past in angle there is the speed over that distance.
 * At the default speed level the Phase 3 median planet (radius about 41, k = 2) peaks at about
 * 4.4°/s, and the ship reaches the closest approach about 54 s after the spawn (both checked in
 * EncounterView.test.ts). Seeded planets vary their radius and k, and pass at least
 * PLANET_MIN_PASS_DISTANCE from the path: none peaks above about 5°/s, under the 5.1°/s guard.
 * Faster levels drop to the arrival speed before the spawn (ENCOUNTER_ARRIVAL_SPEED), so they fly
 * this same profile and the same flyby. The slowdown and speed-up distances are not scaled down with
 * the radii: the ship needs that distance to slow down from the arrival speed within a few time
 * constants.
 */
export const ENCOUNTER_MIN_SPEED = 6;
/**
 * Lowest planet minimum speed (units per second) at any speed level. `setCruiseSpeed` scales
 * ENCOUNTER_MIN_SPEED with the cruise speed, which would make it 2 at the slowest level (the
 * reduced-motion start): one encounter would take about 350 s, about 69 s of it in FLYBY. With this
 * floor it took about 285 s, about 44 s in FLYBY, and a median planet peaks at about 2.8°/s, as it
 * did before the planets were made smaller; ending once the planet is out of view (see
 * VIEW_WIDEST_ASPECT) brings it down to about 153 s. Nebulae have their own floor
 * (NEBULA_MIN_SPEED_FLOOR).
 */
export const ENCOUNTER_MIN_SPEED_FLOOR = 4;
export const ENCOUNTER_SLOWDOWN_DISTANCE = 520;
export const ENCOUNTER_MIN_SPEED_DISTANCE = 16;
export const ENCOUNTER_SPEEDUP_DISTANCE = 800;

/**
 * Fade. From the spawn distance (the encounter's `D`, ENCOUNTER_DISTANCE by default), opacity eases
 * up from 0 to 1 over ENCOUNTER_FADE_IN_DISTANCE. The planet's size does not change (its spawn scale
 * is 1, as for nebulae), so it starts as a distant dot because it is far away, and grows on screen by
 * perspective alone. After passing, opacity eases back down to 0 over ENCOUNTER_FADE_OUT_DISTANCE,
 * reaching 0 at ENCOUNTER_DESPAWN_DISTANCE past the closest approach, where DEPARTURE ends at the
 * latest; in practice a planet encounter ends once the planet is out of view (VIEW_WIDEST_ASPECT),
 * shortly after the closest approach, and the planet is removed unseen before it fades. The fade
 * distances are long enough that at the top cruise speed one capped frame changes opacity by less
 * than 2%.
 */
export const ENCOUNTER_FADE_IN_DISTANCE = 1200;
export const ENCOUNTER_FADE_OUT_DISTANCE = 1200;
export const ENCOUNTER_DESPAWN_DISTANCE = 1500;

/*
 * Planets (docs/PLAN.md section 6, Planets). `planetParams(seed)` in engine/Planet.ts draws every
 * value below from an encounter's appearance seed. Ranges are inclusive `[min, max]` pairs; radii are
 * in world units, angles in radians, speeds in radians per second, and noise values are in the
 * units of a unit sphere (the shared planet geometry).
 *
 * Radii stay compatible with the encounter plan: every planet is small next to the spawn distance
 * ENCOUNTER_DISTANCE, so it starts small at its full size (see ENCOUNTER_DISTANCE for the bounds);
 * and the atmosphere shell (`radius × (1 + thickness)`) stays inside the clearance
 * `radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`, so the camera never enters it. ENCOUNTER_PLANET_RADIUS
 * lies inside the combined radius range.
 *
 * Variety (docs/PLAN.md section 9, Phase 4): radii span 13–110, and each planet brings its own pass
 * factor `k` (PLANET_PASS_FACTOR_RANGE), so the closest approach `radius × k` and the planet's
 * angular diameter there, `2 asin(1 / k)`, differ from one planet to the next. Some gas giants and a
 * few rocky worlds have rings (PLANET_RING_SHARE), and some rocky worlds are icy dwarfs
 * (PLANET_ICY_SHARE). The values are drawn from a second seeded stream after all of the Phase 3
 * ones, so every planet keeps its Phase 3 type, family and colours, and an icy dwarf replaces only
 * its family's look.
 *
 * Measured over 20,000 seeds (Planet.test.ts and EncounterView.test.ts check the bounds): radius
 * p10/p50/p90 about 19/45/95; k p10/p50/p90 about 1.75/3.3/5.3; the closest approach at least 75, its
 * median about 123; the angular diameter at the closest approach p10/p50/p90 about 21.8°/35.5°/69.8°,
 * a p90/p10 ratio of about 3.2 (at least 3 is required); 16% of planets ringed, 11% icy dwarfs.
 */

/** Share of planets that are gas giants; the rest are rocky. */
export const PLANET_GAS_SHARE = 0.45;

/**
 * Pass factor `k` range (log-uniform), and the smallest closest approach in world units. A planet's
 * `k` is drawn log-uniformly from `[max(min, PLANET_MIN_PASS_DISTANCE / radius, ring clearance), max]`,
 * so small planets pass at a large `k` and look small, and large ones can pass anywhere from close
 * (77° across at k = 1.6) to far off (19° at k = 6). The floor on the distance bounds the bearing
 * rate: at the default level the ship passes the closest approach at about 6.3 units per second, so a
 * planet at the floor sweeps past at 6.3 / 75 rad/s, about 4.7°/s, and no planet (whatever its
 * distance; a far one peaks while the ship is still slowing) faster than about 5°/s, inside the
 * Phase 3 guard of 5.1°/s (EncounterView.test.ts). The ring clearance is
 * `ring outer radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`.
 * The upper end keeps every planet at least 19° across at its closest approach.
 */
export const PLANET_PASS_FACTOR_RANGE = [1.6, 6] as const;
export const PLANET_MIN_PASS_DISTANCE = 75;

/**
 * Skew of the `k` draw toward close passes: `k = low × (max / low)^(u^skew)` for a uniform roll `u`
 * (`passFactorFor` in engine/Planet.ts), so 1 is log-uniform. Small planets have a narrow range of
 * `k` anyway (they pass near the distance floor, at a large `k`); for the large ones, which can pass
 * at any `k`, 2 makes the median about 2.2 and still puts one in ten beyond 4.6. Log-uniform would
 * spread the angular diameters at the closest approach only about 2.6× from p10 to p90.
 */
export const PLANET_PASS_FACTOR_SKEW = 2;

/** Share of rocky planets that are icy dwarfs (Pluto-like: small, pale, nitrogen-ice plains, dark patches, craters). */
export const PLANET_ICY_SHARE = 0.2;

/** Icy dwarf radius range; it replaces the rocky one. At least PLANET_MIN_PASS_DISTANCE / k max. */
export const PLANET_ICY_RADIUS = [13, 24] as const;

/** Share of planets of each type that have a ring system. */
export const PLANET_RING_SHARE = { gas: 0.3, rocky: 0.05 } as const;

/**
 * Ring parameter ranges, in planet radii where a length. The ring is a flat annulus in the planet's
 * equatorial plane, which a ringed planet turns toward the encounter (see `opening` and `roll`).
 */
export const PLANET_RING_RANGES = {
  /** Inner edge. Well outside the thickest atmosphere shell (1 + PLANET_GAS_RANGES.atmosphereThickness). */
  inner: [1.3, 1.65],
  /** Width; the outer edge is inner + width. */
  width: [0.45, 1.05],
  /** Peak opacity of the densest ringlets. */
  opacity: [0.55, 0.9],
  /** Ringlet cycles across the ring's width. */
  bands: [7, 22],
  /** Offset into the ringlet noise. */
  bandOffset: [0, 100],
  /** Where the main gap lies across the ring (0 inner edge, 1 outer edge), and its width (same units). */
  gap: [0.4, 0.75],
  gapWidth: [0.02, 0.07],
  /**
   * Tilt of the ring plane toward the ship as it approaches, in radians: 0 would show the ring
   * edge-on along the path. Seen from the spawn, the ring opens by about this angle.
   */
  opening: [0.3, 0.6],
  /**
   * Tilt of the ring plane about the path, in radians, either way: 0 would show the ring edge-on at
   * the closest approach.
   */
  roll: [0.18, 0.45],
} as const;

/** Parameter ranges for rocky planets. */
export const PLANET_ROCKY_RANGES = {
  radius: [16, 50],
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
  radius: [44, 110],
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

/**
 * Segments around a ring's annulus geometry (one per ringed planet, freed with it). Its edges are
 * chords, so its outer edge lies within the outer radius (the planet's extent) and the fragment
 * shader trims the inner edge to the true circle.
 *
 * Encounter-time resources: a ringed planet holds one geometry and one material more than a plain
 * one (this annulus, 322 vertices and 640 triangles with both windings, and the ring material), and
 * no program more (the ring draws with the atmosphere's program, kept compiled by ProgramWarmup), so
 * a planet encounter holds at most 2 geometries and 3 materials of its own; all are freed with the planet,
 * and the counts at cruise are unchanged (longRun.test.ts, e2e/rings.spec.ts).
 */
export const PLANET_RING_SEGMENTS = 160;

/*
 * Nebulae (docs/PLAN.md section 6, Nebulae (Phase 3)): layered, soft-blended planes shaded with a
 * cheap fBm fragment shader. An encounter is a planet, a nebula or an asteroid (see Asteroids below), chosen from the encounter's
 * appearance seed `hash(tripSeed, index)` (see ENCOUNTER_BASE_SEED). Nebula encounters use the same planned-path
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
 * the wisps keep streaming past while the ship drifts through them. Like a planet encounter, a nebula
 * encounter is flown from the arrival speed at the faster levels (ENCOUNTER_ARRIVAL_SPEED), so at the
 * default level and the top level alike it slows to this minimum speed of 24, and a median nebula
 * encounter lasts about 79 s from its spawn to its end, once every layer is behind the camera (see
 * VIEW_WIDEST_ASPECT; about 88 s when it ran on to the despawn distance).
 */
export const NEBULA_MIN_SPEED = 24;
/** Lowest nebula minimum speed at any speed level (see ENCOUNTER_MIN_SPEED_FLOOR). */
export const NEBULA_MIN_SPEED_FLOOR = 10;
export const NEBULA_SLOWDOWN_DISTANCE = 1200;
export const NEBULA_MIN_SPEED_DISTANCE = 120;
export const NEBULA_SPEEDUP_DISTANCE = 600;

/**
 * Nebula fade (see the planet one above). Like a planet, a nebula keeps its size (its spawn scale is
 * 1): it is far beyond the star cube when it spawns and fades in from opacity 0. The despawn distance
 * is shortly after every layer is behind the camera; the encounter ends sooner, as soon as every
 * layer is (see VIEW_WIDEST_ASPECT).
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
 * Asteroids (docs/PLAN.md section 6, Variety, and section 9, Phase 4): a close pass by something
 * small and irregular. `asteroidParams(seed)` in engine/Asteroid.ts draws every value below from an
 * encounter's appearance seed. An asteroid encounter is one rock, or a small field of
 * ASTEROID_RANGES.fieldCount rocks of different sizes around a main rock. Each rock is a seeded,
 * noise-displaced low-poly sphere (`irregularBodyGeometry`: lumps, an elongated potato shape and a
 * few craters) that tumbles slowly about a seeded axis, and is shaded with the rocky planet surface
 * program, so asteroids add no shader program.
 *
 * Schedule: the planet-or-nebula draw (ENCOUNTER_NEBULA_SHARE, ENCOUNTER_MAX_SAME_KIND_RUN) is
 * unchanged, and a second seeded draw, from a stream of its own, turns some of the planets into
 * asteroids, so ENCOUNTER_ASTEROID_SHARE of all encounters are asteroids in the long run: the nebula
 * share stays 0.35, and the planet share goes from 0.65 to 0.5 (planets to nebulae from 65:35 to
 * 50:35). Every nebula stays where it was in every trip, and every planet that stays a planet keeps
 * its look. The first encounter of every trip is still a planet.
 *
 * Plan: the encounter radius is the field's bounding radius (a sphere about the field centre holding
 * every rock, `AsteroidParams.radius`), and the path passes at least `radius × (1 +
 * ENCOUNTER_CLEARANCE_MARGIN)` from that centre, so it never enters the field's sphere, and every
 * rock's centre at least ASTEROID_MIN_PASS_DISTANCE from the path (the rocks are laid out in the
 * encounter's own frame, so their distances from the path are known when it is planned). The
 * out-of-view test uses the same sphere.
 *
 * Measured over 2,000 seeds (Asteroid.test.ts checks the bounds): half are fields; the main rock's
 * radius p10/p50/p90 about 4.8/7.9/11.2 (every rock smaller than the smallest planet), the field's
 * bounding radius 5.5/11.9/33.4 (51.5 at most); the closest approach to the field centre
 * 31/41/57, and of each rock's centre 32/46/67 (never under ASTEROID_MIN_PASS_DISTANCE; a planet
 * passes at least 75 off); the main rock 13°/21°/35° across at its closest approach. At the default
 * level an asteroid encounter lasts about 67–71 s from its spawn and ends at its closest approach or
 * within about 4 s of it, once the field is out of view (about 148–153 s at the slowest level).
 */

/** Share of all encounters that are asteroids, in the long run (see the section comment). */
export const ENCOUNTER_ASTEROID_SHARE = 0.15;

/** Bounds the asteroid share over any 1,000 consecutive encounter indices must stay within. */
export const ENCOUNTER_ASTEROID_SHARE_BOUNDS = [0.1, 0.2] as const;

/**
 * `D` for asteroids: the field centre is placed this far ahead, which is also the spawn distance.
 * Closer than for planets: a rock is small (the largest main rock, 24 across, is under 0.9° across
 * from here, about 16 px at 1080p), so it still starts as a dot.
 */
export const ASTEROID_ENCOUNTER_DISTANCE = 1600;

/**
 * `k` for an asteroid that brings no pass factor of its own (`AsteroidSpec.passFactor`); every
 * seeded asteroid does.
 */
export const ASTEROID_SIDE_OFFSET_FACTOR = 3;

/**
 * Smallest distance between the path and any rock's centre, in world units: closer than any planet
 * (PLANET_MIN_PASS_DISTANCE), which bounds the bearing rate at the asteroid minimum speed (see below).
 */
export const ASTEROID_MIN_PASS_DISTANCE = 30;

/**
 * The closest approach to the field centre is the lowest one that keeps the path clear (see the
 * section comment) times `1 + ASTEROID_PASS_EXTRA × u²` for a uniform roll `u`, so most pass close.
 */
export const ASTEROID_PASS_EXTRA = 0.6;

/**
 * Asteroid speed profile (see the planet one, ENCOUNTER_MIN_SPEED). The rocks pass much closer than
 * planets, so the ship slows further: a rock's bearing rate peaks at the ship's speed over its
 * distance from the path, and at ASTEROID_MIN_PASS_DISTANCE the minimum speed sweeps it past at about
 * 4.6°/s, under the 5.1°/s guard (checked in Asteroid.test.ts for every rock of 2,000 seeded fields).
 * The minimum speed is held within ASTEROID_MIN_SPEED_DISTANCE of the closest approach, wider than
 * a field reaches along the path (ASTEROID_RANGES), so every rock of a field passes at it. Like the
 * other kinds, an asteroid encounter is flown from the arrival speed at the faster levels.
 */
export const ASTEROID_MIN_SPEED = 2.4;
/** Lowest asteroid minimum speed at any speed level (see ENCOUNTER_MIN_SPEED_FLOOR). */
export const ASTEROID_MIN_SPEED_FLOOR = 2;
export const ASTEROID_SLOWDOWN_DISTANCE = 560;
export const ASTEROID_MIN_SPEED_DISTANCE = 40;
export const ASTEROID_SPEEDUP_DISTANCE = 800;

/**
 * Asteroid fade (see the planet one). An asteroid encounter ends once the field is out of view, a
 * little after the closest approach, so the fade-out is not seen.
 */
export const ASTEROID_FADE_IN_DISTANCE = 1200;
export const ASTEROID_FADE_OUT_DISTANCE = 1000;
export const ASTEROID_DESPAWN_DISTANCE = 1200;

/** Share of asteroid encounters that are a field of several rocks; the rest are one rock. */
export const ASTEROID_FIELD_SHARE = 0.5;

/**
 * Parameter ranges for `asteroidParams(seed)` in engine/Asteroid.ts (inclusive `[min, max]` pairs).
 * A rock's radius is its bounding radius: every vertex of its geometry lies within it.
 */
export const ASTEROID_RANGES = {
  /** Main rock radius, in world units. */
  radius: [4, 12],
  /** Rocks in a field, the main rock included (an integer). */
  fieldCount: [3, 7],
  /** A field's other rocks' radii, in main-rock radii. */
  satelliteRadius: [0.2, 0.5],
  /**
   * How far a field's other rocks' centres lie from the main rock's, along the path, in main-rock
   * radii (at most this; their offsets toward the side and up are at most 0.75 and 0.6 of it).
   */
  spread: [2.2, 3.3],
  /** A rock's shorter axes, as fractions of its longest (an elongated, potato-like shape). */
  axisB: [0.55, 0.85],
  axisC: [0.4, 0.7],
  /** Amplitude of the low-frequency lumps on a rock, as a fraction of its radius. */
  lumpiness: [0.26, 0.4],
  /** Craters in a rock's shape (an integer), and their angular radius on it, in radians. */
  craterCount: [3, 6],
  craterSize: [0.3, 0.75],
  /** Tumble speed about the rock's seeded axis, in radians per second. */
  tumbleSpeed: [0.05, 0.2],
  /** Surface shading (the rocky planet shader's terrain, see PLANET_ROCKY_RANGES). */
  noiseScale: [1.6, 2.8],
  octaves: [5, 6],
  warp: [0.2, 0.6],
  relief: [0.8, 1.4],
  craters: [0.35, 0.75],
} as const;

/**
 * Icosphere detail (`IcosahedronGeometry`'s) of the main rock and of a field's other rocks: 812 and
 * 162 vertices, 1,620 and 320 triangles. Low-poly on purpose: the silhouette shows facets, and the
 * surface shader adds the fine detail.
 *
 * Encounter-time resources: one geometry, one material and one draw call per rock (at most 7 each
 * for a field; a single rock 1), all freed with the encounter, and no program of its own (the rocks
 * draw with the rocky planet surface program, kept compiled by ProgramWarmup), so the counts at
 * cruise are unchanged (longRun.test.ts, e2e/asteroid.spec.ts).
 */
export const ASTEROID_DETAIL = { main: 8, satellite: 3 } as const;

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
