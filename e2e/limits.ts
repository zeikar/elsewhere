/** Limits shared by several e2e specs and the soak (e2e/soak/soak.spec.ts). */

/** Largest allowed JS heap growth (after a forced GC) over a soak or across encounters. */
export const SOAK_HEAP_GROWTH_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Largest allowed frame-time degradation over a soak: the p95 frame interval (and frame work time)
 * at CRUISE late in the run may be at most the early value times this factor, plus
 * SOAK_FRAME_TIME_SLACK_MS. Relative, because absolute frame rates under SwiftShader (software
 * rendering) say nothing about real hardware.
 */
export const SOAK_FRAME_TIME_FACTOR = 1.5;

/** Absolute slack on the frame-time comparison, in ms, so sub-millisecond work times cannot fail on timer noise. */
export const SOAK_FRAME_TIME_SLACK_MS = 2;

/**
 * Longest main-thread work allowed in the frame that creates an encounter object or first draws it.
 * A stall detector, not a frame-rate target: those frames take about 1–15 ms under SwiftShader,
 * while a shader compile or link waited on in them took 160–670 ms (see src/engine/ProgramWarmup.ts).
 */
export const SOAK_ENCOUNTER_FRAME_WORK_LIMIT_MS = 100;

/**
 * `?arrivalSpeed=` value (an e2e-only override, see src/e2eHook.ts) for specs that only need many
 * encounter cycles, such as the GPU-resource checks: at the top speed level it flies encounters from
 * the top speed instead of dropping out of warp to the default level's speed first, so they pass
 * about 2.5–3× sooner in simulated time. Measured under SwiftShader: the accelerated ten-encounter
 * spec takes 8.4 min without it (40 s before the drop out of warp), the three-encounter spec runs out
 * of its 9-min budget (3.9 min before), the forced nebula spec takes 4.4 min (1.8 min), and a
 * 3-minute soak meets only 2 encounters and takes 2 samples, failing its check of at least 3. The drop
 * out of warp itself is checked in src/engine/Autopilot.test.ts and EncounterView.test.ts, and in the
 * browser by e2e/warp.spec.ts, which runs without this override and flies the real drop out of warp
 * and return to it at the top speed. The mid-encounter ArrowUp spec in e2e/encounter.spec.ts also
 * runs without it, but cruises at the default speed and switches to the top speed only in APPROACH.
 */
export const FAST_ENCOUNTERS_ARRIVAL_SPEED = 150;
