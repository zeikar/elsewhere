/**
 * Planet surface baking (issue #65; docs/PLAN.md section 6, Performance and Planets).
 *
 * A planet's procedural surface costs a dozen noise evaluations and a 27-cell crater loop per
 * fragment, every frame, though nothing on it changes but its spin and the lighting. So each planet
 * renders that part of its look once into cube maps (`SurfaceBake` in Planet.ts) and is then drawn
 * from them: a frame samples them at the fragment's object-space direction, so they turn with the
 * planet, and does only the view-dependent work (the seas from the baked height, the lighting).
 *
 * `PlanetBaker` draws the bake, a slice at a time:
 *
 * - Spread over frames: each `step` draws PLANET_BAKE_ROWS_PER_FRAME rows of one face (a quad over
 *   the face, scissored to the slice), so the work is spread over the first 96 frames of a rocky
 *   world (48 of a gas giant), about 1.6 s at 60 FPS, while the planet is still a far-off dot
 *   (#64), and no frame does much of it.
 * - From warmed programs: the bake programs are compiled at start-up with a render target bound
 *   (`planetBakeProgramMaterials`, ProgramWarmup.ts), so a bake never compiles anything; the engine
 *   starts baking only once they are ready.
 * - No pop: until the bake is done the planet draws with its procedural surface, which looks the
 *   same; the frame its last slice is drawn (and its mips made) it switches to the baked surface.
 * - After a WebGL context loss the cube maps' contents are gone: `restartBake` puts the planet back
 *   on its procedural surface and the bake starts over, and `contextRestored` drops the quad.
 *
 * The baker owns only a quad and a camera; the cube maps belong to the planet and are freed with it.
 * The quad's geometry exists only while a bake is under way (it is made for the first slice and
 * freed once no bake is left), so between encounters the GPU holds nothing of the baker's.
 */
import { Mesh, OrthographicCamera, PlaneGeometry, Scene, type Camera, type Material, type WebGLRenderTarget } from 'three';
import { PLANET_BAKE_ROWS_PER_FRAME } from '../config';
import type { Planet } from './Planet';

/** What the baker needs from the renderer (a `WebGLRenderer`). */
export interface BakeRenderer {
  autoClear: boolean;
  getRenderTarget(): WebGLRenderTarget | null;
  setRenderTarget(target: WebGLRenderTarget | null, activeCubeFace?: number): void;
  render(scene: Scene, camera: Camera): void;
  getContext(): { isContextLost(): boolean };
}

export class PlanetBaker {
  private readonly renderer: BakeRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** A quad over the whole face (its vertex shader ignores the matrices), while a bake is under way. */
  private quad: Mesh<PlaneGeometry, Material> | null = null;
  private disposed = false;

  constructor(renderer: BakeRenderer) {
    this.renderer = renderer;
  }

  /**
   * Draws the next `rows` rows of `planet`'s bake (crossing into the next face or map if need be),
   * and switches the planet to its baked surface once the last are drawn. Returns whether the bake is
   * done. Call every frame with the current planet, or `null` without one: with no bake left to draw
   * it frees the quad. A no-op for a planet without a bake, or while the context is lost.
   */
  step(planet: Planet | null, rows: number = PLANET_BAKE_ROWS_PER_FRAME): boolean {
    const bake = planet?.bake ?? null;
    if (planet === null || bake === null || bake.done) {
      planet?.useBakedSurface();
      this.releaseQuad();
      return true;
    }
    const renderer = this.renderer;
    if (this.disposed || renderer.getContext().isContextLost()) return false;
    const quad = this.acquireQuad();
    const size = bake.size;
    const perTarget = 6 * size;
    const uniforms = bake.material.uniforms;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    quad.material = bake.material;
    let budget = Math.max(1, Math.floor(rows));
    while (budget > 0 && !bake.done) {
      const index = Math.floor(bake.rowsDone / perTarget);
      const target = bake.targets[index]!;
      const inTarget = bake.rowsDone - index * perTarget;
      const face = Math.floor(inTarget / size);
      const row = inTarget - face * size;
      const count = Math.min(budget, size - row);
      // The target's last rows: Three.js makes its mips right after drawing them.
      target.texture.generateMipmaps = inTarget + count === perTarget;
      target.scissor.set(0, row, size, count);
      target.scissorTest = true;
      uniforms.uFace!.value = face;
      uniforms.uPass!.value = index;
      renderer.setRenderTarget(target, face);
      renderer.render(this.scene, this.camera);
      bake.rowsDone += count;
      budget -= count;
    }
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    if (bake.done) {
      planet.useBakedSurface();
      this.releaseQuad();
    }
    return bake.done;
  }

  /** Draws the whole of `planet`'s bake now (previews and benchmarks, which draw a single frame). */
  complete(planet: Planet): void {
    const bake = planet.bake;
    if (bake !== null) this.step(planet, bake.rowsTotal);
  }

  /**
   * After a WebGL context restore: forgets the quad without freeing it. Its GPU buffers died with the
   * old context, and freeing it would have Three.js delete them there (an INVALID_OPERATION); the
   * next slice makes a new one.
   */
  contextRestored(): void {
    if (this.quad === null) return;
    this.scene.remove(this.quad);
    this.quad = null;
  }

  /** Frees the quad. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseQuad();
  }

  private acquireQuad(): Mesh<PlaneGeometry, Material> {
    if (this.quad === null) {
      this.quad = new Mesh(new PlaneGeometry(2, 2));
      this.quad.frustumCulled = false;
      this.scene.add(this.quad);
    }
    return this.quad;
  }

  private releaseQuad(): void {
    if (this.quad === null) return;
    this.scene.remove(this.quad);
    this.quad.geometry.dispose();
    this.quad = null;
  }
}
