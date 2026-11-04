import { describe, expect, it } from 'vitest';
import { DT_CAP_SECONDS } from '../config';
import { FrameClock } from './FrameClock';

const FRAME_MS = 1000 / 60;

describe('FrameClock', () => {
  it('returns 0 on the first tick (no reference time yet)', () => {
    const clock = new FrameClock();
    expect(clock.tick(1234)).toBe(0);
  });

  it('returns the gap between ticks in seconds', () => {
    const clock = new FrameClock();
    clock.tick(1000);
    expect(clock.tick(1000 + FRAME_MS)).toBeCloseTo(1 / 60, 12);
  });

  it('returns dt <= 0.1 s for any raw gap', () => {
    const gaps = [0, 1, FRAME_MS, 99, 100, 101, 250, 1000, 60_000, 3_600_000, 1e12, Infinity];
    for (const gap of gaps) {
      const clock = new FrameClock();
      clock.tick(0);
      const dt = clock.tick(gap);
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(dt).toBeLessThanOrEqual(DT_CAP_SECONDS);
    }
    expect(DT_CAP_SECONDS).toBe(0.1);
  });

  it('never returns a negative dt when timestamps go backwards', () => {
    const clock = new FrameClock();
    clock.tick(5000);
    expect(clock.tick(4000)).toBe(0);
  });

  it('returns no time at all while hidden', () => {
    const clock = new FrameClock();
    clock.tick(0);
    clock.tick(FRAME_MS);
    clock.hide();
    expect(clock.isHidden()).toBe(true);
    let total = 0;
    for (let t = 2 * FRAME_MS; t < 5000; t += FRAME_MS) total += clock.tick(t);
    expect(total).toBe(0);
  });

  it('after a 10-minute hidden period, the next dt is at most one normal frame', () => {
    const clock = new FrameClock();
    let now = 0;
    clock.tick(now);
    now += FRAME_MS;
    clock.tick(now);

    clock.hide();
    now += 10 * 60 * 1000;
    clock.show();
    expect(clock.isHidden()).toBe(false);

    // First frame after return only re-establishes the reference time.
    now += FRAME_MS;
    const first = clock.tick(now);
    expect(first).toBeLessThanOrEqual(1 / 60 + 1e-9);
    expect(first).toBe(0);

    // Then normal frames resume.
    now += FRAME_MS;
    expect(clock.tick(now)).toBeCloseTo(1 / 60, 12);
  });

  it('reset() forgets the reference time so a long pause is not a step', () => {
    const clock = new FrameClock();
    clock.tick(0);
    clock.reset();
    expect(clock.tick(10 * 60 * 1000)).toBe(0);
    expect(clock.tick(10 * 60 * 1000 + FRAME_MS)).toBeCloseTo(1 / 60, 12);
  });
});
