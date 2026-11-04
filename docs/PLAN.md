# ELSEWHERE

> An endless journey into the unknown.

**Document version:** v0.2
**Project:** Autopilot space travel in the browser
**Goal:** A small side project that stands on its own as something to watch, with no multiplayer

## 1. Summary

An immersive web experience inspired by the Windows Starfield screensaver. You drift on autopilot through deep space while stars stream past, and now and then you meet a procedurally generated planet or nebula.

## 2. Principles

- **Autopilot:** The journey continues without any steering.
- **Watching first:** No game, missions, score or combat.
- **Cinematic space:** Borrow the mood of real astronomy, but compress speed and distance for effect.
- **The screen is the star:** UI and cursor stay hidden and appear only on input.
- **Finish small:** First make the stars and a single planet flyby feel smooth.

## 3. Tech stack

| Area | Technology |
| --- | --- |
| Build | Vite + TypeScript |
| 3D | Three.js |
| UI | DOM + CSS (no framework) |
| Hosting | GitHub Pages (`zeikar/elsewhere` → `https://zeikar.dev/elsewhere/`) |

- The UI is three buttons and auto-hide, so no React, no state library and no Tailwind. Revisit only if the UI actually grows.
- No backend, auth, database or WebSocket.
- The site is served from a subpath, so Vite's `base` is `/elsewhere/`. Deploy with GitHub Actions.

## 4. Core experience

1. Opening the page shows black space and stars, and autopilot starts.
2. Stars rush toward the camera, giving a sense of depth and speed.
3. After a while, a planet or nebula appears in the distance as a small dot.
4. The camera eases in, slows down and passes alongside it.
5. Once it falls behind, the ship speeds back up into deep space.
6. The cycle repeats without seams.
7. The screen does not turn off while travelling.

Travel states: `CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE`

## 5. MVP features

### Required

- [ ] Full-viewport Three.js canvas
- [ ] High-DPI support (with a DPR cap) and resize handling
- [ ] 3D starfield with depth
- [ ] Star streaks whose length follows speed
- [ ] Automatic forward motion, smooth turns, acceleration and deceleration
- [ ] Floating-origin coordinates (section 6)
- [ ] Seeded planet appearance (at least rocky and gas)
- [ ] Planet approach and flyby
- [ ] Simplified nebulae (layered planes or a cheap shader)
- [ ] Smooth return to cruise after an encounter
- [ ] Pause / Resume, Fullscreen, Speed setting
- [ ] UI and cursor auto-hide and reveal
- [ ] Keep the screen awake while travelling (Screen Wake Lock)
- [ ] Respect `prefers-reduced-motion`
- [ ] Stable rendering across tab switches and long runs

### Optional (after the MVP)

- [ ] More planet variety: ringed, icy, and so on
- [ ] Quality presets and adaptive resolution
- [ ] Shareable seed in the URL
- [ ] Soundscape (muted by default)

### Out of scope for this version

- Multiplayer and other players' ships
- Accounts, login, player IDs
- First-discovery records and a database
- Manual flight, landing, collision physics
- Black holes, detailed galaxies, real astronomical data
- Chat, missions, score, economy

Future ideas go in `IDEAS.md` and are not added to the current scope.

## 6. Rendering design

### Coordinates: floating origin

Travelling forward forever makes positions grow until float32 precision on the GPU runs out, and after a long run stars and planets start to jitter. To prevent that:

- **The camera always sits at the origin.** Only its rotation (heading) changes.
- The ship's travel position is kept on the CPU only, as a JS `number` (float64).
- Every rendered object's position is computed on the CPU in float64 as `object position - ship position`, then handed to the GPU. Large absolute coordinates never reach the GPU.
- These travel coordinates later drive seeded object placement and, in the long-term vision, a shared coordinate system.

### Starfield

