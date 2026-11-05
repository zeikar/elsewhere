/**
 * Tunable settings (docs/PLAN.md section 8: speeds, star count, DPR cap, timings, etc.).
 * Values other than the DPR cap are placeholders until the features that use them land.
 */

/** Upper bound on the device pixel ratio applied to the renderer (docs/PLAN.md section 6, Performance). */
export const DPR_CAP = 2;

/**
 * Camera vertical field of view in degrees, and clip planes in world units. The vertical field of
 * view is CAMERA_FOV_DEG up to 21:9 and narrower beyond it (VIEW_WIDEST_ASPECT, `cameraFovDeg` in
 * engine/renderSize.ts); the live value is the camera's `fov`.
 *
 * Depth precision: the encounter objects spawn far out (ENCOUNTER_DISTANCE, 8,000), and a 24-bit
 * depth buffer resolves about z² / (CAMERA_NEAR × 2²⁴) world units at distance z: about 3.8 units
 * at 8,000 with the near plane at 1 (it was 38 with 0.1, more than the 11-unit gap, at the least,
 * between a ring's far side and the disc in front of it, so the far side could show through). The
 * surface, its atmosphere shell and its ring never meet, and the shell and the ring's near side lie
 * strictly in front of the disc, so the depth order, which the quantisation keeps, is always right;
 * only the ring's far side needs the gap to be several steps (Planet.test.ts, e2e/rings.spec.ts).
 * Nothing drawn comes within 1 unit of the camera: the near dust fades out over the
 * STAR_NEAR_FADE_DISTANCE units beyond the near plane's distance, so a mote is gone as its head
 * reaches the plane in the middle of the view and is at most about 10% bright where it does in a
 * corner, and its streaks are clipped to the plane; nebula layers are hidden within
 * NEBULA_NEAR_FADE_MIN_DISTANCE, and every object is passed at a clearance of more than 10 units. The far stars and galaxies are drawn at infinity, before everything else and with
 * no depth writes, so the encounter objects, all inside CAMERA_FAR, paint over them.
 */
export const CAMERA_FOV_DEG = 60;
export const CAMERA_NEAR = 1;
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

/**
 * Frame-rate cap (docs/PLAN.md section 6, Performance), in frames per second: the engine draws at
 * most about this many frames a second, measured by the frame clock (engine/FrameCap.ts), so a
 * 120 Hz display draws every other frame. The motion here is slow enough that more frames show
 * nothing more, and each frame's GPU work (a planet's surface across much of a Retina screen) is the
 * cost. The simulation stays real time: each drawn frame steps it by the real time since the last.
 * 0 means no cap.
 */
export const FRAME_RATE_CAP = 60;

/**
 * How early, in milliseconds, a display frame may come and still be drawn under the cap: rAF
 * timestamps jitter, so a 60 Hz display (59.9 Hz or 60.1 Hz too) draws every frame rather than
 * dropping to 30. Well under the 8.3 ms of a 120 Hz frame, so there every other one is skipped.
 */
export const FRAME_CAP_TOLERANCE_MS = 2;

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
 * units before the camera's near plane (CAMERA_NEAR), so none is cut off by it while visible.
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
 * Most encounters of one kind in a row. Planets, asteroids and comets are all solid bodies and count
 * as one run here, so this caps runs of nebulae and runs of solid bodies, and with them runs of every
 * kind (planet, nebula, asteroid or comet). When the seeded draw would make one more, the encounter is the other
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
 * speed), so at every speed level at or above the default the encounter, from the end of its far
 * stretch (ENCOUNTER_FAR_SPEED) to its end, has exactly the default level's speed profile, and the
 * slower levels (the reduced-motion start) keep theirs. It is the default level's cruise speed
 * (checked in Autopilot.test.ts).
 *
 * Above the arrival speed, the target speed eases (smoothstep) from the cruise speed down to the
 * hand-over speed over ENCOUNTER_WARP_EXIT_SECONDS at the end of the cruise, and that ease ends
 * ENCOUNTER_WARP_EXIT_LEAD_SECONDS before the encounter starts. The hand-over speed is the arrival
 * speed before a nebula or an object already too large at its spawn for a far stretch, and
 * otherwise the speed the far stretch can fly on from (`farHandoverSpeed`): at the top level the
 * cruise speed itself for most planets, asteroids and comets, which then drop out of warp on their
 * far stretch instead. The ship lags its target by about SHIP_SPEED_TAU_SECONDS, so the lead lets the
 * lag settle: from the top speed the ship is within about 3 units per second of the hand-over speed
 * at the spawn, and within 0.5 of the arrival speed when a nebula reaches opacity 0.1 or a solid body
 * leaves its far stretch (checked in Autopilot.test.ts, the far stretch in EncounterView.test.ts and
 * e2e/warp.spec.ts too). After the encounter, the target eases back
 * up to the cruise speed at the start of the next cruise: quickly once the object has left the screen
 * (ENCOUNTER_VIEW_ENTRY_SECONDS, see VIEW_WIDEST_ASPECT), over ENCOUNTER_WARP_ENTRY_SECONDS otherwise
 * (the first cruise, from load, starts at the cruise speed: the ship accelerates from rest). All
 * three are cruise time, so they count toward the encounter interval. A cruise too short for them (an
 * interval below their sum, as in tests) never reaches the full cruise speed, and is still back at
 * the hand-over speed ENCOUNTER_WARP_EXIT_LEAD_SECONDS before the encounter starts.
 */
