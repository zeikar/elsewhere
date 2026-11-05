import { AdditiveBlending, Matrix3, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  DPR_CAP,
  DT_CAP_SECONDS,
  FAR_STAR_BASE_SIZE_PX,
  FAR_STAR_COUNT,
  FAR_STAR_SIZE_MAX,
  FAR_STAR_SIZE_MIN,
  SHIP_SPEED_LEVELS,
  STAR_COUNT,
  STAR_CUBE_SIZE,
  STAR_DIM_DISTANCE,
  STAR_EDGE_FADE_WIDTH,
  STAR_NEAR_FADE_DISTANCE,
} from '../config';
import { DEFAULT_AUTOPILOT_PARAMS, createTravel, setCruiseSpeed, stepTravel } from './Autopilot';
import {
  DEFAULT_FAR_STARFIELD_OPTIONS,
  FAR_STARFIELD_RENDER_ORDER,
  FAR_STAR_TINTS,
  FarStarfield,
  farStarTint,
  farStarViewDirection,
  generateFarStars,
} from './FarStarfield';
import { NEBULA_RENDER_ORDER } from './Nebula';
import { ATMOSPHERE_RENDER_ORDER, SURFACE_RENDER_ORDER } from './Planet';
import { computeRenderSize } from './renderSize';
import { DEFAULT_SHIP_PARAMS, type Vec3 } from './Ship';
import {
  DEFAULT_STARFIELD_OPTIONS,
  STARFIELD_RENDER_ORDER,
  computeWrapOffset,
  generateStars,
  starDim,
  starFade,
  wrapStarCoordinate,
} from './Starfield';

/** The first `n` far-star directions. */
function directions(n: number): Vec3[] {
  const { directions: d } = generateFarStars(DEFAULT_FAR_STARFIELD_OPTIONS);
  return Array.from({ length: n }, (_, i) => ({ x: d[i * 3]!, y: d[i * 3 + 1]!, z: d[i * 3 + 2]! }));
}

/** Rec. 709 luminance of star `i`'s colour (rgb triples in `colors`). */
function luminance(colors: Float32Array, i: number): number {
  return 0.2126 * colors[i * 3]! + 0.7152 * colors[i * 3 + 1]! + 0.0722 * colors[i * 3 + 2]!;
}

/**
 * Colour temperature of star `i`: (red - blue) / brightest channel. 0 is neutral, negative is
 * bluish, positive is warm (yellow to orange).
 */
function warmth(colors: Float32Array, i: number): number {
  const [r, g, b] = [colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!];
  return (r - b) / Math.max(r, g, b);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** The value below which a fraction `p` of `values` lies. */
function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))]!;
}

/** A camera like the engine's: at the origin, looking along `heading`, matrices up to date. */
function engineCamera(heading: Readonly<Vec3>): PerspectiveCamera {
  const camera = new PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(0, 0, 0);
  camera.lookAt(heading.x, heading.y, heading.z);
  camera.updateMatrixWorld();
  return camera;
}

function viewDirections(stars: readonly Vec3[], camera: PerspectiveCamera): Vec3[] {
  return stars.map((d) => farStarViewDirection(d, camera.matrixWorldInverse, { x: 0, y: 0, z: 0 }));
}

describe('far star layout', () => {
  it('is deterministic, with unit directions spread evenly over the sphere', () => {
    const a = generateFarStars(DEFAULT_FAR_STARFIELD_OPTIONS);
    const b = generateFarStars(DEFAULT_FAR_STARFIELD_OPTIONS);
    expect(a.directions).toEqual(b.directions);
    expect(a.colors).toEqual(b.colors);
    const n = FAR_STAR_COUNT;
    const octants = new Array<number>(8).fill(0);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = [a.directions[i * 3]!, a.directions[i * 3 + 1]!, a.directions[i * 3 + 2]!];
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
      octants[(x > 0 ? 1 : 0) + (y > 0 ? 2 : 0) + (z > 0 ? 4 : 0)]!++;
    }
    // Uniform on the sphere: every octant holds about an eighth of the stars.
    for (const count of octants) expect(Math.abs(count - n / 8)).toBeLessThan(0.15 * (n / 8));
  });

  it('varies size and brightness within the configured ranges', () => {
    const { sizes, colors } = generateFarStars(DEFAULT_FAR_STARFIELD_OPTIONS);
    const s = Array.from(sizes);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(Math.fround(FAR_STAR_SIZE_MIN));
    expect(Math.max(...s)).toBeLessThanOrEqual(Math.fround(FAR_STAR_SIZE_MAX));
    expect(Math.max(...s) - Math.min(...s)).toBeGreaterThan((FAR_STAR_SIZE_MAX - FAR_STAR_SIZE_MIN) / 2);
    const brightness = Array.from({ length: FAR_STAR_COUNT }, (_, i) => Math.max(colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!));
    expect(Math.max(...brightness) - Math.min(...brightness)).toBeGreaterThan(0.5);
  });
});