- **One star = one instanced quad.** `Points` are square sprites that cannot stretch, and WebGL lines are always one device pixel wide, which is too thin on Retina and allows no per-star size. So each star is a quad drawn with `InstancedBufferGeometry`.
- **Streaks (vertex shader):** Project the star's head and its tail (`head + ship velocity × streak time`) into clip space, and build a quad joining the two points. Width is the star's size, length is the projected distance, and the minimum length equals the width, so a still star is a round dot. The fragment shader gives both ends soft round caps.
- **Rotational smear:** Turns are slow, so streaks follow translation only and ignore rotation.
- **Size and DPR:** Every pixel size is multiplied by the DPR actually applied. Without it, stars on Retina get half as big instead of sharper.
- **Recycling:** Stars live in a cube of side `L` centred on the camera. Their positions are fixed in a GPU buffer and the shader wraps them with `mod(position - offset, L)`. The offset is `ship position mod L`, computed on the CPU in float64 and passed as a uniform. Stars never run out whatever the heading, and nothing is re-uploaded or allocated per frame.
- **Fading:** Dim stars near the cube's boundary and right in front of the camera, so wrapping never makes a star pop in or out.
- Vary distance, brightness and size, and prefer small, crisp points of light over heavy bloom.

### Time and speed

- All motion is driven by delta time, so speed is independent of refresh rate.
- **dt cap:** Clamp each frame's dt to at most 0.1 s.
- **Tab switches:** Stop the clock on `visibilitychange` when hidden, and reset the reference time on return, so stars don't teleport when the tab comes back.
- Speed approaches its target exponentially, so acceleration and deceleration stay smooth.
- The simulation update (speed, position, state transitions) is a pure function separate from rendering, so it can be tested by feeding it different dt values.

### Planets (Phase 2)

- Start with sphere geometry and procedural colour and surface patterns, with basic lighting, shading and optional atmospheric glow.
- **Plan the path first, then place the planet beside it.** When an encounter starts, put the planet at distance `D` ahead along the current heading, offset sideways by `radius × k`. The closest approach is fixed from the start, so the camera can't pass through it and no collision-avoidance logic is needed.
- Deceleration depends on the remaining distance to the planet; the ship speeds up again after passing.
- A planet starts as a dot far away and grows gradually, and fades out gradually as it recedes.
- Its appearance seed is `hash(base seed, encounter index)`.

### Nebulae (Phase 3)

- Build depth with layered planes or a cheap shader.
- Expensive volumetric raymarching is out of the MVP.

### Performance

- Start with a DPR cap of 2, kept as a setting so it can be tuned from measurements.
- Set the renderer's output colour space to sRGB.
- Reuse geometries, materials and textures, and `dispose()` them when no longer used.
- Allocate nothing inside the render loop; create vectors and matrices up front and reuse them.
- Aim for 60 FPS on an ordinary desktop, but trust real measurements over the target.

## 7. Screen and input

- **UI:** Pause / Resume, Fullscreen, Speed. Shown on mouse move, touch or key press; hidden after 2.5 s with no input.
- **Cursor:** Hidden whenever the UI is (`cursor: none`).
- **Keyboard:** Space pauses, F toggles fullscreen, Up / Down arrows change speed.
- **Touch:** Tapping the screen shows the UI. Mobile is supported to the point of working correctly; optimisation targets desktop.
- **Fullscreen:** Hide the button where the Fullscreen API is unavailable (e.g. Safari on iPhone).
- **Wake Lock:** Request a Screen Wake Lock while travelling with the tab visible. Re-request when the tab becomes visible again, release on pause. Skip quietly where unsupported, but log failed requests to the console.
- **Reduced motion:** Under `prefers-reduced-motion: reduce`, start at a lower speed with shorter streaks. Don't stop the user from raising the speed.

## 8. Module layout

```text
index.html
src/
├── main.ts            # Bootstrap: wires the engine to the UI
├── config.ts          # Speeds, star count, DPR cap, timings, etc.
├── engine/
│   ├── Engine.ts      # Renderer, resize, frame loop, dt, visibility
│   ├── Ship.ts        # Travel position (float64), speed, heading (pure update)
│   ├── Starfield.ts   # Instanced quads, shaders, wrapping
│   ├── Autopilot.ts   # Phase 2: travel state machine
│   ├── Planet.ts      # Phase 2
│   └── Nebula.ts      # Phase 3
└── ui/
    ├── controls.ts    # Buttons, keyboard, auto-hide, cursor
    └── wakeLock.ts
```