export const ENCOUNTER_ARRIVAL_SPEED = 60;
export const ENCOUNTER_WARP_EXIT_SECONDS = 10;
export const ENCOUNTER_WARP_EXIT_LEAD_SECONDS = 3;
export const ENCOUNTER_WARP_ENTRY_SECONDS = 8;

/**
 * Speed driven by visibility (docs/PLAN.md section 9, Phase 4): an encounter's slow phase ends as
 * soon as its object is wholly off the screen, before or after the closest approach, and the ship
 * returns quickly to warp, instead of crawling on with the object already gone from the screen.
 *
 * "Off the screen" is tested against the live camera view (`AutopilotParams.view`, a `ViewFrustum`
 * from `cameraFrustum` in engine/renderSize.ts): the infinite pyramid along the heading, with world +Y
 * up as the camera's `lookAt` sets it, bounded by its four side planes at the screen's aspect ratio
 * and the camera's vertical field of view. Up to VIEW_WIDEST_ASPECT (width / height), 21:9, the
 * vertical field of view is CAMERA_FOV_DEG and a wider screen shows more at the sides; beyond it the
 * engine narrows the vertical field of view so the horizontal one stays at the 21:9 one
 * (`cameraFovDeg`: a wider screen shows less at the top and bottom instead). The engine replaces the
 * view on every resize, so encounter timing depends on the screen's shape: a shared trip seed replays
 * the same encounters in the same order, but not frame-identical timing. Until the engine reports
 * the screen the autopilot assumes VIEW_DEFAULT_ASPECT, 16:9, which is also what the tests use. The
 * criterion for each kind (`encounterViewMargin`; a new kind names its own bounding spheres):
 *
 * - A planet is off the screen once the sphere of radius `radius × (1 + ENCOUNTER_CLEARANCE_MARGIN)`,
 *   which holds everything drawn for it (the atmosphere shell included, see Planets below), or the
 *   ring's sphere, lies wholly outside the view (`frustumSphereMargin`, exact past the corners too).
 *   A planet passed far to the side or above often leaves before its closest approach.
 * - An asteroid, once the sphere that bounds its field does.
 * - A comet, once the spheres that hold its coma and every stretch of both tails (`CometSpec.bounds`)
 *   all do; its tails trail back and away from the path, so it leaves with its coma (see Comets).
 * - A nebula is large and soft, and its layers reach across the path, so it is off the screen only
 *   once every layer lies behind the camera: the ship is past the farthest any layer reaches along the
 *   path (`nebulaViewExtent`, a bound drawn from NEBULA_RANGES in core radii), and the heading has not
 *   turned so far back that the view could reach behind (checked from the heading against the cone
 *   around the view, so it holds while the drift resumes).
 *
 * The heading is held from the end of the cruise to the closest approach, and moving forward along a
 * held heading never brings an object back into the view, so an object once off screen would stay
 * off; it is removed then. Until then the target speed is exactly the distance-based profile it
 * always was, so while the object is on screen the ship is never faster than before. The encounter
 * interval still counts the cruise from the end of each encounter, which now comes sooner: the
 * schedule (each encounter's kind, side and cruise length) is unchanged, only the wall time between
 * encounters is shorter.
 *
 * The next cruise returns to warp with the quick entry: the ship's speed itself eases from the speed
 * and acceleration it had when the encounter ended up to the cruise speed (a quintic curve: a
 * smootherstep from rest, with no step in speed or acceleration and a bounded jerk), over
 * ENCOUNTER_VIEW_ENTRY_SECONDS, stretched where needed so the ship's acceleration never exceeds
 * ENCOUNTER_VIEW_ENTRY_MAX_RATE (units per second per second); the target leads it by the ship's
 * speed lag (SHIP_SPEED_TAU_SECONDS), so the lag does not slow it down. Measured over the default test
 * seed's first 20 planets at 16:9, 4:3, 21:9 and 32:9 (Autopilot.test.ts checks the limits): the ship
 * is at 50% of the cruise speed within 1.9 s of the planet leaving the screen and at 90% within 3 s at
 * the slowest and the default level (limits 2.5 s and 5 s; it took up to 41 s and 52 s before), and
 * within 3.3 s and 5.1 s at the top level (limits 4 s and 7 s); its acceleration peaks at about 7.5,
 * 25 and 40 at the three levels. An encounter that instead ran to its despawn distance (nothing left
 * on screen to leave) is followed by the gentle entry, over ENCOUNTER_WARP_ENTRY_SECONDS, stretched
 * so its slope never exceeds ENCOUNTER_WARP_ENTRY_MAX_RATE. The heading drift resumes from where the
 * encounter left it over ENCOUNTER_DRIFT_SETTLE_SECONDS, only once the object is gone.
 */
