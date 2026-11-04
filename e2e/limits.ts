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
