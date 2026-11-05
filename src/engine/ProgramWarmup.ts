/**
 * Encounter shader programs, compiled once and kept for the whole run (docs/PLAN.md section 6,
 * Performance: reuse, and trust real measurements).
 *
 * Three.js frees a shader program when the last material using it is disposed. Each encounter
 * object owns its materials and disposes them when the encounter ends, so without this every
 * encounter compiled its programs again. The encounter view hides a new object until
 * `renderer.compileAsync` settles, but compileAsync can only wait for the compile where
 * `KHR_parallel_shader_compile` is available. Where it is not (SwiftShader, for one), it settles at
 * once, and the first frame that drew the object stalled on the link: 160–670 ms per planet under
 * SwiftShader, measured with the frame instrumentation (`Engine.getFrameWork()`).
 *
 * `ProgramWarmup` holds one material per encounter program (the rocky and gas planet surfaces, the
 * atmosphere and the nebula layers), built by the same factories as the real materials so each
 * compiles to the very program they use. They are compiled (and primed, see `compile`) at start-up
 * and never disposed until the engine is, so every planet and nebula finds its program already
 * linked, and so does every asteroid, whose rocks draw with the rocky surface program: no encounter
 * compiles anything, and the program count stays constant from start-up on.
 * The holders are never drawn.
 *
 * Three.js derives part of a program from the geometry's attributes (whether it has normals, for
 * one), so the holders' geometry has the same attributes as the planet sphere and the nebula plane
 * (`position`, `normal`, `uv`), but empty: no buffers are uploaded (or counted in
 * `renderer.info.memory`).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
} from 'three';

/** What the warm-up needs from the renderer (a `WebGLRenderer`). */
export interface ProgramCompiler {
  compileAsync(object: Object3D, camera: Camera, scene: Scene): PromiseLike<unknown>;
  /** Three.js' per-object renderer state; a compiled material's entry holds its `currentProgram`. */
  properties: { get(object: object): unknown };
}

export class ProgramWarmup {
  /** The holder meshes (not part of any scene). */
  readonly object = new Group();
  private readonly geometry = holderGeometry();
  private readonly materials: readonly Material[];
  private disposed = false;

  constructor(materials: readonly Material[]) {
    this.materials = materials;
    for (const material of materials) this.object.add(new Mesh(this.geometry, material));
  }

  /**
   * Compiles every held program for drawing in `scene` from `camera`, then primes it: Three.js reads
   * a program's uniform locations (and checks it for errors) the first time it is used, with
   * synchronous WebGL calls that wait for the GPU to finish everything queued before them. Left to
   * the first frame that draws an encounter, that wait stalled the frame by about one frame time;
   * here it happens once, at start-up. Settles when done; never rejects.
   */
  compile(renderer: ProgramCompiler, camera: Camera, scene: Scene): Promise<void> {
    if (this.disposed) return Promise.resolve();
    let pending: PromiseLike<unknown>;
    try {
      pending = renderer.compileAsync(this.object, camera, scene);
    } catch {
      return Promise.resolve();
    }
    return Promise.resolve(pending).then(
      () => {
        if (!this.disposed) this.prime(renderer);
      },
      () => undefined,
    );
  }

  /** Makes Three.js do each program's first-use work now (see `compile`). Tolerates any renderer state. */
  private prime(renderer: ProgramCompiler): void {
    for (const material of this.materials) {
      const entry = renderer.properties.get(material) as { currentProgram?: { getUniforms?: () => unknown } } | undefined;
      try {
        entry?.currentProgram?.getUniforms?.();
      } catch {
        // Priming is an optimisation only; the first draw does the same work if this cannot.
      }
    }
  }

  /** Frees the held materials (and with them the programs, once no encounter uses them). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const material of this.materials) material.dispose();
    this.geometry.dispose();
    this.object.clear();
  }
}

/** An empty geometry with the attributes of the encounter geometries (Three.js primitives). */
export function holderGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(0), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(0), 2));
  return geometry;
}
