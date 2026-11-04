import { describe, expect, it } from 'vitest';
import { ENCOUNTER_BASE_SEED } from '../config';
import { hash, hashUnit, mulberry32 } from './seed';

const N = 10_000;

describe('hash', () => {
  it('is deterministic and returns uint32 values', () => {
    for (const seed of [0, 1, ENCOUNTER_BASE_SEED, 0xffff_ffff]) {
      for (let i = 0; i < 100; i++) {
        const h = hash(seed, i);
        expect(hash(seed, i)).toBe(h);
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(2 ** 32);
      }
    }
  });

  it('has no collisions across the first 10,000 indices', () => {
    for (const seed of [0, ENCOUNTER_BASE_SEED]) {
      const seen = new Set<number>();
      for (let i = 0; i < N; i++) seen.add(hash(seed, i));
      expect(seen.size).toBe(N);
    }
  });

  it('gives well-distributed normalised outputs', () => {
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const u = hashUnit(ENCOUNTER_BASE_SEED, i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
      buckets[Math.floor(u * 10)]!++;
    }
    // Standard error of the mean of N uniforms is about 0.0029.
    expect(Math.abs(sum / N - 0.5)).toBeLessThan(0.01);
    // Each decile expects 1,000 hits (standard deviation about 30).
    for (const count of buckets) expect(Math.abs(count - N / 10)).toBeLessThan(150);
  });

  it('consecutive indices and different base seeds give unrelated values', () => {
    let flips = 0;
    for (let i = 0; i < 1000; i++) {
      // Hamming distance between neighbours: about 16 of 32 bits for a good mixer.
      let x = (hash(ENCOUNTER_BASE_SEED, i) ^ hash(ENCOUNTER_BASE_SEED, i + 1)) >>> 0;
      while (x) {
        flips += x & 1;
        x >>>= 1;
      }
    }
    expect(flips / 1000).toBeGreaterThan(14);
    expect(flips / 1000).toBeLessThan(18);

    let same = 0;
    for (let i = 0; i < 1000; i++) if (hash(1, i) === hash(2, i)) same++;
    expect(same).toBe(0);
  });
});

describe('mulberry32', () => {
  it('is deterministic per seed and returns values in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(b()).toBe(v);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