describe('far star colours', () => {
  it('have tints whose shares sum to 1 and that keep the brightest channel at 1', () => {
    expect(FAR_STAR_TINTS.reduce((sum, t) => sum + t.weight, 0)).toBeCloseTo(1, 12);
    for (const { rgb, weight } of FAR_STAR_TINTS) {
      expect(Math.max(...rgb)).toBe(1);
      expect(weight).toBeGreaterThan(0);
    }
    // farStarTint gives each tint a share of [0, 1) equal to its weight.
    const counts = new Map<readonly number[], number>();
    for (let i = 0; i < 10_000; i++) {
      const tint = farStarTint((i + 0.5) / 10_000);
      counts.set(tint, (counts.get(tint) ?? 0) + 1);
    }
    for (const { rgb, weight } of FAR_STAR_TINTS) expect((counts.get(rgb) ?? 0) / 10_000).toBeCloseTo(weight, 3);
    expect(farStarTint(1 - 1e-15)).toBe(FAR_STAR_TINTS[FAR_STAR_TINTS.length - 1]!.rgb);
  });
});

/**
 * Sky legibility (docs/PLAN.md section 9, Phase 4): the near dust is drawn dimmer than the far stars,
 * which have a visible colour variance, so the far stars read as the sky. These check the generated
 * per-star colour attributes (aColor, the shader's only colour input for both layers) and, for the
 * near layer, the colour after the shader's own dimming in a static frame at rest.
 */
describe('sky legibility', () => {
  const near = generateStars(DEFAULT_STARFIELD_OPTIONS);
  const far = generateFarStars(DEFAULT_FAR_STARFIELD_OPTIONS);
  const nearLuminance = Array.from({ length: STAR_COUNT }, (_, i) => luminance(near.colors, i));
  const farLuminance = Array.from({ length: FAR_STAR_COUNT }, (_, i) => luminance(far.colors, i));

  /**
   * Near-star luminance as the vertex shader outputs it at rest (the ship at the origin, so the wrap
   * offset is 0): aColor × starFade × starDim, with the TS mirrors of the shader's fade and
   * distance dimming. The far layer's shader outputs aColor as is (no fade, no dimming).
   */
  const nearAtRest = Array.from({ length: STAR_COUNT }, (_, i) => {
    const [x, y, z] = [0, 1, 2].map((c) => wrapStarCoordinate(near.positions[i * 3 + c]!, 0, STAR_CUBE_SIZE)) as [number, number, number];
    const fade = starFade(x, y, z, {
      cubeSize: STAR_CUBE_SIZE,
      edgeFadeWidth: STAR_EDGE_FADE_WIDTH,
      nearFadeDistance: STAR_NEAR_FADE_DISTANCE,
    });
    return nearLuminance[i]! * fade * starDim(Math.hypot(x, y, z), STAR_DIM_DISTANCE);
  });

  it('the mean per-star luminance of the near dust is clearly below the far stars, before and after the shader dims it', () => {
    const farMean = mean(farLuminance);
    // In the colour attributes alone, the dust averages under 60% of the far stars (about 46%).
    expect(mean(nearLuminance)).toBeLessThan(0.6 * farMean);
    // As drawn in a static frame at rest, under a quarter (about 12%).
    expect(mean(nearAtRest)).toBeLessThan(0.25 * farMean);
    // Not just on average: at rest 99% of the dust is dimmer than the median far star.
    expect(quantile(nearAtRest, 0.99)).toBeLessThan(quantile(farLuminance, 0.5));
  });

  it('the far stars have a bright tail that stands out from the dust', () => {
    // A few far stars are bright: at least 5% at 0.8 or more (about 7%), and the brightest reach
    // well past anything the dust shows at rest.
    expect(farLuminance.filter((l) => l >= 0.8).length / FAR_STAR_COUNT).toBeGreaterThan(0.05);
    expect(quantile(farLuminance, 0.99)).toBeGreaterThan(1.5 * Math.max(...nearAtRest));
  });

  it('the far stars have visible colour variance, while the dust is nearly neutral', () => {
    const farWarmth = Array.from({ length: FAR_STAR_COUNT }, (_, i) => warmth(far.colors, i));
    const nearWarmth = Array.from({ length: STAR_COUNT }, (_, i) => warmth(near.colors, i));
    // Blue-white through orange: a clear spread, with both cool and warm stars well represented.
    expect(standardDeviation(farWarmth)).toBeGreaterThan(0.2);
    expect(farWarmth.filter((w) => w < -0.2).length / FAR_STAR_COUNT).toBeGreaterThan(0.1);
    expect(farWarmth.filter((w) => w > 0.3).length / FAR_STAR_COUNT).toBeGreaterThan(0.1);
    expect(farWarmth.filter((w) => w > 0.45).length / FAR_STAR_COUNT).toBeGreaterThan(0.05);
    // The dust keeps only a trace of tint.
    for (const w of nearWarmth) expect(Math.abs(w)).toBeLessThanOrEqual(0.1);
    expect(standardDeviation(farWarmth)).toBeGreaterThan(3 * standardDeviation(nearWarmth));
  });
});