export const VIEW_WIDEST_ASPECT = 21 / 9;
export const ENCOUNTER_WARP_ENTRY_MAX_RATE = 17;
/** Aspect ratio of the view the autopilot assumes until the engine reports the screen's (tests use it). */
export const VIEW_DEFAULT_ASPECT = 16 / 9;
export const ENCOUNTER_VIEW_ENTRY_SECONDS = 4;
export const ENCOUNTER_VIEW_ENTRY_MAX_RATE = 40;

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
 * they were; and a comet sixth, at index 5: the comet draw, ENCOUNTER_COMET_SHARE, leaves the first
 * five as they were). Its first 50 encounters hold a ringed planet, an icy dwarf, asteroids and
 * comets (docs/PLAN.md section 9, Phase 4). Every trip seed starts with a planet (`encounterKindAt`)
 * within the 30–60 s of docs/PLAN.md section 9, Phase 2 (see ENCOUNTER_INTERVAL_JITTER).
 */
export const ENCOUNTER_BASE_SEED = 0x91b3_a5ba;

/**
 * `D`: the planet is placed this far ahead along the heading when the encounter starts, so it is
 * also the spawn distance (docs/PLAN.md section 6, Planets: it first appears as a star-like dot and
 * grows). Inside CAMERA_FAR with room to spare, ring and side offset included (see CAMERA_NEAR for
 * the depth precision there). A planet keeps its world size for the whole encounter, so this and the
 * planet radii (PLANET_ROCKY_RANGES, PLANET_GAS_RANGES, PLANET_ICY_RADIUS) set how small it first
 * appears. At 1080p, over 20,000 seeded planets, the disc with its atmosphere first spans p10/p50/p90/max
 * 4.7/11.3/24.3/28.8 px (15.6/37.7/81.5/99.0 from 2,400 before #64), and no configured planet more
 * than 30 px; ring included, 4.7/11.5/31.2/66.7 px: a ring is thin and translucent, and under 30 px
 * the widest would need a spawn about 18,500 out, past CAMERA_FAR (checked in Planet.test.ts). It fades in from opacity 0 there over
 * ENCOUNTER_FADE_IN_SECONDS, and the far stretch (ENCOUNTER_FAR_SPEED) flies most of the way
 * there faster while it is still small. Asteroids and comets spawn as far out
 * (ASTEROID_ENCOUNTER_DISTANCE, COMET_ENCOUNTER_DISTANCE); nebulae keep their own approach
 * (NEBULA_ENCOUNTER_DISTANCE).
 */
export const ENCOUNTER_DISTANCE = 8000;

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
 * 4.4°/s, and the ship reaches the closest approach about 97 s after the spawn 8,000 out, its far
 * stretch included (about 54 s after the spawn 2,400 out before #64; both checked in
 * EncounterView.test.ts). Seeded planets vary their radius and k, and pass at least
 * PLANET_MIN_PASS_DISTANCE from the path: none peaks above about 5°/s, under the 5.1°/s guard.
 * Faster levels are back at the arrival speed by the end of the far stretch (ENCOUNTER_ARRIVAL_SPEED,
 * ENCOUNTER_FAR_SPEED), so they fly this same profile and the same flyby. The slowdown and speed-up distances are not scaled down with
 * the radii: the ship needs that distance to slow down from the arrival speed within a few time
 * constants.
 */
export const ENCOUNTER_MIN_SPEED = 6;
/**
 * Lowest planet minimum speed (units per second) at any speed level. `setCruiseSpeed` scales
 * ENCOUNTER_MIN_SPEED with the cruise speed, which would make it 2 at the slowest level (the
 * reduced-motion start): one encounter would take about 350 s, about 69 s of it in FLYBY. With this
 * floor it took about 285 s, about 44 s in FLYBY, and a median planet peaks at about 2.8°/s, as it
 * did before the planets were made smaller; ending once the planet is off the screen (see
 * VIEW_WIDEST_ASPECT) brought it down to about 151 s for the first default-seed planet, spawned 2,400
 * out; spawned 8,000 out (ENCOUNTER_DISTANCE) with its far stretch flown at about 50, about 316 s for
 * a median planet. Nebulae have their own floor (NEBULA_MIN_SPEED_FLOOR).
 */
export const ENCOUNTER_MIN_SPEED_FLOOR = 4;
export const ENCOUNTER_SLOWDOWN_DISTANCE = 520;
export const ENCOUNTER_MIN_SPEED_DISTANCE = 16;
export const ENCOUNTER_SPEEDUP_DISTANCE = 800;