Create only the files the implementation needs and avoid needless abstraction. The engine knows nothing about the DOM UI, and the UI calls only a small public engine API (`pause`, `resume`, `setSpeed`, …). The engine owns the frame loop.

## 9. Phases

### Phase 1: Starfield

**Goal:** Opening the browser feels like travelling through space.

- Project setup (Vite + TS + Three.js), canvas, render loop
- Floating origin, ship state, dt cap, visibility handling
- Instanced-quad starfield, speed-driven streaks, DPR-aware sizing
- A slow heading drift, to check that streaks follow the direction of travel
- Pause / Resume, Fullscreen, Speed, keyboard shortcuts
- UI and cursor auto-hide, Wake Lock, reduced motion
- GitHub Pages deploy workflow

**Done when:**

- Stars stream past naturally, and streaks follow the direction of travel as the heading changes.
- On Retina, stars appear at the same CSS size as on a standard display.
- Resizing the window or switching tabs and back leaves the view correct, with no teleporting stars.
- After 30 minutes, JS heap and FPS are not far from their values just after start.

### Phase 2: Planet flyby

**Goal:** The first memorable encounter.

- Travel state machine (`CRUISE → APPROACH → FLYBY → DEPARTURE`)
- Seeded planet generation (rocky, gas)
- Placement beside the path, distance-based deceleration and re-acceleration

**Done when:** Within about 30–60 seconds, a planet appears far away and passes by naturally. The encounter interval is a setting. The camera never passes through a planet.

### Phase 3: Nebulae & polish

**Goal:** A universe that stays interesting on repeat viewing.

- Simplified nebulae
- More variety in planet and nebula encounters
- Performance measurement and optimisation

**Done when:** The stars → approach → flyby → re-acceleration loop repeats smoothly, and long runs stay stable.

## 10. Verification checklist

- [ ] Travel starts on page load with no interaction.
- [ ] Stars are crisp and correctly sized on high-DPI screens.
- [ ] Refresh-rate independence: feeding the simulation update `dt = 1/60` 60 times and `dt = 1/120` 120 times gives the same distance within tolerance. 120 Hz is hard to reproduce with browser automation, so verify this way.
- [ ] Coming back to a tab hidden for a long time doesn't teleport the stars.
- [ ] The camera never jumps or passes through a planet during an approach.
- [ ] Objects never appear or vanish abruptly.
- [ ] Fullscreen, pause, speed change and keyboard shortcuts work.
- [ ] UI and cursor hide without input and come back on input.
- [ ] The screen stays on while travelling, and the Wake Lock is released on pause.
- [ ] With reduced motion set, travel starts at the slower default.
- [ ] The aspect ratio is correct after resizing.
- [ ] After 30 minutes, memory and FPS have not degraded noticeably.
- [ ] Asset paths resolve at `https://zeikar.dev/elsewhere/`.

## 11. Instructions for AI coding agents

You are a senior frontend and graphics engineer. Using this spec, **implement Phase 1 only**.

1. Start with Vite + TypeScript + Three.js. Add no UI framework.
2. Keep the engine and the DOM UI separate.
3. The floating origin, instanced-quad streaks, DPR-aware sizing, dt cap and visibility handling in section 6 are required Phase 1 design. If you find a reason to do any of them differently, report it before implementing.
4. Prioritise motion and visual quality.
5. Don't build ahead of the current phase.
6. Confirm the build and, where possible, verify visually in a browser. Verify refresh-rate independence as described in section 10.
7. When done, report what was built, how to run it, known issues and the plan for the next phase.
8. Record new feature ideas only in `IDEAS.md`.
9. Start Phase 2 only when the user explicitly asks for it.

**First target:** An autopilot journey through space with stars rushing past, crisp even on a Retina display.

---

## 12. Long-term vision (not in scope)

Someday every user might share the same universe, setting out from different coordinates, occasionally meeting another traveller or leaving a record of the first discovery of a planet. No multiplayer system is built ahead of time. The floating origin and float64 travel coordinates are the starting point for a shared coordinate system, so the coordinate system and data model will be revisited when that becomes necessary.

**No missions. No combat. No destination. Just the journey.**
