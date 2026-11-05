import { PerspectiveCamera, Scene, WebGLRenderTarget, type BufferGeometry, type Material, type Object3D, type ShaderMaterial } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { ENCOUNTER_BASE_SEED } from '../config';
import { Asteroid, asteroidParams } from './Asteroid';
import { Comet, cometParams } from './Comet';
import { Nebula, disposeNebulaGeometry, nebulaGeometry, nebulaParams, nebulaProgramMaterials } from './Nebula';
import { Planet, atmosphereGeometry, disposePlanetGeometry, planetBakeProgramMaterials, planetGeometry, planetParams, planetProgramMaterials, ringGeometry } from './Planet';
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

/**
 * The first planet seeds of each type with an atmosphere, of a ringed gas giant and a ringed rocky
 * planet, and of an icy dwarf.
 */
function planetSeeds(): { rocky: number; gas: number; ringedGas: number; ringedRocky: number; icy: number } {
  const found: { rocky?: number; gas?: number; ringedGas?: number; ringedRocky?: number; icy?: number } = {};
  for (let i = 0; Object.keys(found).length < 5; i++) {
    const seed = hash(ENCOUNTER_BASE_SEED, i);
    const params = planetParams(seed);
    if (params.atmosphereIntensity > 0 && params.ring === null) found[params.type] ??= seed;
    if (params.ring !== null) found[params.type === 'gas' ? 'ringedGas' : 'ringedRocky'] ??= seed;
    if (params.family === 'icy') found.icy ??= seed;
  }
  return found as { rocky: number; gas: number; ringedGas: number; ringedRocky: number; icy: number };
}

describe('encounter program holders', () => {
  it('hold exactly the programs real planets, nebulae, asteroids and comets use', () => {
    // On screen: the procedural and baked rocky and gas surfaces, the halo and the nebula layers.
    const holders = new Set([...planetProgramMaterials(), ...nebulaProgramMaterials()].map(programSignature));
    expect(holders.size).toBe(6);
    // Into a render target: the rocky and gas surface bakes (issue #65).
    const bakeHolders = new Set(planetBakeProgramMaterials().map(programSignature));
    expect(bakeHolders.size).toBe(2);

    const seeds = planetSeeds();
    const used = new Set<string>();
    const bakes = new Set<string>();
    let rings = 0;
    for (const seed of [seeds.rocky, seeds.gas, seeds.ringedGas, seeds.ringedRocky, seeds.icy]) {
      for (const bake of [false, true]) {
        const planet = new Planet(planetParams(seed), undefined, undefined, { bake });
        if (planet.ring !== null && !bake) rings++;
        for (const m of materialsOf(planet.object)) used.add(programSignature(m));
        // Every material a planet owns, the baked surface's (drawn once the bake is done) among them.
        for (const m of planet.materials()) {
          if (m === planet.bake?.material) bakes.add(programSignature(m));
          else used.add(programSignature(m));
        }
        planet.dispose();
      }
    }
    expect(bakes).toEqual(bakeHolders);
    // Rings and icy dwarfs need no program of their own (docs/PLAN.md section 9, Phase 4): a ring
    // draws with the atmosphere's halo program, an icy dwarf with the rocky surface.
    expect(rings).toBe(2);
    for (let i = 0; i < 20; i++) {
      const nebula = new Nebula(nebulaParams(hash(ENCOUNTER_BASE_SEED, 1000 + i)));
      for (const m of materialsOf(nebula.object)) used.add(programSignature(m));
      nebula.dispose();
    }
    // Asteroids and comets need no program of their own either: rocks and nuclei draw with the rocky
    // surface, a comet's coma and tails with the halo program.
    const extra = new Set<string>();
    for (let i = 0; i < 10; i++) {
      for (const object of [new Asteroid(asteroidParams(hash(ENCOUNTER_BASE_SEED, 2000 + i))), new Comet(cometParams(hash(ENCOUNTER_BASE_SEED, 3000 + i)))]) {
        for (const m of materialsOf(object.object)) extra.add(programSignature(m));
        object.dispose();
      }
    }
    for (const signature of extra) expect(holders.has(signature)).toBe(true);
    expect(extra.size).toBe(2);
    // Every program an encounter draws with is held, and every holder is one an encounter uses.
    expect(used).toEqual(holders);
  });

  it('use a geometry with the attributes of the planet sphere, the atmosphere annulus, the ring, the nebula plane, a rock and a comet glow, but no data', () => {
    const holder = holderGeometry();
    expect(attributeLayout(holder)).toBe(attributeLayout(planetGeometry()));
    expect(attributeLayout(holder)).toBe(attributeLayout(atmosphereGeometry()));
    const ring = ringGeometry(1.4, 2.4);
    expect(attributeLayout(holder)).toBe(attributeLayout(ring));
    ring.dispose();
    expect(attributeLayout(holder)).toBe(attributeLayout(nebulaGeometry()));
    const comet = new Comet(cometParams(1));
    expect(attributeLayout(holder)).toBe(attributeLayout(comet.glow.geometry));
    expect(attributeLayout(holder)).toBe(attributeLayout(comet.nucleus.geometry));
    comet.dispose();
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

  it('with a target, binds it while the compile starts and binds the previous one again; isReady() once settled', async () => {
    const warmup = new ProgramWarmup(planetBakeProgramMaterials());
    const { renderer, compiled } = fakeRenderer();
    const bound: (WebGLRenderTarget | null)[] = [];
    let current: WebGLRenderTarget | null = null;
    const previous = new WebGLRenderTarget(2, 2);
    current = previous;
    const target = new WebGLRenderTarget(1, 1);
    const compileAsync = renderer.compileAsync.bind(renderer);
    renderer.compileAsync = (object, camera, scene) => {
      bound.push(current);
      return compileAsync(object, camera, scene);
    };
    renderer.getRenderTarget = () => current;
    renderer.setRenderTarget = (t) => {
      current = t;
    };
    const pending = warmup.compile(renderer, new PerspectiveCamera(), new Scene(), target);
    expect(warmup.isReady()).toBe(false);
    expect(bound).toEqual([target]);
    expect(current).toBe(previous);
    await pending;
    expect(compiled).toHaveLength(1);
    expect(warmup.isReady()).toBe(true);
    warmup.dispose();
    target.dispose();
    previous.dispose();
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
