import { describe, expect, it } from 'vitest';
import {
  DPR_CAP,
  STAR_BASE_SIZE_PX,
  STAR_BRIGHTNESS_MAX,
  STAR_BRIGHTNESS_MIN,
  STAR_COUNT,
  STAR_CUBE_SIZE,
  STAR_DIM_DISTANCE,
  STAR_EDGE_FADE_WIDTH,
  STAR_MOTE_BRIGHTNESS_MAX,
  STAR_MOTE_FRACTION,
  STAR_NEAR_FADE_DISTANCE,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
} from '../config';
import { computeRenderSize } from './renderSize';
import {
  DEFAULT_STARFIELD_OPTIONS,
  Starfield,
  computeWrapOffset,
  generateStars,
  nearStarBrightness,
  resizeUniformValues,
  starDim,
  starFade,
  wrapCoordinate,
  wrapStarCoordinate,
  type FadeParams,
} from './Starfield';

const L = STAR_CUBE_SIZE;

/** Distance between two values on a circle of circumference `size`. */
function circularDistance(a: number, b: number, size: number): number {
  const d = Math.abs(wrapCoordinate(a - b, size));
  return Math.min(d, size - d);
}

describe('wrap offset', () => {
  const positions = [0, 1, 599.5, L - 1e-9, L, 12345.678, -1, -1e-12, -L, -98765.4321, 1e12, -1e12, 1e12 + 0.5];

  it('is in [0, L) for positive, negative and very large ship positions', () => {
    for (const p of positions) {
      const w = wrapCoordinate(p, L);
      expect(w, `position ${p}`).toBeGreaterThanOrEqual(0);
      expect(w, `position ${p}`).toBeLessThan(L);
      // And congruent to p modulo L.
      expect(circularDistance(w, p % L, L), `position ${p}`).toBeLessThan(1e-6);
    }
  });

  it('wraps each component of the ship position', () => {
    const out = { x: 0, y: 0, z: 0 };
    const result = computeWrapOffset({ x: -1, y: 1e12, z: L * 3 + 7 }, L, out);
    expect(result).toBe(out);
    expect(out.x).toBeCloseTo(L - 1, 9);
    expect(out.y).toBe(1e12 % L);
    expect(out.z).toBeCloseTo(7, 9);
  });

  it('moving the ship by d moves every wrapped star by exactly -d (mod L)', () => {
    const stars = [0, 0.25, 123.456, 600, 1000.125, L - 0.001];
    // Steps are exactly representable at ±1e12 (float64 spacing there is 2^-13), so ship + d is exact.
    const steps = [0.5, -0.5, 3.25, -17.75, 599.875, 1500.0625, -2400.5];
    const ships = [0, 42.42, -42.42, 98765.4321, -98765.4321, 1e12, -1e12];
    for (const ship of ships) {
      for (const d of steps) {
        if (Math.abs(ship) >= 1e12) expect(ship + d - ship).toBe(d);
        const before = wrapCoordinate(ship, L);
        const after = wrapCoordinate(ship + d, L);
        for (const star of stars) {
          const w0 = wrapStarCoordinate(star, before, L);
          const w1 = wrapStarCoordinate(star, after, L);
          expect(w0).toBeGreaterThanOrEqual(-L / 2);
          expect(w0).toBeLessThan(L / 2);
          expect(circularDistance(w1, w0 - d, L), `ship ${ship}, d ${d}, star ${star}`).toBeLessThan(1e-6);
        }
      }
    }
  });
});

