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