describe('far star view directions', () => {
  it('farStarViewDirection is the rotation part of the view matrix applied to the direction', () => {
    const camera = engineCamera({ x: 0.3, y: -0.2, z: -0.93 });
    const rotation = new Matrix3().setFromMatrix4(camera.matrixWorldInverse);
    for (const d of directions(50)) {
      const expected = new Vector3(d.x, d.y, d.z).applyMatrix3(rotation);
      const got = farStarViewDirection(d, camera.matrixWorldInverse, { x: 0, y: 0, z: 0 });
      expect(got.x).toBeCloseTo(expected.x, 12);
      expect(got.y).toBeCloseTo(expected.y, 12);
      expect(got.z).toBeCloseTo(expected.z, 12);
    }
  });

  it("do not change under pure translation of the ship, while the near stars' wrapped positions do", () => {
    // The engine's simulation with the heading drift off: the ship only translates, at the top speed.
    const autopilotParams = { ...DEFAULT_AUTOPILOT_PARAMS, interval: 1e9 };
    setCruiseSpeed(autopilotParams, SHIP_SPEED_LEVELS[SHIP_SPEED_LEVELS.length - 1]!);
    const travel = createTravel(autopilotParams, { ...DEFAULT_SHIP_PARAMS, yawAmplitude: 0, pitchAmplitude: 0 });
    for (let i = 0; i < 20; i++) stepTravel(travel, DT_CAP_SECONDS);
    const stars = directions(200);
    const ship = travel.ship;
    const before = viewDirections(stars, engineCamera(ship.heading));
    const startPosition = { ...ship.position };
    const startHeading = { ...ship.heading };
    for (let i = 0; i < 600; i++) stepTravel(travel, DT_CAP_SECONDS);
    // A long way (several star cubes), with the heading unchanged.
    const moved = Math.hypot(ship.position.x - startPosition.x, ship.position.y - startPosition.y, ship.position.z - startPosition.z);
    expect(moved).toBeGreaterThan(5 * STAR_CUBE_SIZE);
    expect(ship.heading).toEqual(startHeading);

    // Camera at the origin (floating origin), and also a camera actually moved to the ship's
    // position: the far stars use the rotation only, so neither moves them by any amount.
    // This bit-identical check is structural: it runs the TypeScript mirror (farStarViewDirection),
    // which only ever reads the rotation part of the view matrix. What guards the GPU is the
    // shader-source check below ('builds one instanced quad per star, with no ship-dependent
    // uniform') and the pixel e2e in e2e/starfield.spec.ts.
    const atOrigin = engineCamera(ship.heading);
    const translated = engineCamera(ship.heading);
    translated.position.set(ship.position.x, ship.position.y, ship.position.z);
    translated.updateMatrixWorld();
    expect(viewDirections(stars, atOrigin)).toEqual(before);
    expect(viewDirections(stars, translated)).toEqual(before);

    // The near layer over the same translation: its wrapped star positions move.
    const o0 = computeWrapOffset(startPosition, STAR_CUBE_SIZE, { x: 0, y: 0, z: 0 });
    const o1 = computeWrapOffset(ship.position, STAR_CUBE_SIZE, { x: 0, y: 0, z: 0 });
    const nearZ0 = wrapStarCoordinate(100, o0.z, STAR_CUBE_SIZE);
    const nearZ1 = wrapStarCoordinate(100, o1.z, STAR_CUBE_SIZE);
    expect(Math.abs(nearZ1 - nearZ0)).toBeGreaterThan(1);
  });

  it('do change with the camera rotation', () => {
    const stars = directions(20);
    const a = viewDirections(stars, engineCamera({ x: 0, y: 0, z: -1 }));
    const b = viewDirections(stars, engineCamera({ x: Math.sin(0.05), y: 0, z: -Math.cos(0.05) }));
    // A 0.05 rad yaw turns every direction by at most 0.05 rad (exactly that for those level with it).
    let largest = 0;
    for (let i = 0; i < stars.length; i++) {
      const dot = a[i]!.x * b[i]!.x + a[i]!.y * b[i]!.y + a[i]!.z * b[i]!.z;
      const angle = Math.acos(Math.min(1, dot));
      expect(angle).toBeGreaterThan(0);
      expect(angle).toBeLessThanOrEqual(0.05 + 1e-9);
      largest = Math.max(largest, angle);
    }
    expect(largest).toBeGreaterThan(0.04);
  });
});

