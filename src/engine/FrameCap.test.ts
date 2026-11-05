import { describe, expect, it } from 'vitest';
import { FRAME_CAP_TOLERANCE_MS, FRAME_RATE_CAP } from '../config';
import { FrameCap } from './FrameCap';
import { mulberry32 } from './seed';

/**
 * Feeds `seconds` of display frames at `hz` (each timestamp jittered by up to ±`jitterMs`, seeded)
 * to a cap of FRAME_RATE_CAP and returns the drawn frames' timestamps.
 */
function drawn(hz: number, seconds: number, jitterMs = 0, cap = new FrameCap(FRAME_RATE_CAP, FRAME_CAP_TOLERANCE_MS)): number[] {
  return run(hz, seconds, jitterMs, cap).drawn;
}

/** As `drawn`, with the number of display frames fed. */
function run(hz: number, seconds: number, jitterMs = 0, cap = new FrameCap(FRAME_RATE_CAP, FRAME_CAP_TOLERANCE_MS)) {
  const random = mulberry32(0x6a5e + Math.round(hz * 10));
  const out: number[] = [];
  const period = 1000 / hz;
  let fed = 0;
  for (let i = 0; i * period < seconds * 1000; i++, fed++) {
    const t = 1000 + i * period + (random() * 2 - 1) * jitterMs;
    if (cap.due(t)) out.push(t);
  }
  return { drawn: out, fed };
}

function intervals(times: readonly number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!);
}

describe('FrameCap', () => {
  it('caps at 60 fps by default, with a tolerance well under a 120 Hz frame', () => {
    expect(FRAME_RATE_CAP).toBe(60);
    expect(FRAME_CAP_TOLERANCE_MS).toBeGreaterThan(0);
    expect(FRAME_CAP_TOLERANCE_MS).toBeLessThan(1000 / 120 / 2);
  });

  it.each([
    { label: '60 Hz', hz: 60, jitter: 0 },
    { label: '60 Hz with ±1 ms jitter', hz: 60, jitter: 1 },
    { label: '59.94 Hz', hz: 59.94, jitter: 0.5 },
    { label: '60.5 Hz', hz: 60.5, jitter: 0.5 },
    { label: '50 Hz', hz: 50, jitter: 1 },
    { label: '30 Hz', hz: 30, jitter: 1 },
  ])('draws every frame of a display at or under the cap ($label): never halved to 30', ({ hz, jitter }) => {
    const { drawn: frames, fed } = run(hz, 20, jitter);
    expect(frames.length).toBe(fed);
  });

  it.each([
    { hz: 120, jitter: 0 },
    { hz: 120, jitter: 1 },
    { hz: 144, jitter: 0.5 },
    { hz: 90, jitter: 0.5 },
    { hz: 240, jitter: 0.3 },
  ])('draws about 60 frames a second at $hz Hz (jitter ±$jitter ms), never two display frames apart less than one', ({ hz, jitter }) => {
    const seconds = 20;
    const frames = drawn(hz, seconds, jitter);
    const fps = frames.length / seconds;
    expect(fps).toBeGreaterThan(59);
    expect(fps).toBeLessThanOrEqual(62);
    // Never a whole display frame shorter than the cap allows, nor longer than two cap intervals.
    for (const gap of intervals(frames)) {
      expect(gap).toBeGreaterThan(1000 / hz + 2 * jitter > 1000 / 60 ? 0 : 1000 / 60 - 1000 / hz - 2 * jitter - 1e-9);
      expect(gap).toBeLessThan(2 * (1000 / 60));
    }
  });

  it('at 120 Hz draws exactly every other display frame', () => {
    const { drawn: frames, fed } = run(120, 10, 0.8);
    expect(frames.length).toBe(fed / 2);
    for (const gap of intervals(frames)) expect(Math.abs(gap - 1000 / 60)).toBeLessThanOrEqual(1.6 + 1e-9);
  });

  it('after a stall restarts the schedule from the late frame, with no catch-up frames', () => {
    const cap = new FrameCap(60, FRAME_CAP_TOLERANCE_MS);
    const period = 1000 / 120;
    const out: number[] = [];
    let t = 0;
    for (let i = 0; i < 120; i++, t += period) if (cap.due(t)) out.push(t);
    // A 500 ms stall, then 120 Hz again.
    t += 500;
    const resumed = t;
    const after: number[] = [];
    for (let i = 0; i < 120; i++, t += period) if (cap.due(t)) after.push(t);
    // The late frame is drawn, then every other one from it.
    expect(after[0]).toBe(resumed);
    expect(after.length).toBe(60);
    for (const gap of intervals(after)) expect(gap).toBeCloseTo(1000 / 60, 6);
  });

  it('draws the first frame and the first after reset(), and draws everything with no cap', () => {
    const cap = new FrameCap(60, FRAME_CAP_TOLERANCE_MS);
    expect(cap.due(100)).toBe(true);
    expect(cap.due(104)).toBe(false);
    cap.reset();
    expect(cap.due(105)).toBe(true);
    for (const fps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const none = new FrameCap(fps, FRAME_CAP_TOLERANCE_MS);
      expect(none.intervalMs).toBe(0);
      expect(none.fps).toBe(0);
      expect(drawn(240, 2, 0, none).length).toBe(480);
    }
  });
});
