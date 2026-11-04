/**
 * Seeded randomness (docs/PLAN.md section 6): a small PRNG for layouts, and `hash(baseSeed, index)`
 * for per-encounter seeds. Pure 32-bit integer maths, with no DOM or WebGL dependencies.
 */

/** Small seeded PRNG (mulberry32): deterministic sequences such as the star layout. Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit integer finaliser ("lowbias32", Chris Wellons). A bijection on uint32 with good avalanche. */
function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Seed for item `index` of the sequence started by `baseSeed` (for example an encounter's appearance
 * seed, docs/PLAN.md section 6, Planets). Returns a uint32.
 *
 * Both inputs are taken as uint32 (`>>> 0`). For a fixed `baseSeed` the map from index to hash is a
 * bijection, so indices below 2^32 never collide.
 */
export function hash(baseSeed: number, index: number): number {
  return mix32((mix32((index + 0x9e3779b9) >>> 0) ^ baseSeed) >>> 0);
}

/** `hash(baseSeed, index)` scaled to [0, 1). */
export function hashUnit(baseSeed: number, index: number): number {
  return hash(baseSeed, index) / 4294967296;
}