/**
 * Fade. From the spawn, opacity eases (smoothstep) up from 0 to 1 over ENCOUNTER_FADE_IN_SECONDS of
 * the encounter's own time (`AutopilotState.encounterTime`), the same at every speed level, while the
 * object is still a dot: it reads as a dot appearing, never as an object turning from dark to
 * bright. Planets, asteroids and comets share it; nebulae keep their distance-based fade
 * (NEBULA_FADE_IN_DISTANCE). The object's size does not change (its spawn scale is 1), so it starts
 * as a distant dot because it is far away, and grows on screen by perspective alone. Short as it
 * is, the fade is still smooth: a smoothstep over 4 s changes opacity by at most 1.5 × dt / 4 per
 * frame, 0.6% at 60 FPS and 3.75% in a capped frame (DT_CAP_SECONDS; no ease that reaches 1 within
 * 4 s could keep every capped frame under 2%, which takes 5 s even for a linear ramp), at every speed
 * level. The view keeps a new object hidden until its shaders are ready (EncounterView), which with
 * every program kept compiled (ProgramWarmup) is the first frame or two, when the fade is still under
 * 1e-3, so nothing pops in.
 *
 * After passing, opacity eases back down to 0 over ENCOUNTER_FADE_OUT_DISTANCE, reaching 0 at
 * ENCOUNTER_DESPAWN_DISTANCE past the closest approach, where DEPARTURE ends at the latest; in
 * practice a planet encounter ends once the planet is off the screen (VIEW_WIDEST_ASPECT), around
 * the closest approach, and the planet is removed unseen before it fades. The fade-out distance is
 * long enough that at the top cruise speed one capped frame changes opacity by less than 2%.
 */
export const ENCOUNTER_FADE_IN_SECONDS = 4;
export const ENCOUNTER_FADE_OUT_DISTANCE = 1200;
export const ENCOUNTER_DESPAWN_DISTANCE = 1500;

/**
 * The far stretch (docs/PLAN.md section 6, Time and speed): spawned far out, a planet, an asteroid or
 * a comet would take minutes to reach at the arrival speed, so the ship flies the first part of the
 * approach faster, while the object is still small, and is back at the arrival speed, with no
 * acceleration left, by the time the object's angular diameter reaches ENCOUNTER_FAR_MAX_ANGLE_DEG
 * (or by the start of the slowdown, ENCOUNTER_SLOWDOWN_DISTANCE and the other kinds' equivalents,
 * whichever comes first). From there on everything is exactly as before: the near-approach speed
 * profile, the bearing-rate guard, the clearance and the off-screen speed-up (VIEW_WIDEST_ASPECT).
 * The angular diameter is that of the sphere holding what is drawn of the object: a planet's
 * atmosphere or its ring (`PlanetSpec.extent`), an asteroid field's bounding sphere, a comet's coma
 * (its faint tails reach several degrees from the spawn on, and are left out). Nebulae have no far
 * stretch.
 *
 * The ship's speed follows a curve in the distance travelled since the spawn: from its speed at the
 * spawn up to ENCOUNTER_FAR_SPEED, held there, and back down to the arrival speed, each change a
 * smootherstep in distance (no step in speed, acceleration or jerk) whose peak acceleration is about
 * ENCOUNTER_FAR_ACCEL; the curve takes a lower peak where the stretch is too short for the whole rise
 * and fall. A stretch shorter than the whole fall from ENCOUNTER_FAR_SPEED (about 1,480 units) is left
 * out, as where the object is already past the threshold at the spawn (the largest planets and
 * rings): the whole approach is then flown on the arrival speed's profile, as every approach was
 * before #64, and no stretch is short enough to rise and fall again within a second or so, with a
 * large jerk.
 * The target speed leads the curve by the ship's lag (`target = v + SHIP_SPEED_TAU_SECONDS × dv/dt`,
 * as the quick warp entry does), so the ship's speed itself follows it and arrives at the threshold
 * at the arrival speed. Like the rest of the profile, the speeds scale with the level
 * (`setCruiseSpeed`: about 50 at the slowest level) and the distances do not, so the acceleration
 * scales with its square.
 *
 * Above the arrival speed the cruise drops out of warp only as far as the far stretch can fly on
 * from (the highest speed it can fall from within its length; `farHandoverSpeed`): every far stretch
 * is long enough to fall from the far speed, so at the top level the ship stays in warp, steady, to
 * the spawn of every object with one and slows down during the far stretch, rather than slowing
 * down, speeding up again and slowing down once more; before a nebula, or an object with no far
 * stretch, it drops out of warp to the arrival speed as before.
 *
 * Measured over 200 seeded encounters of each kind on a 16:9 screen, from the spawn to the closest
 * approach, p10/p50/p90/max in seconds (before #64, spawned 2,400 or 1,600 out: in brackets):
 *
 *   level   planet                  asteroid                comet
 *   20      250/280/365/430 [150]   280/280/301/319 [148]   288/294/301/303 [180]
 *   60      87/97/125/147 [54]      111/111/118/124 [67]    108/110/112/113 [72]
 *   150     81/91/119/147 [53]      105/105/112/118 [67]    102/104/106/107 [72]
 *
 * A median planet is reached within twice the 54 s of before at the default level; a large or ringed
 * one is past the threshold soon after its spawn (or at it), so it has little or no far stretch, and
 * takes the longest. Nebulae are unchanged (55 s at the default level). The object first reaches 2°
 * across, the end of the window in which it is still a tiny dot, p10/p50/p90 12/41/53 s after a
 * planet's spawn at the default level (6/35/48 s at the top level, 36/123/160 s at the slowest), and
 * at a median of about 59 s for an asteroid and 47 s for a comet. The ship's acceleration on the far
 * stretch peaks at about 12.8 units per second per second at the default and top levels (1.4 at the
 * slowest), and its jerk at about 5 per second cubed (6.7 at most, for a stretch just over the
 * shortest, at the default level), with no step in the target speed at the spawn.
 */
