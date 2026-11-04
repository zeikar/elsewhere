import { describe, expect, it } from 'vitest';
import { PERF_FRAME_WINDOW } from '../config';
import { FrameStats } from './FrameStats';

describe('FrameStats', () => {
  it('is empty at first: NaN statistics and no samples', () => {
    const stats = new FrameStats(4);
    expect(stats.capacity).toBe(4);
    expect(stats.count).toBe(0);
    expect(stats.total).toBe(0);
    expect(stats.last).toBeNaN();
    expect(stats.mean()).toBeNaN();
    expect(stats.max()).toBeNaN();
    expect(stats.percentile(95)).toBeNaN();
  });

  it('defaults to the configured window', () => {
    expect(new FrameStats().capacity).toBe(PERF_FRAME_WINDOW);
  });

  it('gives the mean, max and nearest-rank percentiles of the window', () => {
    const stats = new FrameStats(100);
    // 1..100, recorded out of order.
    for (let i = 0; i < 100; i++) stats.record(((i * 37) % 100) + 1);
    expect(stats.count).toBe(100);
    expect(stats.mean()).toBeCloseTo(50.5, 12);
    expect(stats.max()).toBe(100);
    expect(stats.percentile(95)).toBe(95);
    expect(stats.percentile(50)).toBe(50);
    expect(stats.percentile(100)).toBe(100);
    expect(stats.percentile(0)).toBe(1);
    expect(stats.last).toBe(((99 * 37) % 100) + 1);
  });

  it('is a rolling window: only the latest `capacity` samples count', () => {
    const stats = new FrameStats(3);
    for (const v of [100, 100, 100, 1, 2, 3]) stats.record(v);
    expect(stats.count).toBe(3);
    expect(stats.total).toBe(6);
    expect(stats.mean()).toBe(2);
    expect(stats.max()).toBe(3);
    expect(stats.percentile(95)).toBe(3);
    expect(stats.last).toBe(3);
  });

  it('ignores NaN, negative and infinite samples (no interval yet)', () => {
    const stats = new FrameStats(4);
    stats.record(10);
    for (const v of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) stats.record(v);
    expect(stats.count).toBe(1);
    expect(stats.last).toBe(10);
    expect(stats.mean()).toBe(10);
  });

  it('percentile does not disturb the window order', () => {
    const stats = new FrameStats(3);
    for (const v of [5, 1, 9]) stats.record(v);
    expect(stats.percentile(50)).toBe(5);
    // The oldest sample (5) is replaced next, whatever percentile() sorted.
    stats.record(2);
    expect(stats.mean()).toBe(4);
    expect(stats.max()).toBe(9);
  });

  it('reset forgets everything', () => {
    const stats = new FrameStats(3);
    for (const v of [1, 2, 3, 4]) stats.record(v);
    stats.reset();
    expect(stats.count).toBe(0);
    expect(stats.total).toBe(0);
    expect(stats.last).toBeNaN();
    stats.record(7);
    expect(stats.mean()).toBe(7);
  });

  it('rejects a bad capacity', () => {
    expect(() => new FrameStats(0)).toThrow(RangeError);
    expect(() => new FrameStats(2.5)).toThrow(RangeError);
  });
});
