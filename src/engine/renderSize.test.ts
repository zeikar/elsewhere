import { describe, expect, it } from 'vitest';
import { computeRenderSize } from './renderSize';

describe('computeRenderSize', () => {
  it('caps the device pixel ratio: (1000, 500, 3, 2) gives 2000×1000 at DPR 2', () => {
    expect(computeRenderSize(1000, 500, 3, 2)).toEqual({
      cssWidth: 1000,
      cssHeight: 500,
      width: 2000,
      height: 1000,
      dpr: 2,
    });
  });

  it('keeps a DPR below the cap: (1000, 500, 1, 2) gives 1000×500 at DPR 1', () => {
    expect(computeRenderSize(1000, 500, 1, 2)).toEqual({
      cssWidth: 1000,
      cssHeight: 500,
      width: 1000,
      height: 500,
      dpr: 1,
    });
  });

  it('rounds fractional backing sizes down, like WebGLRenderer.setSize', () => {
    const size = computeRenderSize(333, 201, 1.5, 2);
    expect(size.dpr).toBe(1.5);
    expect(size.width).toBe(499);
    expect(size.height).toBe(301);
  });

  it('falls back to DPR 1 for invalid ratios and never returns a zero size', () => {
    const size = computeRenderSize(0, 0, Number.NaN, 2);
    expect(size.dpr).toBe(1);
    expect(size.cssWidth).toBe(1);
    expect(size.cssHeight).toBe(1);
    expect(size.width).toBe(1);
    expect(size.height).toBe(1);
  });
});
