import { describe, expect, it } from 'vitest';
import { CAMERA_FOV_DEG, VIEW_WIDEST_ASPECT } from '../config';
import { viewConeHalfAngle } from './encounter';
import { cameraFovDeg, computeRenderSize } from './renderSize';

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

describe('cameraFovDeg', () => {
  const tanHalfDeg = (deg: number): number => Math.tan((deg * Math.PI) / 360);
  /** Horizontal half-angle, in radians, of a camera with vertical field of view `fovDeg` at `aspect`. */
  const halfH = (fovDeg: number, aspect: number): number => Math.atan(tanHalfDeg(fovDeg) * aspect);
  /** Half-angle, in radians, from the forward axis to the view's corners. */
  const halfCorner = (fovDeg: number, aspect: number): number => Math.atan(tanHalfDeg(fovDeg) * Math.hypot(1, aspect));

  it('keeps the base vertical field of view up to 21:9', () => {
    for (const aspect of [9 / 21, 9 / 16, 1, 4 / 3, 16 / 9, VIEW_WIDEST_ASPECT]) {
      expect(cameraFovDeg(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT)).toBe(CAMERA_FOV_DEG);
    }
  });

  it('narrows the vertical field of view beyond 21:9 so the horizontal one stays at the 21:9 one', () => {
    const widestHalfH = halfH(CAMERA_FOV_DEG, VIEW_WIDEST_ASPECT);
    for (const aspect of [2.4, 32 / 9, 4, 8, 50]) {
      const fov = cameraFovDeg(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT);
      expect(fov).toBeLessThan(CAMERA_FOV_DEG);
      expect(fov).toBeCloseTo((2 * Math.atan((tanHalfDeg(CAMERA_FOV_DEG) * VIEW_WIDEST_ASPECT) / aspect) * 180) / Math.PI, 10);
      expect(halfH(fov, aspect)).toBeCloseTo(widestHalfH, 10);
    }
    // 32:9: without the cap the horizontal half-angle would be about 64.0°, beyond the 55.7° view cone.
    expect((halfH(CAMERA_FOV_DEG, 32 / 9) * 180) / Math.PI).toBeCloseTo(64.03, 2);
    expect(cameraFovDeg(CAMERA_FOV_DEG, 32 / 9, VIEW_WIDEST_ASPECT)).toBeCloseTo(41.5, 2);
  });

  it('keeps the whole view inside the autopilot view cone at every aspect ratio', () => {
    const cone = viewConeHalfAngle(CAMERA_FOV_DEG, VIEW_WIDEST_ASPECT);
    for (const aspect of [9 / 21, 1, 16 / 9, VIEW_WIDEST_ASPECT, 2.4, 32 / 9, 4, 8, 50]) {
      const fov = cameraFovDeg(CAMERA_FOV_DEG, aspect, VIEW_WIDEST_ASPECT);
      expect(halfCorner(fov, aspect)).toBeLessThanOrEqual(cone + 1e-12);
    }
  });

  it('is continuous at 21:9 and falls back to the base field of view for an invalid aspect', () => {
    expect(cameraFovDeg(CAMERA_FOV_DEG, VIEW_WIDEST_ASPECT * (1 + 1e-9), VIEW_WIDEST_ASPECT)).toBeCloseTo(CAMERA_FOV_DEG, 6);
    expect(cameraFovDeg(CAMERA_FOV_DEG, Number.NaN, VIEW_WIDEST_ASPECT)).toBe(CAMERA_FOV_DEG);
    expect(cameraFovDeg(CAMERA_FOV_DEG, Number.POSITIVE_INFINITY, VIEW_WIDEST_ASPECT)).toBe(CAMERA_FOV_DEG);
  });
});
