import { describe, expect, it } from 'vitest';
import { asteroidParams } from './Asteroid';
import {
  CRATER_DEPTH,
  CRATER_RIM,
  LUMP_FREQUENCY,
  irregularBodyGeometry,
  irregularBodyRadii,
  type IrregularBodyShape,
} from './irregularBody';
import { hash } from './seed';

/** 32-bit FNV-1a over `bytes`, continuing from `h`. */
function fnv(bytes: Uint8Array, h: number): number {
  let x = h;
  for (let i = 0; i < bytes.length; i++) {
    x ^= bytes[i]!;
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x >>> 0;
}

const bytes = (array: Float32Array | Float64Array | Uint16Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

describe('irregular bodies (shared by asteroid rocks and comet nuclei)', () => {
  it("leaves every asteroid rock's geometry exactly as it was before comets (pinned checksum)", () => {
    // FNV-1a of the position, normal and index bytes of every rock of 40 seeded asteroids, and of
    // their radii before scaling, computed with the asteroid code as merged in #48 (before the
    // geometry moved to irregularBody.ts and the shape gained its optional fields). Any change to the
    // shared geometry that touches an asteroid changes these.
    let geometryHash = 0x811c9dc5;
    let radiiHash = 0x811c9dc5;
    let rocks = 0;
    for (let i = 0; i < 40; i++) {
      for (const rock of asteroidParams(hash(0x601de, i)).rocks) {
        const geometry = irregularBodyGeometry(rock.shape);
        geometryHash = fnv(bytes(geometry.getAttribute('position').array as Float32Array), geometryHash);
        geometryHash = fnv(bytes(geometry.getAttribute('normal').array as Float32Array), geometryHash);
        geometryHash = fnv(bytes(geometry.getIndex()!.array as Uint16Array), geometryHash);
        radiiHash = fnv(bytes(irregularBodyRadii(rock.shape)), radiiHash);
        geometry.dispose();
        rocks++;
      }
    }
    expect(rocks).toBeGreaterThan(60);
    expect(geometryHash.toString(16)).toBe('f759b2e1');
    expect(radiiHash.toString(16)).toBe('e5b2c58');
  });

  it('the optional shape fields default to the rocks’ values, and each changes the body when set', () => {
    const shape: IrregularBodyShape = { seed: 0xc0e7, detail: 4, axes: [1, 0.7, 0.5], lumpiness: 0.4, craterCount: 3, craterSize: [0.3, 0.5] };
    const plain = Array.from(irregularBodyRadii(shape));
    expect(Array.from(irregularBodyRadii({ ...shape, craterDepth: CRATER_DEPTH, craterRim: CRATER_RIM, lumpFrequency: LUMP_FREQUENCY }))).toEqual(plain);
    const meanChange = (other: Partial<IrregularBodyShape>) => {
      const r = irregularBodyRadii({ ...shape, ...other });
      return plain.reduce((sum, x, i) => sum + Math.abs(x - r[i]!), 0) / plain.length;
    };
    expect(meanChange({ craterDepth: 0.2 })).toBeGreaterThan(1e-3);
    expect(meanChange({ craterRim: 0.05 })).toBeGreaterThan(1e-4);
    expect(meanChange({ lumpFrequency: [0.9, 1.4] })).toBeGreaterThan(1e-2);
  });
});