export const ENCOUNTER_FAR_SPEED = 150;
export const ENCOUNTER_FAR_ACCEL = 12;
export const ENCOUNTER_FAR_MAX_ANGLE_DEG = 3;

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
 * Planet surface bake (issue #65; engine/PlanetBake.ts): each planet's surface is rendered once into
 * cube maps of this many texels a side per face, then drawn from them, so a frame shades it with a
 * couple of texture reads instead of a dozen noise evaluations.
 *
 * The size: the surface's finest detail (the top terrain octave, at most about 87 cycles per radian,
 * and the narrowest crater rims) spans about 6 texels at 1024 (a face texel is at most 2/1024 rad
 * across), so bilinear filtering keeps it; and the sharpest edges, the coastlines, are recomputed
 * per pixel from the baked height, so they stay as sharp as before however close. Magnified, at the
 * closest pass (k = 1.6) at 1512×982 @2×, a texel is at most about 6.6 device pixels (3.3 CSS
 * pixels) across, at the very edge of the screen, and that finest detail about 38. Twice the size
 * would quadruple the memory (see `SurfaceBake` in engine/Planet.ts: 50.3 MB for a rocky world at
 * 1024) for detail the surface does not have.
 */
export const PLANET_BAKE_FACE_SIZE = 1024;

/**
 * Rows of one cube face baked per frame (one slice of PLANET_BAKE_FACE_SIZE × this texels, about an
 * eighth of a face). A rocky world bakes 2 maps × 6 faces × 8 slices, 96 frames (1.6 s at 60 FPS); a
 * gas giant 48 (0.8 s). The planet spawns as a dot and is 2° across no sooner than about 6 s after
 * its spawn (the p10 at the top level), so the bake is done while it is a dot. Each slice is about
 * 2% of a full-screen procedural planet at 1512×982 @2×, so no frame hitches.
 */
export const PLANET_BAKE_ROWS_PER_FRAME = 128;

/** Anisotropic filtering of the baked cube maps, so the surface stays sharp toward the limb. */
export const PLANET_BAKE_ANISOTROPY = 8;

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
 * cheap fBm fragment shader. An encounter is a planet, a nebula, an asteroid or a comet (see Asteroids
 * and Comets below), chosen from the encounter's
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

