# ELSEWHERE

> An endless journey into the unknown.

**Document version:** v0.2
**Project:** Autopilot space travel in the browser
**Goal:** A small side project that stands on its own as something to watch, with no multiplayer

## 1. Summary

An immersive web experience inspired by the Windows Starfield screensaver. You drift on autopilot through deep space while stars stream past, and now and then you meet a procedurally generated planet or nebula.

**Identity:** an ambient space voyage, a screensaver by format and exploration by content. The format stays passive and leave-on: autopilot, hidden UI, the screen kept awake. The content is the encounters, and they need a physically believable space. The two visual languages are split by time:

- **Cruise is the screensaver.** White stars rush past: the warp.
- **An encounter is the exploration.** The object appears far ahead as a star-like dot against the fixed far-star layer and grows as the ship nears it. The ship drops out of warp while the object is still small, the streaks shrink to dots as it slows, and the planet or nebula passes alongside. Afterwards the ship eases back into warp.

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

- [x] Full-viewport Three.js canvas
- [x] High-DPI support (with a DPR cap) and resize handling
- [x] 3D starfield with depth
- [x] Star streaks whose length follows speed
- [x] Automatic forward motion on a fixed heading, with smooth acceleration and deceleration
- [x] Floating-origin coordinates (section 6)
- [x] Seeded planet appearance (at least rocky and gas)
- [x] Planet approach and flyby
- [x] Simplified nebulae (layered planes or a cheap shader)
- [x] Smooth return to cruise after an encounter
- [x] Pause / Resume, Fullscreen, Speed setting
- [x] UI and cursor auto-hide and reveal
- [x] Keep the screen awake while travelling (Screen Wake Lock)
- [x] Respect `prefers-reduced-motion`
- [x] Stable rendering across tab switches and long runs

### Phase 4 (after the MVP)

Built in section 9 Phase 4, together with the rest of its list.

- [x] More planet variety: ringed, icy, and so on
- [x] Asteroids and comets
- [x] Shareable seed in the URL

### Optional (after the MVP)

- [ ] Quality presets and adaptive resolution
- [ ] Soundscape (muted by default)

### Out of scope for this version

- Multiplayer and other players' ships
- Accounts, login, player IDs
- First-discovery records and a database
- Manual flight, landing, collision physics
- Black holes, detailed (explorable) galaxies, real astronomical data
- Chat, missions, score, economy

Future ideas go in `IDEAS.md` and are not added to the current scope.

## 6. Rendering design

### Coordinates: floating origin

Travelling forward forever makes positions grow until float32 precision on the GPU runs out, and after a long run stars and planets start to jitter. To prevent that:

- **The camera always sits at the origin.** It looks along the ship's heading, which is fixed (-Z, issue #62), so its rotation never changes either.
- The ship's travel position is kept on the CPU only, as a JS `number` (float64).
- Every rendered object's position is computed on the CPU in float64 as `object position - ship position`, then handed to the GPU. Large absolute coordinates never reach the GPU.
- These travel coordinates later drive seeded object placement and, in the long-term vision, a shared coordinate system.

### Starfield