describe('FarStarfield', () => {
  it('builds one instanced quad per star, with no ship-dependent uniform', () => {
    const far = new FarStarfield();
    const geometry = far.mesh.geometry;
    expect(geometry.instanceCount).toBe(FAR_STAR_COUNT);
    expect(geometry.getIndex()?.count).toBe(6);
    expect(geometry.getAttribute('position').count).toBe(4);
    expect(geometry.getAttribute('aDirection').count).toBe(FAR_STAR_COUNT);
    expect(far.mesh.frustumCulled).toBe(false);
    // Nothing about the ship's position or velocity reaches the far layer, and the shader turns the
    // directions by the view rotation only (mirrored by farStarViewDirection). There is no time
    // uniform either: the far stars never twinkle, so reduced motion has nothing to turn off.
    expect(Object.keys(far.uniforms).sort()).toEqual(['uDepth', 'uDpr', 'uPixelSize', 'uViewport']);
    const vertex = far.mesh.material.vertexShader;
    expect(vertex).toContain('mat3(viewMatrix) * aDirection');
    for (const name of ['modelViewMatrix', 'cameraPosition', 'modelMatrix']) expect(vertex).not.toContain(name);
    far.dispose();
  });

  it('draws first, additively and without depth writes, so it never hides anything', () => {
    const far = new FarStarfield();
    const material = far.mesh.material;
    expect(far.mesh.renderOrder).toBe(FAR_STARFIELD_RENDER_ORDER);
    for (const order of [SURFACE_RENDER_ORDER, NEBULA_RENDER_ORDER, STARFIELD_RENDER_ORDER, ATMOSPHERE_RENDER_ORDER]) {
      expect(FAR_STARFIELD_RENDER_ORDER).toBeLessThan(order);
    }
    expect(material.transparent).toBe(true);
    expect(material.blending).toBe(AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);
    // Just inside the far plane: behind everything, but not clipped.
    expect(far.uniforms.uDepth.value).toBeLessThan(1);
    expect(far.uniforms.uDepth.value).toBeGreaterThan(0.9999);
    far.dispose();
  });

  it('setRenderSize writes the applied DPR, pixel size = base size × applied DPR and the viewport into its uniforms', () => {
    const far = new FarStarfield();
    for (const deviceDpr of [1, 2, 3]) {
      const size = computeRenderSize(1000, 500, deviceDpr, DPR_CAP);
      far.setRenderSize(size);
      expect(far.uniforms.uDpr.value).toBe(size.dpr);
      expect(far.uniforms.uPixelSize.value).toBe(FAR_STAR_BASE_SIZE_PX * size.dpr);
      expect(far.uniforms.uViewport.value.toArray()).toEqual([size.width, size.height]);
    }
    far.dispose();
  });
});
