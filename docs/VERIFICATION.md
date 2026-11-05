# Verification

This maps each item of the verification checklist in [PLAN.md section 10](PLAN.md#10-verification-checklist) to the automated checks that cover it. Where automation can't fully cover an item, it also gives a manual step, for example "screen stays on" on a real device.

Each automated check is written as `file` — `test title`, using the title as it appears in the source. A parameterised title keeps its placeholders (`$label`, `%f`, `${…}`). An entry with no title is a script or workflow that runs as a whole.

| Location | Runs with |
| --- | --- |
| `src/**/*.test.ts` | `npm test` (Vitest), in CI |
| `e2e/*.spec.ts` | `npm run test:e2e` (Playwright, Chromium with SwiftShader), in CI |
| `e2e/soak/soak.spec.ts` | `npm run soak`: 5 minutes in CI, 30 minutes from the Soak workflow |
| `scripts/check-base.mjs` | `npm run check:base` after `npm run build`, in CI and before every deploy |

[`src/verification.test.ts`](../src/verification.test.ts) keeps this file honest, and runs in `npm test`. It checks that every section 10 item has a heading here with the same text, that each one lists at least one check or manual step, that every cited file exists, and that every cited test title appears in its file.

## 1. Travel starts on page load with no interaction.

- `e2e/engine.spec.ts` — `loads at /elsewhere/ without errors, fills the viewport and travels on its own`
- `src/engine/Autopilot.test.ts` — `starts in CRUISE at cruise speed with full drift and no encounter`

## 2. Stars are crisp and correctly sized on high-DPI screens.

- `e2e/starfield.spec.ts` — `multiplies star pixel sizes by the applied DPR`
- `e2e/engine.spec.ts` — `backs the canvas at 2× and follows viewport resizes`
- `src/engine/Starfield.test.ts` — `use the applied DPR from computeRenderSize, and pixel size = base size × applied DPR`
- `src/engine/FarStarfield.test.ts` — `setRenderSize writes the applied DPR, pixel size = base size × applied DPR and the viewport into its uniforms`
- `src/engine/renderSize.test.ts` — `caps the device pixel ratio: (1000, 500, 3, 2) gives 2000×1000 at DPR 2`
- `src/config.test.ts` — `caps the device pixel ratio at 2`
- Manual: open the site on a Retina or other high-DPI display and on a standard one. Stars, both the far stars and the near dust, should look like small, sharp, round points of light, at the same CSS size on both. Automation checks the sizes, but whether stars look crisp is a visual judgement.

## 3. Refresh-rate independence: feeding the simulation update `dt = 1/60` 60 times and `dt = 1/120` 120 times gives the same distance within tolerance. 120 Hz is hard to reproduce with browser automation, so verify this way.

- `src/engine/Ship.test.ts` — `travels the same distance at 60 Hz and 120 Hz ($label)`
- `src/engine/Autopilot.test.ts` — `the timeline matches between dt = 1/60 and dt = 1/120 over %i encounters`
- `src/engine/Autopilot.test.ts` — `at the top speed level the timeline, warp entry and exit included, matches between dt = 1/60 and dt = 1/120 over %i encounters`
- `src/engine/Autopilot.test.ts` — `the timeline at dt = %f matches dt = 1/144 over 6 encounters, kinds and states included`
- `src/engine/Autopilot.test.ts` — `from load with defaults, goes APPROACH, FLYBY, DEPARTURE, CRUISE, and the planet is visible within 30-60 s (dt = %f)`
- `src/engine/FrameCap.test.ts` — `draws every frame of a display at or under the cap ($label): never halved to 30`
- `src/engine/FrameCap.test.ts` — `at 120 Hz draws exactly every other display frame`
- `e2e/perf.spec.ts` — `the frame-rate cap: the engine draws at most the cap a second, and the simulation stays real time`

## 4. Coming back to a tab hidden for a long time doesn't teleport the stars.

- `src/engine/FrameClock.test.ts` — `after a 10-minute hidden period, the next dt is at most one normal frame`
- `src/engine/FrameClock.test.ts` — `returns no time at all while hidden`
- `e2e/engine.spec.ts` — `a hidden tab stops the clock and returning to it does not jump`
- `e2e/perf.spec.ts` — `hidden → 5 s → visible mid-encounter moves the ship by no more than one capped frame`
- Manual: headless Chromium never really hides a page, so the e2e tests stub `visibilityState`. In a real browser, switch to another tab for a few minutes, then come back. Travel should carry on from where it was, with no jump in the stars or a planet in view.

## 5. The camera never jumps or passes through a planet during an approach.

- `src/engine/encounter.test.ts` — `places the centre D ahead and radius × k to the side, so the closest approach is radius × k`
- `src/engine/encounter.test.ts` — `a ship flying the straight path never gets closer than radius × k`
- `src/engine/Autopilot.test.ts` — `keeps clear of the planet, never jumps and turns smoothly (radius $radius, cruise $cruiseSpeed)`
- `src/engine/Autopilot.test.ts` — `%s: clearance ≥ radius × (1 + margin) and no frame jumps`
- `src/engine/Autopilot.test.ts` — `the drop out of warp and the return to it are smooth around $kind encounters: no step in the target speed or the speed at any frame (dt $dt)`
- `src/engine/Autopilot.test.ts` — `the quick entry (after an object left the screen): the ship itself follows a smootherstep to the cruise speed, no steeper than its max rate, with no step and a bounded jerk`
- `src/engine/encounter.test.ts` — `the ship follows it ($label): smooth, accelerating at about the far acceleration at most, with a bounded jerk, and at the cruise speed with no acceleration at its end`
- `src/engine/encounter.test.ts` — `is at least the whole fall from the far speed long, at every level, or not there at all`
- `src/engine/farStretch.test.ts` — `at level $level (dt $dt), from the spawn to 200 units past the end of every far stretch, short ones included, the ship’s jerk stays under 10 and the target speed never steps`
- `src/engine/Autopilot.test.ts` — `the ship is out of warp when the $kind leaves its far stretch (a nebula: reaches opacity 0.1), and flies the profile for its encounter speed from there (dt $dt)`
- `src/engine/EncounterView.test.ts` — `at speed level $level ($cruiseSpeed u/s) a median planet sweeps past no faster in angle than before #36, and is reached within 2× the time it was before #64`
- `e2e/warp.spec.ts` — `at the top speed the ship stays in warp into a planet encounter, is out of it by the end of the far stretch, and returns to warp after it`
- `src/engine/Autopilot.test.ts` — `level %i: over the default trip’s first 20 planets the ship is at 50% and 90% of the cruise speed within the limits of leaving the screen`
- `e2e/warp.spec.ts` — `at the default speed the ship is at 50% and 90% of the cruise speed within 2.5 s and 5 s of the planet leaving the screen`
- `src/engine/Planet.test.ts` — `the atmosphere shell stays inside the guaranteed clearance, so the camera never enters it`
- `src/engine/EncounterView.test.ts` — `the planned straight path crosses the ring plane of 1,000 seeded ringed planets only beyond the ring, at any heading and elevation`
- `src/engine/EncounterView.test.ts` — `the ship, flown frame by frame at every level, never crosses a ring or comes within its clearance: 90 ringed encounters`
- `src/engine/Asteroid.test.ts` — `the planned path passes every rock of 2,000 seeded asteroids, as drawn, at least the minimum pass distance from its centre and clear of it, at any heading and side`
- `src/engine/Asteroid.test.ts` — `the ship, flown frame by frame at every level, never comes within the minimum pass distance of any rock: 60 asteroid encounters`
- `src/engine/Asteroid.test.ts` — `at speed level $level ($cruiseSpeed u/s) no rock of 2,000 seeded asteroids sweeps past faster in angle than the planet guard (5.1°/s)`
- `e2e/asteroid.spec.ts` — `a forced asteroid encounter draws lit rocks, runs the full cycle, compiles nothing and frees its GPU resources`
- `src/engine/Comet.test.ts` — `for 2,000 seeded comets the path passes the nucleus at least the minimum pass distance off, outside the coma, and never meets a tail`
- `src/engine/Comet.test.ts` — `the ship, flown frame by frame at every level, keeps the planned distance from the nucleus and never enters the coma or a tail: 30 comet encounters`
- `src/engine/Comet.test.ts` — `at speed level $level ($cruiseSpeed u/s) neither the nucleus nor any point of a tail of 2,000 seeded comets sweeps past faster in angle than the planet guard (5.1°/s)`
- `src/engine/Comet.test.ts` — `never folds the nucleus through its centre: every vertex of 300 seeded nuclei keeps at least the soft floor over the farthest radius, with every normal facing out`
- `src/engine/Comet.test.ts` — `over 40 seeded comets at 4:3, 16:9 and 21:9, from the spawn to the end of the encounter, the glow never fills the view`
- `e2e/comet.spec.ts` — `a forced comet encounter draws its coma and tails, runs the full cycle, compiles nothing and frees its GPU resources`
- `src/engine/EncounterView.test.ts` — `a ringed planet is drawn with its ring turned toward its encounter, and a ring that does not fit the plan is not drawn`
- `src/engine/EncounterView.test.ts` — `at the reduced-motion level the floored minimum speed keeps the clearance and gradual fades (dt = %f)`
- `e2e/encounter.spec.ts` — `three encounters run CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE and free their GPU resources`
- `e2e/encounter.spec.ts` — `mid-APPROACH the planet is lit on the engine canvas, and pause → resume → ArrowUp keeps the encounter consistent`

## 6. Objects never appear or vanish abruptly.

- `src/engine/Starfield.test.ts` — `is 0 on the cube boundary`
- `src/engine/Starfield.test.ts` — `is 0 at the camera and at the near plane, so no mote is cut off by it while still visible`
- `src/engine/Starfield.test.ts` — `stays within [0, 1] and is continuous: no big step across a fine sample grid`
- `e2e/starfield.spec.ts` — `after the ship translates with no rotation, far-star pixels stay put while near stars move`
- `src/engine/encounter.test.ts` — `starts at opacity 0 and at full size for a non-default D (no pop-in)`
- `src/engine/encounter.test.ts` — `opacity is 0 at the spawn and despawn distances, and 1 around the closest approach`
- `src/engine/encounter.test.ts` — `changes by less than ${FADE_EPSILON} over a 0.1 s capped frame at the top speed`
- `src/engine/encounter.test.ts` — `fades in over ${ENCOUNTER_FADE_IN_SECONDS} s: under 0.7% a frame at 60 FPS and under 3.8% in a 0.1 s capped frame, at every speed`
- `src/engine/Planet.test.ts` — `at first appearance (the spawn) a median planet, atmosphere included, is at most 12 px across at 1080p and the largest at most 30 px`
- `src/engine/Asteroid.test.ts` — `at first appearance (the spawn) the field, its bounding sphere, is at most 12 px across at 1080p for the median asteroid and 30 px for the largest`
- `src/engine/Comet.test.ts` — `at first appearance (the spawn) the coma is at most 10 px across at 1080p, and the whole comet is inside the far plane`
- `e2e/encounter.spec.ts` — `at first appearance, fully faded in, the planet is a small dot at 1080p, over the sky`
- `src/engine/Planet.test.ts` — `at the spawn the 24-bit depth buffer keeps a ring behind the disc at least two steps behind it, so it never shows through (CAMERA_NEAR)`
- `src/engine/Planet.test.ts` — `the far stars and galaxies stay behind it: the whole planet, ring and side offset included, is inside CAMERA_FAR at the spawn`
- `e2e/planet.spec.ts` — `a planet hides the far stars behind its disc, and they show all around it${name}`
- `e2e/planet.spec.ts` — `a planet hides a distant galaxy behind its disc, and one beside it shows${name}`
- `src/engine/Nebula.test.ts` — `is 0 up to the minimum distance, 1 from the end of the fade, monotonic and continuous`
- `src/engine/Nebula.test.ts` — `every layer fades out continuously and is 0 before the camera is within the minimum of its plane (dt $dt, level $level)`
- `src/engine/EncounterView.test.ts` — `keeps a new planet hidden until its compile settles, then follows the fade`
- `e2e/planet.spec.ts` — `a baked planet looks as the procedural one does over its disc, apart from filtering, framed as usual and close up`
- `e2e/gpuCost.spec.ts` — `a planet bakes its surface while it is still a dot, from warmed programs, and frees the cube maps with it`
- `src/engine/EncounterView.test.ts` — `keeps a new nebula hidden until its compile settles`
- `src/engine/Autopilot.test.ts` — `planets at level %i, k from 1.6 to 6, elevations from -0.6 to 0.6, at every aspect: while on screen the ship is never faster than on main, and it is never on screen again after the encounter ends`
- `src/engine/Autopilot.test.ts` — `ringed planets at level %i, the widest ring, k from its clearance to 6, tilts and elevations from -0.6 to 0.6: while the planet or its ring is on screen the ship is never faster than on main, and neither is on screen again after the encounter ends`
- `src/engine/Autopilot.test.ts` — `nebulae at level %i, elevations from -0.6 to 0.6: while any layer is on screen the ship is never faster than on main, and none is on screen again after the encounter ends`
- `src/engine/Autopilot.test.ts` — `asteroids at level %i, seeded single rocks and fields, elevations from -0.6 to 0.6: while any rock is on screen the ship is never faster than on main, and none is on screen again after the encounter ends`
- `src/engine/Autopilot.test.ts` — `comets at level %i, elevations from -0.6 to 0.6, at 16:9 and 32:9: while the coma or any stretch of a tail is on screen the ship is never faster than on main, and none is on screen again after the encounter ends`
- `src/engine/Autopilot.test.ts` — `level %i: over the first 8 comets of a comets-only trip the ship is at 50% and 90% of the cruise speed within the limits of the comet leaving the screen`
- `src/engine/Autopilot.test.ts` — `at level %i a comet encounter ends as soon as the comet is off screen, and the ship is back at the arrival speed soon after`
- `src/engine/Comet.test.ts` — `fades in and out with the encounter opacity in the encounter view, and frees both meshes`
- `e2e/rings.spec.ts` — `a ring shows in front of its planet and against the sky, and the planet hides the ring behind it`
- `src/engine/Autopilot.test.ts` — `frustumSphereMargin matches a real camera: positive exactly when no point of the sphere projects on screen`
- `src/engine/Autopilot.test.ts` — `at $name, with the heading held, an object once off screen would stay off screen for the rest of its pass`
- `src/engine/renderSize.test.ts` — `is the camera view the engine sets up: the aspect, and half the vertical field of view of cameraFovDeg`
- `e2e/encounter.spec.ts` — `three encounters run CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE and free their GPU resources`
- Manual: watch a few encounters, either on the live site (the first planet appears within about a minute) or on the e2e build with a short interval (`npm run build:e2e && npx vite preview --outDir dist-e2e`, then open `/elsewhere/?encounterInterval=5`, adding `&encounterKind=asteroid` or `&encounterKind=comet` for asteroids or comets alone). Stars, planets, nebulae, asteroids and comets should fade in and out with no visible pop. A planet, an asteroid or a comet should first appear far off as a small, star-like dot within a few seconds and then grow, never as a large disc brightening from dark, and the dust streaks should lengthen and shorten smoothly over its far stretch. Smoothness on screen is a visual judgement. The `Starfield.test.ts` checks above test `starFade` in `src/engine/Starfield.ts`, the TypeScript mirror of the shader's star fade, so the GLSL that actually runs on the GPU is covered only by this manual step.

## 7. Fullscreen, pause, speed change and keyboard shortcuts work.

- `e2e/controls.spec.ts` — `Space toggles pause, and the arrow keys change the speed`
- `e2e/controls.spec.ts` — `the buttons pause, resume and cycle the speed`
- `e2e/engine.spec.ts` — `pause() stops the simulation and resume() restarts it without a jump`
- `src/ui/controls.test.ts` — `Space calls pause() and resume() alternately`
- `src/ui/controls.test.ts` — `Up/Down step to the next/previous level and clamp at the ends`
- `src/ui/controls.test.ts` — `F toggles fullscreen (either case)`
- `src/ui/controls.test.ts` — `Fullscreen requests and exits fullscreen`
- `src/ui/controls.test.ts` — `hides the button and makes F a no-op when fullscreenEnabled is ${enabled}`
- Manual: headless Chromium can't really enter fullscreen, so the unit tests stub the Fullscreen API. In a desktop browser, press F and click the Fullscreen button. Each should enter fullscreen, and F, the button or Esc should leave it. On an iPhone in Safari, the Fullscreen button should not be shown.

## 8. UI and cursor hide without input and come back on input.

- `e2e/controls.spec.ts` — `the UI shows on mouse move and hides, with the cursor, after about 3 s`
- `e2e/controls.spec.ts` — `a tap elsewhere on the hidden UI just reveals it`
- `e2e/controls.spec.ts` — `a tap on a hidden button only reveals the UI; a tap on a visible one presses it`
- `src/ui/controls.test.ts` — `shows on mousemove, hides after the delay, and hides the cursor exactly while hidden`
- `src/ui/controls.test.ts` — `further input restarts the hide timer`
- `src/ui/controls.test.ts` — `a keydown or a touchstart shows it again`

## 9. The screen stays on while travelling, and the Wake Lock is released on pause.

- `e2e/wakeLock.spec.ts` — `the wake lock is held while travelling, released on pause and re-requested on resume and return`
- `src/ui/wakeLock.test.ts` — `requests the lock on start when the tab is visible`
- `src/ui/wakeLock.test.ts` — `releases the lock on pause and requests it again on resume`
- `src/ui/wakeLock.test.ts` — `requests it again when the tab becomes visible after the browser released it`
- `src/ui/wakeLock.test.ts` — `does nothing and logs nothing where the Wake Lock API is unsupported`
- Manual: the automated tests use a fake `navigator.wakeLock`, so they check only that the lock is requested and released. On a real device with a short screen timeout (for example 30 s), leave the site travelling for longer than the timeout. The screen should stay on. Then pause, and the screen should turn off after the usual timeout.

## 10. With reduced motion set, travel starts at the slower default.

- `e2e/reducedMotion.spec.ts` — `travel starts at the reduced default speed and streak time, and ArrowUp still raises the speed`
- `e2e/reducedMotion.spec.ts` — `travel starts at the normal default speed and streak time`
- `src/config.test.ts` — `returns the reduced speed level and streak time under reduced motion`
- `src/config.test.ts` — `the reduced settings are slower and shorter, and still leave room to speed up`

## 11. The aspect ratio is correct after resizing.

- `e2e/engine.spec.ts` — `backs the canvas at 2× and follows viewport resizes`
- `src/engine/Starfield.test.ts` — `are written into the Starfield material uniforms on setRenderSize`
- `src/engine/FarStarfield.test.ts` — `setRenderSize writes the applied DPR, pixel size = base size × applied DPR and the viewport into its uniforms`
- `src/engine/renderSize.test.ts` — `rounds fractional backing sizes down, like WebGLRenderer.setSize`
- `src/engine/renderSize.test.ts` — `is the camera view the engine sets up: the aspect, and half the vertical field of view of cameraFovDeg`

## 12. After 30 minutes, memory and FPS have not degraded noticeably.

- `e2e/soak/soak.spec.ts` — `soak: ${SOAK_MINUTES} min, heap, frame time and GPU resources stay stable`
- `.github/workflows/ci.yml` (the `soak` job runs the soak for 5 minutes on every pull request and on every push to `main`)
- `.github/workflows/soak.yml` (the full run, started by hand, 30 minutes by default)
- `e2e/acceleratedEncounters.spec.ts` — `ten encounters, accelerated with a fake clock, leave the GPU resources at their baseline every time`
- `e2e/starfield.spec.ts` — `soak: GPU resources stay constant and the JS heap does not grow`
- `src/engine/longRun.test.ts` — `100 accelerated encounters, planets, nebulae, asteroids and comets, each return every resource to baseline`
- `src/engine/PlanetBake.test.ts` — `frees the cube maps and every material with the planet; the memory is as documented`
- `src/engine/longRun.test.ts` — `120 accelerated asteroid encounters, fields of up to 7 rocks among them, each free every rock geometry and material`
- `src/engine/longRun.test.ts` — `120 accelerated comet encounters each free the nucleus and the glow, with no growth over the run`
- `e2e/asteroid.spec.ts` — `a forced asteroid encounter draws lit rocks, runs the full cycle, compiles nothing and frees its GPU resources`
- `e2e/comet.spec.ts` — `a forced comet encounter draws its coma and tails, runs the full cycle, compiles nothing and frees its GPU resources`
- Manual: CI runs only the 5-minute soak. For the full 30 minutes, start the Soak workflow from the Actions tab (`minutes` defaults to 30) and check the `soak-report` artifact. SwiftShader frame rates say nothing about a real GPU, so also leave the live site running for 30 minutes in desktop Chrome with DevTools' Performance monitor open. The JS heap and frame rate at the end should be close to their values just after start.

## 13. Asset paths resolve at `https://zeikar.dev/elsewhere/`.

- `scripts/check-base.mjs` (`npm run check:base`, in CI and in the deploy workflow before upload)
- `e2e/engine.spec.ts` — `loads at /elsewhere/ without errors, fills the viewport and travels on its own`
- Manual: after a deploy, open <https://zeikar.dev/elsewhere/> with DevTools' Network panel open. Every request should succeed, with no 404s, and travel should start.