- **Two layers.** The sky is a near layer and a far layer. The near layer is fine dust and near stars around the camera: they stream past and streak, so they carry the sense of speed, mostly through the length of their streaks. They are faint, small and nearly colourless, with an occasional brighter mote, and drawn dimmer than the far stars, so they don't read as the sky itself. Most of the rules below are about it. The far layer is stars at effectively infinite distance: fixed, seeded directions on the unit sphere, turned by the camera's rotation only (the rotation part of the view matrix), so they have no parallax and never move with travel. The heading is fixed, so that rotation never changes: the far stars and galaxies are a completely still backdrop, and only the near dust moves. They are round dots with no streaks, brighter than the dust, with a heavier bright tail and a subtle colour temperature (blue-white, white, yellow, orange). This gives a stable backdrop that a planet's growth and passage are read against. The far layer draws first and never writes depth, so it never hides anything: planets hide the far stars behind them, and nebulae blend over them.
- **One star = one instanced quad.** `Points` are square sprites that cannot stretch, and WebGL lines are always one device pixel wide, which is too thin on Retina and allows no per-star size. So each star is a quad drawn with `InstancedBufferGeometry`.
- **Streaks (vertex shader):** Project the star's head and its tail (`head + ship velocity × streak time`) into clip space, and build a quad joining the two points. Width is the star's size, length is the projected distance, and the minimum length equals the width, so a still star is a round dot. The fragment shader gives both ends soft round caps.
- **No rotational smear:** The ship never turns, so streaks follow translation only: each one lies along the velocity (the fixed heading × the speed).
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
- A planet starts as a dot far away and grows gradually, and fades out gradually as it recedes (from Phase 4 it is removed once out of view, before any of that fade-out shows).
- **Spawn far out, as a dot (issue #64):** Planets, asteroids and comets are placed 8,000 ahead, inside the 10,000 far plane, so they first appear as a star-like dot: at 1080p the median planet's disc, atmosphere included, is about 11 px across and the largest about 29 px (a ring makes the widest up to about 67 px: under 30 px a ring would need a spawn about 18,500 out, past the far plane). The near plane is at 1, so the depth buffer still separates a ring's far side from the disc at that range. The object fades in over 4 s of its own time, a smoothstep, while it is still a dot, so it never reads as turning from dark to bright. Nebulae keep their own approach: a nebula is large and soft, never a dot, and fades in over a distance as before.
- **Far stretch:** A spawn that far out would take minutes to reach at the default speed, so the ship flies the first part of the approach faster (at the default and top levels up to 150, the top cruise speed), and only while the object is small: it is back at the default speed, with no acceleration left, by the time the object is 3° across or the slowdown starts. Its speed is a smooth curve in the distance travelled (no step in speed or acceleration, bounded jerk), so the dust streaks never jump; a stretch shorter than the whole fall from 150 (about 1,480 units) is left out, so the ship either stays in warp to the spawn or drops out of it as before, and no stretch is too short to be gentle. From the end of the stretch on, the near-approach speed profile, the bearing-rate guard, the clearance and the off-screen speed-up are exactly as before. At the top level the ship stays in warp into the far stretch and slows down there, rather than dropping out of warp before the spawn and speeding up again. At the default level the spawn is about 97 s before a median planet's closest approach (about 54 s before #64), and the planet is 2° across about 41 s after its spawn.
- **Baked surface (issue #65):** A planet's surface is procedural, but nothing on it changes from frame to frame but its spin and the lighting, so each planet renders the part of its look that depends only on the point of the surface into cube maps once, and is drawn from them: a gas giant's colour (sRGB, 8 bits a channel); a rocky world's land colour and ice cover, and its terrain height (one half-float channel, R16F; the bump comes from the height's slope, from taps half a texel either side of each pixel at the mip level it reads). Each face is 1,024 texels a side (`PLANET_BAKE_FACE_SIZE`), mipmapped and filtered anisotropically: the surface's finest detail spans about 6 texels, and the coastlines are recomputed per pixel from the baked height, so nothing blurs at the closest pass at 2× DPR. A frame samples the maps at the fragment's object-space direction, so they turn with the planet's spin, and does only the bump, the seas and the lighting: a handful of texture reads instead of about 13 noise evaluations and a 27-cell crater loop per pixel. The bake is spread over frames (128 rows of one face a frame: 96 frames for a rocky world, 1.6 s at 60 FPS; 48 for a gas giant) while the planet is still a far-off dot, from programs compiled at start-up, and the planet is drawn procedurally, with the same look, until it is done, so it never pops. The maps take 50.3 MB of GPU memory for a rocky world and 33.6 MB for a gas giant, mips included, and are freed with the planet. The rings, asteroids and comets stay procedural (cheap per pixel, or small on screen). The atmosphere's glow stays analytic too, but it was drawn on a shell shaded over the whole disc as well, doubling the planet's shaded pixels (under SwiftShader about a fifth of a rocky planet's cost): it is now drawn on a camera-facing annulus covering only the pixels past the limb, and the surface adds the thin rim of glow over the disc itself, encoded as the additive shell did, so the look is unchanged. After a WebGL context restore the planet bakes again, and the start-up warm-ups run again first (the restore drops every compiled program), so the bake still compiles nothing mid-encounter.
- Its appearance seed is `hash(base seed, encounter index)`. The base seed is the trip seed: random on each load, or replayed from `?seed=<8 hex digits>`, and shown in the URL after load. The first encounter of every trip is a planet.

### Nebulae (Phase 3)

- Build depth with layered planes or a cheap shader.
- Expensive volumetric raymarching is out of the MVP.

### Variety (Phase 4)

- **Trip seed:** Each load picks a random base seed unless the URL already carries one, and writes the seed in use to the URL, so a trip can be shared and replayed. Encounter seeds stay `hash(base seed, encounter index)`.
- **New encounters:** Ringed planets, icy dwarfs, asteroids and comets follow the planet rule: the path is planned first and the object is placed beside it, so the closest approach is fixed and the camera never passes through a solid part (planet, ring, asteroid or comet nucleus). A comet's tail may reach the camera, but it must never cover the view so that the scene is hidden; check its screen coverage at the closest approach. (A comet's tails point away from the path, so they never reach the camera; their glow is additive and covers at most about a sixth of the view at any moment of the encounter, and none at the closest approach.)
- **Speed driven by visibility:** The encounter's slow phase ends as soon as its object is wholly off the screen, before or after the closest approach, and the ship returns quickly to warp from the speed and acceleration it has then. Off the screen means outside the live camera view: the current aspect ratio and vertical field of view (narrowed beyond 21:9, so the horizontal one stays at the 21:9 one), bounded by its four side planes. The autopilot stays pure: the engine passes the view in its params and replaces it on every resize. Encounter timing therefore depends on the screen's shape: a shared seed replays the same encounters in the same order, but not frame-identical timing. Tests use a 16:9 view by default. A planet is off screen once a sphere holding everything drawn for it (the atmosphere or the ring) is; an asteroid once its field's bounding sphere is; a nebula, whose layers reach across the path, once every layer is behind the camera; a comet once spheres holding its coma and every stretch of both tails all are (its tails point back along the path and away from it, so they leave the screen with the coma). A future kind names its own bounding spheres. The heading is fixed, and moving forward along it never brings an object back into view, so an object once off screen stays off. The ship also flies on along the planned path after the encounter ends, so even an object that left the screen before its closest approach is passed at exactly the planned distance (within 0.5%, for planets, asteroid rocks and comet nuclei). The return to warp is a smooth ease of the ship's speed itself (no step in speed or acceleration, bounded jerk): at the default and slowest levels 50% of the cruise speed within 2.5 s of leaving the screen and 90% within 5 s, at the top level within 4 s and 7 s. Where an encounter ran to its despawn distance instead, the gentler return to warp is kept. While the object is on screen the speed profile is unchanged, so the ship is never faster than before (but on the far stretch, while the object is under 3° across), and the bearing-rate guard (5.1°/s) holds. The encounter interval still counts the cruise from the end of each encounter.
- **Distant galaxies:** Part of the far layer, not encounters. They are fixed, seeded directions turned by the camera's rotation only, drawn with the far stars and never writing depth, so they never move with travel and never hide anything.
  - A trip has 0–3 of them, generated from the trip seed, so a shared seed replays them. Each is a small spiral (a core glow and two faint arms) or elliptical (a core glow in an oval falloff), with a seeded size of 1.2–3.5° across, tilt, rotation and colour. The heading is fixed, so a galaxy is seen only if it is placed in view: each sits inside the camera's view on a 16:9 screen, its centre in the middle 80% of the screen's width and height, so every one is wholly on screen from the first frame. A wider screen up to 21:9 shows them all too; a narrower or much wider one may cut off one near its edge.
  - Their sizes are angles in the sky, so they stay right whatever the field of view or aspect.
  - Cost: one instanced draw call for all of them. At cruise they add one geometry, one program and one draw call (3, 7 and 3 with galaxies, against 2, 6 and 2 without). A trip without galaxies hides the layer, so it is never drawn or compiled. The galaxy program, like the star programs, compiles on the first frame and stays for the whole run.

### Performance

- Start with a DPR cap of 2, kept as a setting so it can be tuned from measurements.
- Set the renderer's output colour space to sRGB.
- Reuse geometries, materials and textures, and `dispose()` them when no longer used.
- Allocate nothing inside the render loop; create vectors and matrices up front and reuse them.
- Aim for 60 FPS on an ordinary desktop, but trust real measurements over the target.
- **Frame-rate cap (issue #65):** Rendering is capped at 60 FPS by default (`FRAME_RATE_CAP` in `config.ts`), measured by the frame clock: each `requestAnimationFrame` frame is drawn only when it is due, on a running 1/60 s schedule, so a 120 Hz display draws every other frame (a 90 Hz one two in three, a 144 Hz one about two in five) and a skipped frame runs nothing at all. A frame up to `FRAME_CAP_TOLERANCE_MS` (2 ms) early still counts as due, and the next frame is never due more than 1/60 s after a drawn one, so a 60 Hz display (or a 59.94 Hz one, with timestamp jitter) draws every frame and never drops to 30. The simulation stays real time: each drawn frame steps it by the real time since the previous drawn frame (still clamped by the dt cap), so speeds and timings are those of an uncapped 60 Hz run. The motion is slow enough that frames beyond 60 show nothing more, while each frame's GPU work (a planet across much of a Retina screen) is the cost.
- **Measure the GPU (issue #65):** The e2e build times every frame on the GPU with `EXT_disjoint_timer_query_webgl2` where the browser has it (`?gpuTiming=1`, reported by the test hook; `?perfOverlay=1` shows it on screen). Without the extension (Safari) the hook falls back to an estimate: shaded fragments per frame (each drawn mesh's screen coverage) × a per-shader cost in ALU operations. `e2e/gpuCost.spec.ts` measures cruise and each kind of encounter at its most expensive moment at 1512×982 @2× and 1920×1080 @1× (`GPU_BENCH=1`). Under SwiftShader, CI's software renderer, these numbers are a relative proxy only.

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
│   ├── Starfield.ts   # Instanced quads, shaders, wrapping (near layer)
│   ├── FarStarfield.ts # Far stars at infinity (camera rotation only)
│   ├── Galaxies.ts    # Distant galaxies on the far layer (trip-seeded, rotation only)
│   ├── Autopilot.ts   # Phase 2: travel state machine
│   ├── Planet.ts      # Phase 2
│   ├── Nebula.ts      # Phase 3
│   ├── irregularBody.ts # Phase 4: irregular body geometry (asteroid rocks, comet nuclei)
│   ├── Asteroid.ts    # Phase 4: asteroids (irregular rocky bodies)
│   └── Comet.ts       # Phase 4: comets (nucleus, coma, ion and dust tails)
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
- A fixed heading, so the far stars stay still while the streaks follow the direction of travel
- Pause / Resume, Fullscreen, Speed, keyboard shortcuts
- UI and cursor auto-hide, Wake Lock, reduced motion
- GitHub Pages deploy workflow

**Done when:**

- Stars stream past naturally, and streaks follow the direction of travel. The camera never turns, so the far stars stay still.
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

### Phase 4: Variety & visibility

**Goal:** Every trip is different, and the sky reads clearly.

- A random trip seed on every load, shareable in the URL
- Speed driven by visibility: the ship returns to warp as soon as the object leaves the screen, before or after the closest approach
- Sky legibility: near dust dimmer than the far stars
- Planet variety: rings, icy dwarfs, wider size and pass-distance ranges
- Asteroids
- Comets
- Distant galaxies in the far sky
- Encounters that first appear far out as a small dot, with a short fade-in and a faster far stretch

**Done when:**

- Two loads without a seed in the URL give different trips, and opening a shared URL replays the same sequence of encounters.
- Once the object is wholly outside the live camera view (the screen's aspect ratio and vertical field of view), before or after the closest approach, the ship returns to warp: over the default test seed's first 20 planets at 16:9, 4:3, 21:9 and 32:9, it is at 50% of the cruise speed within 2.5 s of the planet leaving the screen and at 90% within 5 s at the default and slowest levels, and within 4 s and 7 s at the top level, with no step in its speed. A nebula encounter ends once every layer is behind the camera. While the object is on screen the ship is never faster than in Phase 3, but on the far stretch, while the object is still under 3° across.
- A planet, an asteroid or a comet first appears as a dot: at 1080p a median planet's disc, atmosphere included, is at most 12 px across and the largest at most 30 px. It is fully faded in within 4 s of its spawn at every level, with a smooth ease. At the default level a median planet's closest approach comes within twice the 54 s it took before (a large or ringed planet, past 3° across soon after its spawn, has little or no far stretch and takes up to about 147 s).
- The near dust is drawn at a lower brightness than the far stars, so the fixed far stars read as the sky during cruise, and the far stars show visible colour variance.
- With the documented default test seed, the first 50 encounters include at least one ringed planet, icy dwarf, asteroid and comet. Over many seeds, a planet's angular diameter at the closest approach varies by at least 3× between the 10th and 90th percentiles.
- With the default test seed, at least one distant galaxy is generated and on screen from the first frame, and galaxies, like the far stars, never move with travel or over time.
- The camera never passes through a planet, ring, asteroid or comet nucleus, and after 30 minutes JS heap and FPS are not far from their values just after start.

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
