/**
 * Render-size calculation (docs/PLAN.md section 6, Performance): the applied pixel ratio is the
 * device pixel ratio capped at `cap`, and the backing size is the CSS size times that ratio,
 * rounded down the same way `WebGLRenderer.setSize` does. Pure, so it can be tested without WebGL.
 */
export interface RenderSize {
  /** CSS size passed to the renderer, at least 1×1. */
  cssWidth: number;
  cssHeight: number;
  /** Drawing-buffer (canvas backing) size in device pixels. */
  width: number;
  height: number;
  /** Pixel ratio actually applied: min(devicePixelRatio, cap). */
  dpr: number;
}

export function computeRenderSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  cap: number,
): RenderSize {
  const deviceDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const dpr = Number.isFinite(cap) && cap > 0 ? Math.min(deviceDpr, cap) : deviceDpr;
  const w = Number.isFinite(cssWidth) ? Math.max(1, Math.floor(cssWidth)) : 1;
  const h = Number.isFinite(cssHeight) ? Math.max(1, Math.floor(cssHeight)) : 1;
  return {
    cssWidth: w,
    cssHeight: h,
    width: Math.floor(w * dpr),
    height: Math.floor(h * dpr),
    dpr,
  };
}

/**
 * Vertical field of view, in degrees, for a camera whose base vertical field of view is `fovDeg` at
 * aspect ratio `aspect` (width / height), so that the horizontal field of view never exceeds the one
 * at `widestAspect` (config.ts, VIEW_WIDEST_ASPECT). Up to `widestAspect` the vertical field of view
 * is `fovDeg` and a wider screen shows more at the sides; beyond it the vertical field of view narrows
 * to 2·atan(tan(fovDeg / 2) · widestAspect / aspect), so the horizontal one stays at the
 * `widestAspect` one and the whole view stays inside the cone `viewConeHalfAngle(fovDeg, widestAspect)`.
 * An invalid aspect gives `fovDeg`.
 */
export function cameraFovDeg(fovDeg: number, aspect: number, widestAspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= widestAspect) return fovDeg;
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  return (Math.atan((tanHalf * widestAspect) / aspect) * 360) / Math.PI;
}

/**
 * The camera's view as the autopilot tests it (docs/PLAN.md section 9, Phase 4: the encounter's slow
 * phase ends once its object is off the screen): the infinite pyramid from the camera along its
 * forward axis, bounded by its four side planes. The camera looks along the heading with world +Y up
 * (`lookAt`), so this and the heading fix it completely. Plain data, so the pure autopilot can take
 * it in its params (`AutopilotParams.view`); the engine replaces it on every resize.
 */
export interface ViewFrustum {
  /** Width / height of the view. */
  aspect: number;
  /** Half the vertical field of view, in radians, in (0, π/2). */
  halfFovY: number;
}

/**
 * The view of a camera with base vertical field of view `fovDeg` (degrees) on a screen of aspect
 * ratio `aspect` (width / height), as the engine sets it up (`cameraFovDeg`: the vertical field of
 * view narrows beyond `widestAspect`). An invalid aspect gives 1 (a square view).
 */
export function cameraFrustum(fovDeg: number, aspect: number, widestAspect: number): ViewFrustum {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { aspect: a, halfFovY: (cameraFovDeg(fovDeg, a, widestAspect) * Math.PI) / 360 };
}
