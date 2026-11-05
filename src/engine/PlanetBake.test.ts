import { type Camera, type Mesh, type Scene, type WebGLRenderTarget } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { ENCOUNTER_BASE_SEED, PLANET_BAKE_FACE_SIZE, PLANET_BAKE_ROWS_PER_FRAME } from '../config';
import { Planet, disposePlanetGeometry, planetParams, type PlanetType } from './Planet';
import { PlanetBaker, type BakeRenderer } from './PlanetBake';
import { hash } from './seed';

afterEach(() => disposePlanetGeometry());

/** The first seed of the test default trip whose planet is of `type`. */
function seedOf(type: PlanetType): number {
  for (let i = 0; ; i++) if (planetParams(hash(ENCOUNTER_BASE_SEED, i)).type === type) return hash(ENCOUNTER_BASE_SEED, i);
}

interface Draw {
  target: WebGLRenderTarget | null;
  face: number;
  rows: [number, number];
  pass: number;
  uFace: number;
  mipmaps: boolean;
  autoClear: boolean;
  scissorTest: boolean;
}

/** A renderer stand-in that records every bake draw. */
function fakeRenderer() {
  const draws: Draw[] = [];
  let current: WebGLRenderTarget | null = null;
  let face = 0;
  let lost = false;
  const renderer: BakeRenderer = {
    autoClear: true,
    getRenderTarget: () => current,
    setRenderTarget(target, activeCubeFace = 0) {
      current = target;
      face = activeCubeFace;
    },
    render(scene: Scene, _camera: Camera) {
      const quad = scene.children[0] as Mesh;
      const uniforms = (quad.material as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
      const t = current!;
      draws.push({
        target: t,
        face,
        rows: [t.scissor.y, t.scissor.y + t.scissor.w],
        pass: uniforms.uPass!.value,
        uFace: uniforms.uFace!.value,
        mipmaps: t.texture.generateMipmaps,
        autoClear: renderer.autoClear,
        scissorTest: t.scissorTest,
      });
    },
    getContext: () => ({ isContextLost: () => lost }),
  };
  return { renderer, draws, lose: (l: boolean) => (lost = l) };
}

describe('PlanetBaker', () => {
  it.each(['rocky', 'gas'] as const)('bakes a %s planet a slice a frame, every row of every face once, then draws it baked', (type) => {
    const planet = new Planet(planetParams(seedOf(type)), undefined, undefined, { bake: true });
    const bake = planet.bake!;
    const maps = type === 'rocky' ? 2 : 1;
    expect(bake.targets).toHaveLength(maps);
    expect(bake.size).toBe(PLANET_BAKE_FACE_SIZE);
    const { renderer, draws } = fakeRenderer();
    const baker = new PlanetBaker(renderer);
    const frames = (maps * 6 * PLANET_BAKE_FACE_SIZE) / PLANET_BAKE_ROWS_PER_FRAME;
    expect(frames).toBe(maps === 2 ? 96 : 48);
    for (let i = 0; i < frames; i++) {
      expect(planet.isSurfaceBaked()).toBe(false);
      expect(baker.step(planet)).toBe(i === frames - 1);
    }
    expect(planet.isSurfaceBaked()).toBe(true);
    expect(draws).toHaveLength(frames);
    // Each map, face by face, bottom to top, each slice PLANET_BAKE_ROWS_PER_FRAME rows, scissored,
    // with no clear; the map's mips made with its last slice only.
    let i = 0;
    for (let pass = 0; pass < maps; pass++) {
      for (let face = 0; face < 6; face++) {
        for (let row = 0; row < PLANET_BAKE_FACE_SIZE; row += PLANET_BAKE_ROWS_PER_FRAME, i++) {
          const d = draws[i]!;
          expect(d.target).toBe(bake.targets[pass]);
          expect(d.pass).toBe(pass);
          expect([d.face, d.uFace]).toEqual([face, face]);
          expect(d.rows).toEqual([row, row + PLANET_BAKE_ROWS_PER_FRAME]);
          expect(d.scissorTest).toBe(true);
          expect(d.autoClear).toBe(false);
          expect(d.mipmaps).toBe(face === 5 && row + PLANET_BAKE_ROWS_PER_FRAME === PLANET_BAKE_FACE_SIZE);
        }
      }
    }
    // The renderer is left as it was.
    expect(renderer.autoClear).toBe(true);
    expect(renderer.getRenderTarget()).toBeNull();
    // Done: nothing more is drawn.
    expect(baker.step(planet)).toBe(true);
    expect(draws).toHaveLength(frames);
    baker.dispose();
    planet.dispose();
  });

  it('complete() bakes all at once; the quad exists only while a bake is under way', () => {
    const planet = new Planet(planetParams(seedOf('rocky')), undefined, undefined, { bake: true });
    const { renderer, draws } = fakeRenderer();
    const baker = new PlanetBaker(renderer);
    const scene = (baker as unknown as { scene: Scene }).scene;
    baker.step(planet);
    expect(scene.children).toHaveLength(1);
    const quad = scene.children[0] as Mesh;
    let freed = 0;
    quad.geometry.addEventListener('dispose', () => freed++);
    baker.complete(planet);
    expect(planet.bake!.done).toBe(true);
    expect(planet.isSurfaceBaked()).toBe(true);
    // One draw per face and map after the first slice.
    expect(draws).toHaveLength(1 + 12);
    expect(scene.children).toHaveLength(0);
    expect(freed).toBe(1);
    // With no planet, nothing is drawn and nothing is held.
    expect(baker.step(null)).toBe(true);
    expect(scene.children).toHaveLength(0);
    planet.dispose();
  });

  it('draws nothing while the context is lost, and after restartBake() bakes again from the procedural surface', () => {
    const planet = new Planet(planetParams(seedOf('gas')), undefined, undefined, { bake: true });
    const { renderer, draws, lose } = fakeRenderer();
    const baker = new PlanetBaker(renderer);
    const procedural = planet.surfaceMaterial;
    baker.complete(planet);
    expect(planet.surfaceMaterial).not.toBe(procedural);
    planet.restartBake();
    expect(planet.surfaceMaterial).toBe(procedural);
    expect(planet.bake!.rowsDone).toBe(0);
    expect(planet.bake!.targets[0]!.texture.generateMipmaps).toBe(false);
    lose(true);
    const before = draws.length;
    expect(baker.step(planet)).toBe(false);
    expect(draws).toHaveLength(before);
    lose(false);
    baker.complete(planet);
    expect(planet.isSurfaceBaked()).toBe(true);
    planet.dispose();
  });

  it('a planet without a bake is drawn procedurally throughout, and the baker leaves it alone', () => {
    const planet = new Planet(planetParams(seedOf('rocky')));
    expect(planet.bake).toBeNull();
    const { renderer, draws } = fakeRenderer();
    expect(new PlanetBaker(renderer).step(planet)).toBe(true);
    expect(draws).toHaveLength(0);
    expect(planet.isSurfaceBaked()).toBe(false);
    planet.dispose();
  });

  it('frees the cube maps and every material with the planet; the memory is as documented', () => {
    for (const type of ['rocky', 'gas'] as const) {
      const planet = new Planet(planetParams(seedOf(type)), undefined, undefined, { bake: true });
      let freed = 0;
      for (const target of planet.bake!.targets) target.addEventListener('dispose', () => freed++);
      for (const material of planet.materials()) material.addEventListener('dispose', () => freed++);
      const expected = planet.bake!.targets.length + planet.materials().length;
      const mb = planet.bake!.bytes / 1e6;
      expect(mb).toBeCloseTo(type === 'rocky' ? 100.7 : 33.6, 1);
      planet.dispose();
      planet.dispose();
      expect(freed).toBe(expected);
    }
  });
});
