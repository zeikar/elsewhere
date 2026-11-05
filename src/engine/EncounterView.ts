/**
 * Encounter view: puts the Autopilot's encounter object, a planet, a nebula, an asteroid or a comet,
 * into the scene (docs/PLAN.md section 6, floating origin, Planets, Nebulae, Variety and Performance).
 *
 * - Every kind sits behind one small interface (`EncounterObject`: a root object, fade, size scale,
 *   per-frame update and dispose), so the lifecycle, warm-up and placement below are shared.
 * - Lifecycle: the object is created when an encounter starts (the step that enters APPROACH) and
 *   disposed once it ends (DEPARTURE back to CRUISE). The shared planet sphere and nebula plane are
 *   reference-counted by `Planet` and `Nebula`, so each is freed with the last live object holding it,
 *   and an asteroid frees its rocks' own geometries and a comet its nucleus and glow, so GPU memory
 *   returns to its pre-encounter baseline.
 * - Shader warm-up: the view hands each new object to a `compile` function (the engine passes
 *   `renderer.compileAsync`, which compiles in parallel where `KHR_parallel_shader_compile` is
 *   available) and keeps it hidden, at fade 0, until that settles, so the first frame that draws it
 *   does not stall on compilation. A failed compile falls back to showing the object anyway. The
 *   engine also keeps every encounter program compiled for the whole run (ProgramWarmup.ts), so
 *   disposing an object frees no program and a new object's compile finds its programs ready.
 * - Placement (floating origin): each frame the object's render position is `centre - ship`, computed
 *   in float64 on the CPU from the encounter plan and written into its preallocated
 *   `object.position`. Large absolute coordinates never reach the GPU.
 * - Opacity and size follow the encounter fade curves; `update` takes the simulation time (the
 *   planet's rotation, the nebula's churn and per-layer near fade, the rocks' and the nucleus's
 *   tumble), so it freezes
 *   while paused.
 *
 * Nothing is allocated per frame; creating an object (once per encounter) allocates its materials.
 */
import type { Object3D, Vector3 } from 'three';
import { ENCOUNTER_CLEARANCE_MARGIN, PLANET_ENCOUNTER_LIGHT } from '../config';
import { Asteroid, asteroidParams, type AsteroidParams } from './Asteroid';
import {
  planetViewRadiusFactor,
  type AsteroidEncounter,
  type AutopilotState,
  type CometEncounter,
  type NebulaEncounter,
  type PlanetEncounter,
} from './Autopilot';
import { Comet, cometParams, type CometParams } from './Comet';
import { encounterOffset, encounterScale, type Encounter, type EncounterProfile } from './encounter';
import { Nebula, nebulaParams, type NebulaParams } from './Nebula';
import { Planet, planetParams, type PlanetParams } from './Planet';
import type { ShipState, Vec3 } from './Ship';

/**
 * Writes the encounter object's render position, `centre - ship position`, into `out` and returns
 * it (planets, nebulae, asteroids and comets alike).
 *
 * The difference is taken in float64 from the encounter plan (see `encounterOffset`), so it stays
 * small (within the encounter distances) and exact even with ship positions around 1e12, and the
 * float32 conversion on the GPU keeps it to float32 precision. Rounding the absolute coordinates to
 * float32 first would lose everything below about 6e4 units at 1e12.
 */
export function planetRenderPosition(plan: Readonly<Encounter>, shipPos: Readonly<Vec3>, out: Vector3): Vector3 {
  encounterOffset(plan, shipPos, out);
  return out;
}

/**
 * Writes the direction toward the light for an encounter into `out` (unit length) and returns it:
 * PLANET_ENCOUNTER_LIGHT in the frame of the planned path, so the planet's lit face is toward the
 * ship while it approaches and at the closest approach, whatever the heading was.
 */