/** Share of encounters that are nebulae; the rest are solid bodies (planets, asteroids and comets). */
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
 * 50:35; comets then take it to 0.4, see Comets below). Every nebula stays where it was in every trip, and every planet that stays a planet keeps
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
 * level an asteroid encounter lasts about 96–128 s from its spawn 8,000 out, its far stretch included
 * (53–70 s from 1,600 before #64), and ends once the field is off the screen, before its closest
 * approach or within about 4 s after it (about 263–324 s at the slowest level, 131–152 s before).
 */

/** Share of all encounters that are asteroids, in the long run (see the section comment). */
export const ENCOUNTER_ASTEROID_SHARE = 0.15;

/** Bounds the asteroid share over any 1,000 consecutive encounter indices must stay within. */
export const ENCOUNTER_ASTEROID_SHARE_BOUNDS = [0.1, 0.2] as const;

/**
 * `D` for asteroids: the field centre is placed this far ahead, which is also the spawn distance. As
 * for planets (ENCOUNTER_DISTANCE): at 1080p the field's bounding sphere first spans p10/p50/p90/max
 * 1.3/2.8/7.9/12.3 px and the main rock 1–3 px (6.5/13.9/39.3/61.7 px and 6–14 px from 1,600 before
 * #64; Asteroid.test.ts), so it first appears as a faint, star-like
 * dot, and the far stretch (ENCOUNTER_FAR_SPEED) flies most of the way.
 */
export const ASTEROID_ENCOUNTER_DISTANCE = 8000;

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
 * Asteroid fade (see the planet one: it fades in over ENCOUNTER_FADE_IN_SECONDS). An asteroid
 * encounter ends once the field is out of view, a little after the closest approach, so the fade-out
 * is not seen.
 */
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
 * Comets (docs/PLAN.md section 6, Variety, and section 9, Phase 4): a small, dark, irregular nucleus
 * in a soft glowing coma, with a straight bluish ion tail and a broader, curved, yellowish dust tail,
 * both pointing away from the comet's "sun". `cometParams(seed)` in engine/Comet.ts draws every value
 * below from an encounter's appearance seed.
 *
 * - The nucleus is an irregular body (`irregularBodyGeometry`, shared with asteroid rocks, with
 *   broader lobes and fewer, shallower pits) shaded with the rocky planet surface program in dark,
 *   sooty tones, tumbling slowly.
 * - The coma and the tails are one additive mesh drawn with the planets' halo program (the
 *   atmosphere's and the ring's, `cometGlowMaterial` in engine/Planet.ts): a sphere for the coma and
 *   an open tube along each tail's axis, whose fragments add the glow of the gas along the view ray
 *   (from how close the ray passes to the coma centre or the tail's axis), so the glow is soft from
 *   every side and costs one fragment per covered pixel per piece. Comets add no shader program.
 * - The sun of a comet encounter is ahead of the comet, toward the path and a little up, in the
 *   encounter's own frame (COMET_ENCOUNTER_LIGHT), so both tails point away from the path and back
 *   along it: the ship flies in alongside the tails toward the head, both tails' axes only move away
 *   from the path from the nucleus on, no part of either comes nearer the path than the coma's edge
 *   (the camera never meets a tail, checked in Comet.test.ts), and from the camera both lie farther
 *   out to the comet's side than the coma, so they leave the screen with it (Autopilot.test.ts).
 *
 * Schedule: the planet-or-nebula draw and the asteroid draw are unchanged, and a third seeded draw,
 * from a stream of its own, turns some of the remaining planets into comets, so
 * ENCOUNTER_COMET_SHARE of all encounters are comets in the long run: nebulae 0.35, asteroids 0.15,
 * comets 0.10 and planets 0.40 (from 0.5), so comets are the rarest kind and planets stay the most
 * common. Every nebula and every asteroid stays where it was in every trip. Comets are solid bodies
 * for the run cap (ENCOUNTER_MAX_SAME_KIND_RUN). The first encounter of every trip is still a planet.
 *
 * Plan: the encounter radius is the coma's radius, and the planned path passes the nucleus at
 * COMET_MIN_PASS_DISTANCE or more (at least the coma radius × (1 + ENCOUNTER_CLEARANCE_MARGIN), far
 * more in practice), so the camera never enters the coma, let alone its core or the nucleus. The
 * heading is held while the encounter lasts, but a comet leaves the screen, and its encounter ends,
 * short of the closest approach, and the next cruise may ease the heading drift back up before the
 * ship gets there: the real pass can be a little nearer than the planned one (measured with the live
 * view: at least 0.969 × it at the slowest level and 0.990 × at the others, the nearest tail vertex
 * at 0.96 × the planned distance less the coma radius, still more than 60 units outside the coma;
 * Comet.test.ts flies on past the end of the encounter). Issue #62 removes the drift. The off-screen
 * test (`encounterViewMargin`) takes the live view to spheres that hold the coma and every segment of
 * both tails (`CometParams.bounds`), and the comet is off the screen only once all of them are. The
 * tails trail back along the path and away from it, so they never keep a comet on the screen after
 * its coma has left it (measured: they leave on the same step): a comet leaves the screen to the side
 * with its coma, a few seconds before the closest approach on every screen from 4:3 to 32:9.
 *
 * Measured over 2,000 seeds (Comet.test.ts checks the bounds): the nucleus 2.5–5 in radius, the
 * coma radius 26–42, the closest approach to the nucleus 110–165 (p10/p50/p90 about 110/122/155),
 * no vertex of either tail's tube nearer the path than 99, the ion tail 800–1,200 long and the dust
 * tail 450–750. With its longer slowdown (COMET_SLOWDOWN_DISTANCE), a comet is about 110 s from its
 * spawn 8,000 out to its closest approach at the default level and 104 s at the top level, its far
 * stretch included (294 s at the slowest level; 72 s and 180 s from 2,400 before #64); on a
 * 16:9 screen it leaves the screen, and the encounter ends, 2–4 s before that (3.3–7.5 s at the
 * slowest level), and the ship is at 50% of the cruise speed within 1.9 s of it leaving the screen
 * and at 90% within 3 s (3.4 s and 5.1 s at the top level; Autopilot.test.ts).
 *
 * GPU cost (Comet.test.ts rasterises the glow mesh as the GPU does, front faces only, over 40 seeded
 * comets at 4:3, 16:9 and 21:9 from the spawn to the end of the encounter; the path, and so the
 * view, is the same at every speed level): the glow covers under 2% of the view at the spawn, at
 * most about 12% at 16:9 (median comet about 8%) and 16% at 21:9 late in the approach, as the tails
 * stretch past the camera's side, and nothing once the comet has left the screen (nor at the closest
 * approach, on a screen wide enough to keep it until then). Fill, the fragments shaded for it per
 * pixel of the view, is at most about 0.19 (COMET_MAX_FILL bounds it): each piece covers a pixel
 * about once. Outside the coma's core the glow adds at most the tails' peak brightness (0.32 or less,
 * linear) to a pixel, so the stars and the sky stay visible through it; in the browser
 * (e2e/comet.spec.ts, 640×360, 250 short of the closest approach) about 0.06% of the view is washed
 * out, against 0.04% for the stars alone at cruise: the comet adds about 0.02%, the coma's core.
 */

/** Share of all encounters that are comets, in the long run (see the section comment). */
export const ENCOUNTER_COMET_SHARE = 0.1;

/** Bounds the comet share over any 1,000 consecutive encounter indices must stay within. */
export const ENCOUNTER_COMET_SHARE_BOUNDS = [0.06, 0.14] as const;

/**
 * `D` for comets: the nucleus is placed this far ahead, which is also the spawn distance. As for
 * planets (ENCOUNTER_DISTANCE): the coma (at most 84 across) starts under 0.6° across, about 10 px at
 * 1080p, and the tails reach back toward the ship to at most about 7,200 ahead of it, so the whole
 * comet starts small and fades in from 0, and the far stretch (ENCOUNTER_FAR_SPEED) flies most of
 * the way.
 */
export const COMET_ENCOUNTER_DISTANCE = 8000;

/**
 * `k` for a comet that brings no pass factor of its own (`CometSpec.passFactor`); every seeded comet
 * does. 4 coma radii, as a seeded comet passes.
 */
export const COMET_SIDE_OFFSET_FACTOR = 4;

/**
 * Smallest distance between the path and the nucleus, in world units: beyond any coma (its radius
 * is at most 40), and beyond the planets' floor (PLANET_MIN_PASS_DISTANCE), so a comet flown with the
 * planets' speed profile never sweeps past faster in angle than a planet does.
 */
export const COMET_MIN_PASS_DISTANCE = 110;

/**
 * The closest approach to the nucleus is COMET_MIN_PASS_DISTANCE times `1 + COMET_PASS_EXTRA × u²`
 * for a uniform roll `u`, so most pass close.
 */
export const COMET_PASS_EXTRA = 0.5;

/**
 * Comet speed profile: the planets' minimum speed, floor, band and speed-up distance (see
 * ENCOUNTER_MIN_SPEED), but a longer slowdown, COMET_SLOWDOWN_DISTANCE = 1,000 against the planets'
 * 520 (ENCOUNTER_SLOWDOWN_DISTANCE). That is what keeps the tails under the 5.1°/s bearing-rate guard:
 * the ship passes the tails' far parts several hundred units short of the closest approach, and with
 * the planets' slowdown it would still be fast there (the tails measured up to 7.5°/s; no aim of the
 * comet's sun fixes that). Slowing from 1,000 out, the nucleus, at least COMET_MIN_PASS_DISTANCE off,
 * peaks at about 3.1°/s and the tails at about 4.3°/s at the default and top levels (Comet.test.ts).
 * The cost is a longer approach, a deliberate choice for a passively watched view: about 110 s from
 * the spawn to the closest approach at the default level (a median planet takes about 97 s) and 294 s
 * at the slowest (72 s and 180 s from 2,400 before #64). Like the other kinds, a comet encounter is flown from the arrival speed at the faster
 * levels.
 */
export const COMET_MIN_SPEED = 6;
/** Lowest comet minimum speed at any speed level (see ENCOUNTER_MIN_SPEED_FLOOR). */
export const COMET_MIN_SPEED_FLOOR = 4;
export const COMET_SLOWDOWN_DISTANCE = 1000;
export const COMET_MIN_SPEED_DISTANCE = 16;
export const COMET_SPEEDUP_DISTANCE = 800;

/**
 * Comet fade (see the planet one: it fades in over ENCOUNTER_FADE_IN_SECONDS). A comet encounter ends
 * once the coma and both tails are off the screen, a few seconds before the closest approach, so the
 * fade-out is not seen.
 */
export const COMET_FADE_OUT_DISTANCE = 1000;
export const COMET_DESPAWN_DISTANCE = 1200;

/**
 * Direction toward a comet's sun, in the encounter's own frame (see PLANET_ENCOUNTER_LIGHT for the
 * axes): `ahead` along the planned direction, `inward` from the comet toward the path, `up`. The tails
 * point the opposite way: mostly away from the path, back along it and a little down, about 66° off
 * the line of sight from the spawn, so they show at length on the approach. Mostly sideways, so a
 * tail's far part, which the ship passes while it is still slowing down, stays well off the path. It
 * still sweeps past faster in angle than the nucleus does (measured up to about 4.3°/s against
 * 3.1°/s), and aiming the sun otherwise barely changes that: the longer comet slowdown
 * (COMET_SLOWDOWN_DISTANCE) is what keeps it under the guard (Comet.test.ts). Normalised when applied.
 */
export const COMET_ENCOUNTER_LIGHT = { ahead: 0.35, inward: 0.75, up: 0.3 } as const;

/**
 * Parameter ranges for `cometParams(seed)` in engine/Comet.ts (inclusive `[min, max]` pairs). Lengths
 * are in world units unless given in coma radii; a tail's half-width grows linearly from its head to
 * its end.
 */
export const COMET_RANGES = {
  /** Nucleus bounding radius (every vertex lies within it). */
  nucleusRadius: [2.5, 5],
  /** The nucleus's shorter axes, as fractions of its longest. */
  axisB: [0.5, 0.8],
  axisC: [0.4, 0.65],
  /** Its lumps (broad lobes, `lumpFrequency` below) and pits. */
  lumpiness: [0.3, 0.45],
  craterCount: [1, 3],
  craterSize: [0.25, 0.5],
  /** Tumble speed, in radians per second. */
  tumbleSpeed: [0.02, 0.06],
  /** Surface shading (the rocky planet shader's terrain, see PLANET_ROCKY_RANGES). */
  noiseScale: [1.4, 2.4],
  octaves: [4, 5],
  warp: [0.3, 0.7],
  relief: [0.6, 1.1],
  craters: [0.1, 0.3],
  /** Coma radius: the glow fades to nothing there. The encounter radius. */
  comaRadius: [26, 42],
  /** Brightness of the coma's centre (linear, before the encounter fade). */
  comaIntensity: [0.75, 1.0],
  /** Ion tail: length, and half-width at the head and at the end, in coma radii. */
  ionLength: [800, 1200],
  ionHeadWidth: [0.12, 0.2],
  ionEndWidth: [0.45, 0.8],
  /** Peak brightness of the ion tail's axis. */
  ionIntensity: [0.2, 0.32],
  /** Dust tail: length, and half-width at the head and at the end, in coma radii. */
  dustLength: [450, 750],
  dustHeadWidth: [0.35, 0.5],
  dustEndWidth: [2.2, 3.4],
  /** Peak brightness of the dust tail's axis. */
  dustIntensity: [0.2, 0.32],
  /**
   * The dust tail's curve: its axis is `length × (t × anti-sun + (angle × t + curvature × t²) ×
   * bend)` for t from 0 to 1, with `bend` a unit vector at right angles to the anti-sun direction:
   * the trailing side (at right angles to the path's side too, and back along the path), turned
   * toward the outward side by `bendTilt` radians, so the dust tail lags behind the ion tail and never
   * curves toward the path or ahead.
   */
  dustAngle: [0.15, 0.35],
  dustCurvature: [0.15, 0.3],
  dustBendTilt: [0, 0.6],
} as const;

/** The nucleus's lump frequency band, `[lowest, spread]` (`IrregularBodyShape.lumpFrequency`): broader lobes than a rock's. */
export const COMET_NUCLEUS_LUMP_FREQUENCY = [0.9, 1.4] as const;
/** The nucleus's crater depth and rim (`IrregularBodyShape.craterDepth`, `craterRim`): shallow, soft pits. */
export const COMET_NUCLEUS_CRATER_DEPTH = 0.3;
export const COMET_NUCLEUS_CRATER_RIM = 0.12;

/**
 * Mesh resolution: the nucleus's icosphere detail (492 vertices, 980 triangles); the coma sphere's
 * width and height segments; each tail tube's rings along its length (segments) and vertices around
 * it (sides). The glow mesh is then 561 + 2 × 41 × 16 = 1,873 vertices and 960 + 2 × 1,280 = 3,520 triangles.
 *
 * Encounter-time resources: two geometries (the nucleus and the glow), two materials and two draw
 * calls, all freed with the encounter, and no program of their own (the rocky surface program and
 * the halo program, both kept compiled by ProgramWarmup), so the counts at cruise are unchanged
 * (longRun.test.ts, e2e/comet.spec.ts).
 */
export const COMET_NUCLEUS_DETAIL = 6;
export const COMET_COMA_SEGMENTS = [32, 16] as const;
export const COMET_TAIL_SEGMENTS = 40;
export const COMET_TAIL_SIDES = 16;

/** Tail rings per out-of-view bounding sphere (`CometParams.bounds`): COMET_TAIL_SEGMENTS / this spheres per tail. */
export const COMET_BOUND_RINGS = 5;

/**
 * Largest fill of the comet glow: fragments shaded for it per pixel of the view, at any moment of a
 * comet encounter, at any aspect ratio from 4:3 to 21:9 (checked in Comet.test.ts over seeded
 * comets). Each piece (the coma, each tail) covers a pixel at most about once, so this is about the
 * screen coverage plus the overlaps near the head.
 */
export const COMET_MAX_FILL = 0.3;

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