describe('starFade', () => {
  const params: FadeParams = {
    cubeSize: L,
    edgeFadeWidth: STAR_EDGE_FADE_WIDTH,
    nearFadeDistance: STAR_NEAR_FADE_DISTANCE,
  };
  const half = L / 2;

  it('is 0 on the cube boundary', () => {
    for (const [x, y, z] of [
      [half, 0, 0],
      [-half, 0, 0],
      [0, half, 10],
      [30, -20, -half],
      [half, half, half],
    ] as const) {
      expect(starFade(x, y, z, params)).toBe(0);
    }
  });

  it('is 0 at the camera', () => {
    expect(starFade(0, 0, 0, params)).toBe(0);
  });

  it('reaches 1 in the interior', () => {
    expect(starFade(0, 0, -half / 2, params)).toBe(1);
    expect(starFade(100, -50, 200, params)).toBe(1);
    expect(starFade(STAR_NEAR_FADE_DISTANCE, 0, 0, params)).toBe(1);
    expect(starFade(half - STAR_EDGE_FADE_WIDTH, 0, 0, params)).toBe(1);
  });

  it('stays within [0, 1] and is continuous: no big step across a fine sample grid', () => {
    // Lines through the near-camera region, the boundary and the corners.
    const lines: [number, number, number, number, number, number][] = [
      [-half, 0, 0, 1, 0, 0],
      [0, -half, 0, 0, 1, 0],
      [-half, 3, 1, 1, 0, 0],
      [-half, -half, -half, 1, 1, 1],
      [-half, 200, -100, 1, 0, 0],
    ];
    const n = 200_000;
    for (const [x0, y0, z0, dx, dy, dz] of lines) {
      let prev = starFade(x0, y0, z0, params);
      let maxStep = 0;
      let min = prev;
      let max = prev;
      for (let i = 1; i <= n; i++) {
        const t = (L * i) / n;
        const f = starFade(x0 + dx * t, y0 + dy * t, z0 + dz * t, params);
        min = Math.min(min, f);
        max = Math.max(max, f);
        maxStep = Math.max(maxStep, Math.abs(f - prev));
        prev = f;
      }
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      expect(maxStep).toBeLessThan(0.01);
    }
  });
});

describe('resize uniforms', () => {
  it('use the applied DPR from computeRenderSize, and pixel size = base size × applied DPR', () => {
    for (const deviceDpr of [1, 1.5, 2, 3]) {
      const size = computeRenderSize(1280, 720, deviceDpr, DPR_CAP);
      const values = resizeUniformValues(size, STAR_BASE_SIZE_PX);
      expect(values.dpr).toBe(size.dpr);
      expect(values.dpr).toBe(Math.min(deviceDpr, DPR_CAP));
      expect(values.pixelSize).toBe(STAR_BASE_SIZE_PX * size.dpr);
      expect([values.viewportWidth, values.viewportHeight]).toEqual([size.width, size.height]);
    }
  });

  it('are written into the Starfield material uniforms on setRenderSize', () => {
    const starfield = new Starfield();
    const size = computeRenderSize(1000, 500, 3, DPR_CAP);
    starfield.setRenderSize(size);
    expect(starfield.uniforms.uDpr.value).toBe(2);
    expect(starfield.uniforms.uPixelSize.value).toBe(STAR_BASE_SIZE_PX * 2);
    expect(starfield.uniforms.uViewport.value.toArray()).toEqual([2000, 1000]);
    starfield.dispose();
  });
});

describe('near star brightness', () => {
  const params = DEFAULT_STARFIELD_OPTIONS;

  it('is dust from the minimum to the maximum, then motes up to the mote maximum, increasing and continuous', () => {
    expect(nearStarBrightness(0, params)).toBe(STAR_BRIGHTNESS_MIN);
    expect(nearStarBrightness(1 - STAR_MOTE_FRACTION, params)).toBeCloseTo(STAR_BRIGHTNESS_MAX, 12);
    expect(nearStarBrightness(1 - 1e-12, params)).toBeCloseTo(STAR_MOTE_BRIGHTNESS_MAX, 9);
    let previous = -Infinity;
    for (let i = 0; i < 10_000; i++) {
      const b = nearStarBrightness(i / 10_000, params);
      expect(b).toBeGreaterThanOrEqual(previous);
      // No step bigger than the slope allows at this resolution (the motes' linear ramp is steepest).
      if (i > 0) expect(b - previous).toBeLessThan(0.01);
      previous = b;
    }
  });

  it('is skewed toward the dim end of the dust range', () => {
    // Quadratic: the median dust star is a quarter of the way up the dust range.
    const median = nearStarBrightness(0.5 * (1 - STAR_MOTE_FRACTION), params);
    expect(median).toBeCloseTo(STAR_BRIGHTNESS_MIN + 0.25 * (STAR_BRIGHTNESS_MAX - STAR_BRIGHTNESS_MIN), 12);
  });
});

