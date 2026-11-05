/**
 * GPU frame timing (docs/PLAN.md section 6, Performance: trust real measurements over the target).
 *
 * Where the browser has `EXT_disjoint_timer_query_webgl2`, `begin()` and `end()` bracket a frame's
 * GPU work (the encounter bake slice, if any, and the render) with a `TIME_ELAPSED` query. A query's
 * result is ready a few frames later, so `poll()` reads every finished query, oldest first, and hands
 * each frame's GPU time in milliseconds to a callback (the engine records them in a `FrameStats`).
 * Results that a disjoint event spoilt (the GPU was reset, throttled or switched) are dropped: a
 * disjoint event spoils every query in flight, so on one, `poll()` drops them all.
 *
 * Off by default: the engine makes one only on request (`EngineOptions.gpuTiming`, which the e2e
 * build reads from `?gpuTiming=1`). Where the extension is missing (Safari, for one) `supported` is
 * false and every call is a no-op; the e2e hook then falls back to an estimate (src/e2eGpuCost.ts).
 *
 * Queries are pooled in a fixed ring, so nothing is allocated per frame. When the ring is full (the
 * GPU is many frames behind), a frame goes untimed rather than growing the ring.
 */

/** The parts of `EXT_disjoint_timer_query_webgl2` used here. */
interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Queries in flight at most: about a quarter of a second at 60 FPS. */
const RING_SIZE = 16;

export class GpuTimer {
  /** Whether the extension is there, so frames are timed. */
  readonly supported: boolean;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExtension | null;
  private readonly ring: (WebGLQuery | null)[] = new Array<WebGLQuery | null>(RING_SIZE).fill(null);
  /** Index of the oldest query in flight, and how many are in flight. */
  private head = 0;
  private pending = 0;
  private active = false;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null;
    this.supported = this.ext !== null;
  }

  /** Starts timing a frame's GPU work. A no-op if unsupported, already timing, or every query is in flight. */
  begin(): void {
    const ext = this.ext;
    if (ext === null || this.active || this.disposed || this.pending >= RING_SIZE || this.gl.isContextLost()) return;
    const slot = (this.head + this.pending) % RING_SIZE;
    let query = this.ring[slot] ?? null;
    if (query === null) {
      query = this.gl.createQuery();
      this.ring[slot] = query;
    }
    if (query === null) return;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.active = true;
  }

  /** Stops timing the frame started by `begin()`. */
  end(): void {
    const ext = this.ext;
    if (ext === null || !this.active) return;
    this.active = false;
    if (this.gl.isContextLost()) return;
    this.gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pending++;
  }

  /**
   * Hands every finished frame's GPU time (ms), oldest first, to `record`, and frees its query for
   * reuse. Stops at the first unfinished one. Allocates nothing.
   */
  poll(record: (ms: number) => void): void {
    const ext = this.ext;
    if (ext === null || this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost()) {
      // The queries died with the context; start over once it is back.
      this.ring.fill(null);
      this.head = 0;
      this.pending = 0;
      this.active = false;
      return;
    }
    while (this.pending > 0) {
      const query = this.ring[this.head]!;
      if (!(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) break;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean) {
        // Every query in flight is spoilt, finished or not: drop them all (their queries are reused,
        // which discards any result still to come).
        this.head = (this.head + this.pending) % RING_SIZE;
        this.pending = 0;
        break;
      }
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      this.head = (this.head + 1) % RING_SIZE;
      this.pending--;
      record(ns / 1e6);
    }
  }

  /**
   * Stops timing without a WebGL call: after a context restore the queries belong to the lost
   * context, and deleting them there is an INVALID_OPERATION. They are simply dropped.
   */
  abandon(): void {
    this.disposed = true;
    this.active = false;
    this.pending = 0;
    this.ring.fill(null);
  }

  /** Deletes the queries. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active && this.ext !== null && !this.gl.isContextLost()) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
    if (!this.gl.isContextLost()) for (const query of this.ring) if (query !== null) this.gl.deleteQuery(query);
    this.ring.fill(null);
  }
}
