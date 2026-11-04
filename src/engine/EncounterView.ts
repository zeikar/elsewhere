/**
 * Encounter view: puts the Autopilot's encounter planet into the scene (docs/PLAN.md section 6,
 * floating origin, Planets and Performance).
 *
 * - Lifecycle: the planet is created when an encounter starts (the step that enters APPROACH) and
 *   disposed once it ends (DEPARTURE back to CRUISE). Only one planet is alive at a time, so the
 *   shared planet geometry is freed with it and GPU memory returns to its pre-encounter baseline.
 * - Placement (floating origin): each frame the planet's render position is `planet - ship`, computed
 *   in float64 on the CPU from the encounter plan and written into the planet's preallocated
 *   `object.position`. Large absolute coordinates never reach the GPU.
 * - Opacity and size follow the encounter fade curves; the rotation follows simulation time, so it
 *   freezes with the simulation while paused.
 *
 * Nothing is allocated per frame; creating a planet (once per encounter) allocates its materials.
 */
import type { Object3D, Vector3 } from 'three';
import { PLANET_ENCOUNTER_LIGHT } from '../config';
import type { ActiveEncounter, AutopilotState } from './Autopilot';
import { encounterOffset, encounterScale, type Encounter, type EncounterProfile } from './encounter';
import { Planet, disposePlanetGeometry, planetParams, type PlanetParams } from './Planet';
import type { ShipState, Vec3 } from './Ship';

/**
 * Writes the planet's render position, `planet centre - ship position`, into `out` and returns it.
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
 * clearance the plan guarantees (`radius × k`) holds whatever chose the planet.
 */
export function encounterPlanetParams(encounter: Readonly<ActiveEncounter>): PlanetParams {
  const params = planetParams(encounter.seed);
  return params.radius === encounter.plan.radius ? params : { ...params, radius: encounter.plan.radius };
}

export class EncounterView {
  private readonly scene: Object3D;
  private planet: Planet | null = null;
  /** Encounter index of `planet`. */
  private index = -1;
  /** Scratch light direction, reused for every planet. */
  private readonly light: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(scene: Object3D) {
    this.scene = scene;
  }

  /** The planet of the current encounter, or `null` (read-only view; do not modify). */
  getPlanet(): Planet | null {
    return this.planet;
  }

  /**
   * Creates the planet when an encounter starts and disposes it once the encounter ends (or is
   * replaced by another). Call after each simulation step.
   */
  sync(autopilot: Readonly<AutopilotState>): void {
    const encounter = autopilot.encounter;
    if (this.planet !== null && (encounter === null || encounter.index !== this.index)) this.release();
    if (encounter === null || this.planet !== null) return;
    const planet = new Planet(encounterPlanetParams(encounter), encounterLightDirection(encounter.plan, this.light));
    planet.setFade(0);
    this.planet = planet;
    this.index = encounter.index;
    this.scene.add(planet.object);
  }

  /**
   * Places the planet relative to the ship (floating origin) and applies the encounter's fade, size
   * scale and the rotation at the ship's simulation time. Allocates nothing; call before each render.
   */
  place(autopilot: Readonly<AutopilotState>, ship: Readonly<ShipState>, profile: Readonly<EncounterProfile>): void {
    const planet = this.planet;
    const encounter = autopilot.encounter;
    if (planet === null || encounter === null || encounter.index !== this.index) return;
    planetRenderPosition(encounter.plan, ship.position, planet.object.position);
    planet.setFade(autopilot.fade);
    planet.setScale(encounterScale(encounter.plan, autopilot.remaining, profile));
    planet.update(ship.time);
  }

  /** Disposes the planet, if any, and the shared planet geometry. */
  dispose(): void {
    this.release();
  }

  private release(): void {
    if (this.planet === null) return;
    this.planet.dispose();
    this.planet = null;
    this.index = -1;
    // Only one planet is ever alive, so the shared geometry goes with it; the next planet makes a new one.
    disposePlanetGeometry();
  }
}