describe('starDim', () => {
  it('is 1 at the camera, 1/2 at the dim distance and falls off with distance', () => {
    expect(starDim(0, STAR_DIM_DISTANCE)).toBe(1);
    expect(starDim(STAR_DIM_DISTANCE, STAR_DIM_DISTANCE)).toBe(0.5);
    expect(starDim(2 * STAR_DIM_DISTANCE, STAR_DIM_DISTANCE)).toBeCloseTo(0.2, 12);
    expect(starDim(0.5 * L, STAR_DIM_DISTANCE)).toBeLessThan(starDim(0.25 * L, STAR_DIM_DISTANCE));
  });

  it('mirrors the vertex shader', () => {
    const starfield = new Starfield();
    expect(starfield.mesh.material.vertexShader).toContain(
      'float dim = 1.0 / (1.0 + (dist / uDimDistance) * (dist / uDimDistance));',
    );
    expect(starfield.mesh.material.vertexShader).toContain('vColor = aColor * fade * dim;');
    starfield.dispose();
  });
});

describe('Starfield', () => {
  it('builds one instanced quad per star with positions inside the cube', () => {
    const starfield = new Starfield();
    const geometry = starfield.mesh.geometry;
    expect(geometry.instanceCount).toBe(STAR_COUNT);
    expect(geometry.getIndex()?.count).toBe(6);
    expect(geometry.getAttribute('position').count).toBe(4);
    const stars = geometry.getAttribute('aStar');
    expect(stars.count).toBe(STAR_COUNT);
    for (let i = 0; i < stars.count; i++) {
      for (const v of [stars.getX(i), stars.getY(i), stars.getZ(i)]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(L);
      }
    }
    expect(starfield.mesh.frustumCulled).toBe(false);
    starfield.dispose();
  });

  it('varies size and brightness within the configured ranges, deterministically', () => {
    const a = generateStars(DEFAULT_STARFIELD_OPTIONS);
    const b = generateStars(DEFAULT_STARFIELD_OPTIONS);
    expect(a.positions).toEqual(b.positions);
    const sizes = Array.from(a.sizes);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(Math.fround(STAR_SIZE_MIN));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.fround(STAR_SIZE_MAX));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan((STAR_SIZE_MAX - STAR_SIZE_MIN) / 2);
    const brightness = Array.from({ length: STAR_COUNT }, (_, i) => Math.max(a.colors[i * 3]!, a.colors[i * 3 + 1]!, a.colors[i * 3 + 2]!));
    expect(Math.max(...brightness) - Math.min(...brightness)).toBeGreaterThan(0.3);
    expect(Math.min(...brightness)).toBeGreaterThanOrEqual(Math.fround(STAR_BRIGHTNESS_MIN) - 1e-6);
    expect(Math.max(...brightness)).toBeLessThanOrEqual(Math.fround(STAR_MOTE_BRIGHTNESS_MAX) + 1e-6);
    // Mostly dust: only about STAR_MOTE_FRACTION of the stars are motes brighter than the dust range.
    const motes = brightness.filter((b) => b > STAR_BRIGHTNESS_MAX + 1e-6).length / STAR_COUNT;
    expect(motes).toBeGreaterThan(0.5 * STAR_MOTE_FRACTION);
    expect(motes).toBeLessThan(1.5 * STAR_MOTE_FRACTION);
  });

  it('update() passes the float64 wrap offset and the ship velocity without reallocating', () => {
    const starfield = new Starfield();
    const offset = starfield.uniforms.uOffset.value;
    const velocity = starfield.uniforms.uVelocity.value;
    starfield.update({ position: { x: -1, y: 1e12, z: 2 * L + 5 }, velocity: { x: 1, y: -2, z: -150 } });
    expect(starfield.uniforms.uOffset.value).toBe(offset);
    expect(starfield.uniforms.uVelocity.value).toBe(velocity);
    expect(offset.x).toBeCloseTo(L - 1, 9);
    expect(offset.y).toBe(1e12 % L);
    expect(offset.z).toBeCloseTo(5, 9);
    expect(velocity.toArray()).toEqual([1, -2, -150]);
    starfield.dispose();
  });
});
