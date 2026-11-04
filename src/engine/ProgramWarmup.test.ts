import { PerspectiveCamera, Scene, type BufferGeometry, type Material, type Object3D, type ShaderMaterial } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { ENCOUNTER_BASE_SEED } from '../config';
import { Nebula, disposeNebulaGeometry, nebulaGeometry, nebulaParams, nebulaProgramMaterials } from './Nebula';
import { Planet, disposePlanetGeometry, planetGeometry, planetParams, planetProgramMaterials } from './Planet';
import { ProgramWarmup, holderGeometry, type ProgramCompiler } from './ProgramWarmup';
import { hash } from './seed';

afterEach(() => {
  disposePlanetGeometry();
  disposeNebulaGeometry();
});

/**
 * What Three.js builds a ShaderMaterial's program from (WebGLPrograms.getProgramCacheKey): the
 * shader sources and defines, and the material flags that change the generated code. Two materials
 * with the same signature on geometries with the same attributes share one program.
 */
function programSignature(material: Material): string {
  const m = material as ShaderMaterial;
  return JSON.stringify({
    type: m.type,
    vertexShader: m.vertexShader,
    fragmentShader: m.fragmentShader,
    defines: m.defines,
    side: m.side,
    opaque: m.transparent === false && m.blending === 1 && m.alphaToCoverage === false,
    premultipliedAlpha: m.premultipliedAlpha,
    alphaToCoverage: m.alphaToCoverage,
    toneMapped: m.toneMapped,
    vertexColors: m.vertexColors,
    fog: m.fog,
    lights: m.lights,
    clipping: m.clipping,
    flatShading: (m as { flatShading?: boolean }).flatShading,
    wireframe: m.wireframe,
    glslVersion: m.glslVersion,
    extensions: m.extensions,
    cacheKey: m.customProgramCacheKey(),
  });
}

/** The attribute layout Three.js reads from a geometry when it builds a program. */
function attributeLayout(geometry: BufferGeometry): string {
  const attributes = Object.entries(geometry.attributes)
    .map(([name, a]) => `${name}:${a.itemSize}`)
    .sort();
  return JSON.stringify({ attributes, morph: Object.keys(geometry.morphAttributes) });
}

function materialsOf(root: Object3D): Material[] {
  const out: Material[] = [];
  root.traverse((o) => {
    const material = (o as { material?: Material }).material;
    if (material !== undefined) out.push(material);
  });
  return out;
}

/** The first planet seeds of each type, with an atmosphere. */
function planetSeeds(): { rocky: number; gas: number } {
  const found: { rocky?: number; gas?: number } = {};
  for (let i = 0; found.rocky === undefined || found.gas === undefined; i++) {
    const seed = hash(ENCOUNTER_BASE_SEED, i);
    const params = planetParams(seed);
    if (params.atmosphereIntensity > 0) found[params.type] ??= seed;
  }
  return { rocky: found.rocky, gas: found.gas };
}

describe('encounter program holders', () => {
  it('hold exactly the programs real planets and nebulae use', () => {
    const holders = new Set([...planetProgramMaterials(), ...nebulaProgramMaterials()].map(programSignature));
    expect(holders.size).toBe(4);

    const seeds = planetSeeds();
    const used = new Set<string>();
    for (const seed of [seeds.rocky, seeds.gas]) {
      const planet = new Planet(planetParams(seed));
      for (const m of materialsOf(planet.object)) used.add(programSignature(m));
      planet.dispose();
    }
    for (let i = 0; i < 20; i++) {
      const nebula = new Nebula(nebulaParams(hash(ENCOUNTER_BASE_SEED, 1000 + i)));
      for (const m of materialsOf(nebula.object)) used.add(programSignature(m));
      nebula.dispose();
    }
    // Every program an encounter draws with is held, and every holder is one an encounter uses.
    expect(used).toEqual(holders);
  });

  it('use a geometry with the attributes of the planet sphere and the nebula plane, but no data', () => {
    const holder = holderGeometry();
    expect(attributeLayout(holder)).toBe(attributeLayout(planetGeometry()));
    expect(attributeLayout(holder)).toBe(attributeLayout(nebulaGeometry()));
    for (const attribute of Object.values(holder.attributes)) expect(attribute.count).toBe(0);
    holder.dispose();
  });
});

/** A renderer stand-in: records compileAsync and gives each material a program that counts its first use. */
function fakeRenderer(settle: 'resolve' | 'reject' | 'throw' = 'resolve') {
  const uses = new Map<Material, number>();
  const compiled: Object3D[] = [];
  const properties = new Map<object, { currentProgram: { getUniforms: () => object } }>();
  const renderer: ProgramCompiler = {
    compileAsync(object) {
      if (settle === 'throw') throw new Error('context lost');
      compiled.push(object);
      object.traverse((o) => {
        const material = (o as { material?: Material }).material;
        if (material === undefined) return;
        properties.set(material, { currentProgram: { getUniforms: () => (uses.set(material, (uses.get(material) ?? 0) + 1), {}) } });
      });
      return settle === 'resolve' ? Promise.resolve() : Promise.reject(new Error('compile failed'));
    },
    properties: { get: (object) => properties.get(object) },
  };
  return { renderer, uses, compiled };
}

describe('ProgramWarmup', () => {
  it('compiles every holder, then primes each program once; dispose frees the holders', async () => {
    const materials = [...planetProgramMaterials(), ...nebulaProgramMaterials()];
    const warmup = new ProgramWarmup(materials);
    expect(warmup.object.children).toHaveLength(materials.length);
    const { renderer, uses, compiled } = fakeRenderer();
    await warmup.compile(renderer, new PerspectiveCamera(), new Scene());
    expect(compiled).toEqual([warmup.object]);
    for (const material of materials) expect(uses.get(material)).toBe(1);

    let disposed = 0;
    for (const material of materials) material.addEventListener('dispose', () => disposed++);
    warmup.dispose();
    warmup.dispose();
    expect(disposed).toBe(materials.length);
    expect(warmup.object.children).toHaveLength(0);
  });

  it('never rejects, and primes nothing once disposed or when the compile fails', async () => {
    for (const settle of ['reject', 'throw'] as const) {
      const warmup = new ProgramWarmup(nebulaProgramMaterials());
      const { renderer, uses } = fakeRenderer(settle);
      await expect(warmup.compile(renderer, new PerspectiveCamera(), new Scene())).resolves.toBeUndefined();
      expect(uses.size).toBe(0);
      warmup.dispose();
    }
    const warmup = new ProgramWarmup(nebulaProgramMaterials());
    const { renderer, uses } = fakeRenderer();
    const pending = warmup.compile(renderer, new PerspectiveCamera(), new Scene());
    warmup.dispose();
    await pending;
    expect(uses.size).toBe(0);
  });
});