export function encounterLightDirection(plan: Readonly<Encounter>, out: Vec3): Vec3 {
  const { direction: d, side: s } = plan;
  const { behind, inward, up } = PLANET_ENCOUNTER_LIGHT;
  // up = side × direction: with a -Z heading and the planet to the right (+X), this is +Y.
  const ux = s.y * d.z - s.z * d.y;
  const uy = s.z * d.x - s.x * d.z;
  const uz = s.x * d.y - s.y * d.x;
  const x = -behind * d.x - inward * s.x + up * ux;
  const y = -behind * d.y - inward * s.y + up * uy;
  const z = -behind * d.z - inward * s.z + up * uz;
  const len = Math.hypot(x, y, z);
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

/**
 * Seeded planet parameters for an encounter. The drawn radius is always the planned one, so the
 * clearance the plan guarantees (`radius × k`) holds whatever chose the planet. A ring is drawn only
 * if it fits the plan: inside the extent the encounter was planned and is ended with (so it leaves
 * the view with the planet, `encounterViewMargin`) and inside the clearance (`radius × outer ×
 * (1 + ENCOUNTER_CLEARANCE_MARGIN)` within the closest approach). With the engine's chooser
 * (`planetParams`) it always fits; a planet chosen otherwise (a bare `{ radius }`, as in tests) is
 * drawn without it.
 */
export function encounterPlanetParams(encounter: Readonly<PlanetEncounter>): PlanetParams {
  const params = planetParams(encounter.seed);
  const { radius, closestDistance } = encounter.plan;
  const ring = params.ring;
  const fits =
    ring === null ||
    (ring.outer <= planetViewRadiusFactor(encounter.planet) &&
      radius * ring.outer * (1 + ENCOUNTER_CLEARANCE_MARGIN) <= closestDistance * (1 + 1e-12));
  if (params.radius === radius && fits) return params;
  return {
    ...params,
    radius,
    ...(fits ? {} : { ring: null, extent: 1 + params.atmosphereThickness }),
  };
}

/**
 * Seeded nebula parameters for an encounter, with the planned core radius (as for planets, so the
 * planned clearance holds whatever chose the nebula). A different radius scales the whole layout.
 */
export function encounterNebulaParams(encounter: Readonly<NebulaEncounter>): NebulaParams {
  const params = nebulaParams(encounter.seed);
  const radius = encounter.plan.radius;
  if (params.radius === radius) return params;
  const k = radius / params.radius;
  return {
    ...params,
    radius,
    layers: params.layers.map((layer) => ({
      ...layer,
      offset: [layer.offset[0] * k, layer.offset[1] * k, layer.offset[2] * k] as const,
      halfSize: layer.halfSize * k,
    })),
  };
}

/**
 * Seeded asteroid parameters for an encounter, with the planned bounding radius (as for planets and
 * nebulae, so the planned clearance holds whatever chose the asteroid): a different radius scales the
 * whole field, its rocks' sizes and offsets alike. With the engine's chooser (`asteroidParams`) the
 * plan's closest distance is the seeded one, so every rock passes at least ASTEROID_MIN_PASS_DISTANCE
 * from the path; a chooser that brings no pass factor gets the default `k`, which still keeps the
 * path out of the field's sphere (`asteroidPassFactor`).
 */
export function encounterAsteroidParams(encounter: Readonly<AsteroidEncounter>): AsteroidParams {
  const params = asteroidParams(encounter.seed);
  const { radius, closestDistance } = encounter.plan;
  const passFactor = closestDistance / radius;
  if (params.radius === radius && params.passFactor === passFactor) return params;
  const k = radius / params.radius;
  return {
    ...params,
    radius,
    passFactor,
    rocks: params.rocks.map((rock) => ({
      ...rock,
      offset: [rock.offset[0] * k, rock.offset[1] * k, rock.offset[2] * k] as const,
      radius: rock.radius * k,
    })),
  };
}

/**
 * Seeded comet parameters for an encounter, with the planned coma radius (as for the other kinds, so
 * the planned clearance holds whatever chose the comet): a different radius scales the whole comet,
 * its nucleus, coma, tails and bounds alike, and the pass factor is the plan's. The tails are drawn
 * only if the encounter's spec bounds them as drawn (`CometSpec.bounds`, which the out-of-view test
 * uses), so they leave the view with the encounter; with the engine's chooser (`cometParams`) they
 * always are, and a comet chosen otherwise (a bare `{ radius }`, as in tests) is drawn without them,
 * as a ring that does not fit its plan is (`encounterPlanetParams`).
 */
export function encounterCometParams(encounter: Readonly<CometEncounter>): CometParams {
  const params = cometParams(encounter.seed);
  const { radius, closestDistance } = encounter.plan;
  const k = radius / params.radius;
  const scaled = (v: readonly [number, number, number]) => [v[0] * k, v[1] * k, v[2] * k] as const;
  const scaledParams: CometParams =
    k === 1
      ? params
      : {
          ...params,
          radius,
          bounds: params.bounds.map((b) => ({ offset: scaled(b.offset), radius: b.radius * k })),
          nucleus: { ...params.nucleus, radius: params.nucleus.radius * k },
          ion: { ...params.ion, length: params.ion.length * k, headWidth: params.ion.headWidth * k, endWidth: params.ion.endWidth * k },
          dust: { ...params.dust, length: params.dust.length * k, headWidth: params.dust.headWidth * k, endWidth: params.dust.endWidth * k },
        };
  const spec = encounter.comet.bounds;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const fits =
    spec !== undefined &&
    spec.length === scaledParams.bounds.length &&
    scaledParams.bounds.every(
      (b, i) => close(b.radius, spec[i]!.radius) && b.offset.every((x, j) => close(x, spec[i]!.offset[j]!)),
    );
  const passFactor = closestDistance / radius;
  if (fits && scaledParams === params && params.passFactor === passFactor) return params;
  return { ...scaledParams, passFactor, tails: fits };
}

/** What the view needs from an encounter object; `Planet`, `Nebula`, `Asteroid` and `Comet` all provide it. */
export interface EncounterObject {
  /** Root object in the scene; its position is the object's centre relative to the ship. */
  readonly object: Object3D;
  /** Encounter opacity in [0, 1]; at 0 nothing is drawn. */
  setFade(opacity: number): void;
  /** Encounter size scale. */
  setScale(scale: number): void;
  /** Per-frame update at the ship's simulation time, after the position, fade and scale are set. */
  update(time: number): void;
  dispose(): void;
}

/**
 * Prepares a new encounter object's shaders before it is first drawn (the engine passes
 * `(object) => renderer.compileAsync(object, camera, scene)`). The object stays hidden until the
 * returned promise settles.
 */
export type EncounterCompiler = (object: Object3D) => PromiseLike<unknown>;

export class EncounterView {
  private readonly scene: Object3D;
  private readonly compile: EncounterCompiler | null;
  private current: EncounterObject | null = null;
  /** Encounter index of `current`. */
  private index = -1;
  /** Whether `current`'s shaders are ready, so it may be drawn (always true without a compiler). */
  private ready = false;
  /** Scratch light direction, reused for every planet. */
  private readonly light: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(scene: Object3D, compile: EncounterCompiler | null = null) {
    this.scene = scene;
    this.compile = compile;
  }

  /** The current encounter object, planet, nebula, asteroid or comet, or `null` (read-only view; do not modify). */
  getObject(): EncounterObject | null {
    return this.current;
  }

  /** The planet of the current encounter, or `null` (read-only view; do not modify). */
  getPlanet(): Planet | null {
    return this.current instanceof Planet ? this.current : null;
  }

  /** The nebula of the current encounter, or `null` (read-only view; do not modify). */
  getNebula(): Nebula | null {
    return this.current instanceof Nebula ? this.current : null;
  }

  /** The asteroid of the current encounter, or `null` (read-only view; do not modify). */
  getAsteroid(): Asteroid | null {
    return this.current instanceof Asteroid ? this.current : null;
  }

  /** The comet of the current encounter, or `null` (read-only view; do not modify). */
  getComet(): Comet | null {
    return this.current instanceof Comet ? this.current : null;
  }

  /**
   * Creates the planet, nebula, asteroid or comet when an encounter starts and disposes it once the
   * encounter ends (or is replaced by another). Call after each simulation step.
   */
  sync(autopilot: Readonly<AutopilotState>): void {
    const encounter = autopilot.encounter;
    if (this.current !== null && (encounter === null || encounter.index !== this.index)) this.release();
    if (encounter === null || this.current !== null) return;
    const created: EncounterObject =
      encounter.kind === 'nebula'
        ? new Nebula(encounterNebulaParams(encounter), encounter.plan)
        : encounter.kind === 'asteroid'
          ? new Asteroid(encounterAsteroidParams(encounter), encounterLightDirection(encounter.plan, this.light), encounter.plan)
          : encounter.kind === 'comet'
            ? new Comet(encounterCometParams(encounter), encounter.plan)
            : new Planet(encounterPlanetParams(encounter), encounterLightDirection(encounter.plan, this.light), encounter.plan);
    created.setFade(0);
    this.current = created;
    this.index = encounter.index;
    this.scene.add(created.object);
    this.warmUp(created);
  }

  /**
   * Places the object relative to the ship (floating origin) and applies the encounter's fade, size
   * scale and the update at the ship's simulation time. `profile` is the encounter's own profile
   * (`encounterProfile(params, kind)`). Allocates nothing; call before each render.
   */
  place(autopilot: Readonly<AutopilotState>, ship: Readonly<ShipState>, profile: Readonly<EncounterProfile>): void {
    const current = this.current;
    const encounter = autopilot.encounter;
    if (current === null || encounter === null || encounter.index !== this.index) return;
    planetRenderPosition(encounter.plan, ship.position, current.object.position);
    // Hidden until its shaders are ready (the fade is still about 1e-4 by then).
    current.setFade(this.ready ? autopilot.fade : 0);
    current.setScale(encounterScale(encounter.plan, autopilot.remaining, profile));
    current.update(ship.time);
  }

  /** Disposes the object, if any (which frees its shared geometry once nothing holds it). */
  dispose(): void {
    this.release();
  }

  /**
   * Starts compiling `object`'s shaders and marks it ready once that settles, whether it succeeds
   * or fails (a failure only means the first frame may compile synchronously, as without warm-up).
   * An object released meanwhile is left alone: only the current object is ever marked ready.
   */
  private warmUp(object: EncounterObject): void {
    const compile = this.compile;
    if (compile === null) {
      this.ready = true;
      return;
    }
    this.ready = false;
    const settle = (): void => {
      if (this.current === object) this.ready = true;
    };
    let pending: PromiseLike<unknown>;
    try {
      pending = compile(object.object);
    } catch {
      settle();
      return;
    }
    Promise.resolve(pending).then(settle, settle);
  }

  private release(): void {
    if (this.current === null) return;
    this.current.dispose();
    this.current = null;
    this.index = -1;
    this.ready = false;
  }
}
