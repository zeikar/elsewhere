# Verification

This maps each item of the verification checklist in [PLAN.md section 10](PLAN.md#10-verification-checklist) to the automated checks that cover it. Where automation can't fully cover an item, it also gives a manual step, for example "screen stays on" on a real device.

Each automated check is written as `file` — `test title`, using the title as it appears in the source. A parameterised title keeps its placeholders (`$label`, `%f`, `${…}`). An entry with no title is a script or workflow that runs as a whole.

| Location | Runs with |
| --- | --- |
| `src/**/*.test.ts` | `npm test` (Vitest), in CI |
| `e2e/*.spec.ts` | `npm run test:e2e` (Playwright, Chromium with SwiftShader), in CI |
| `e2e/soak/soak.spec.ts` | `npm run soak`: 3 minutes in CI, 30 minutes from the Soak workflow |
| `scripts/check-base.mjs` | `npm run check:base` after `npm run build`, in CI and before every deploy |

[`src/verification.test.ts`](../src/verification.test.ts) keeps this file honest, and runs in `npm test`. It checks that every section 10 item has a heading here with the same text, that each one lists at least one check or manual step, that every cited file exists, and that every cited test title appears in its file.

## 1. Travel starts on page load with no interaction.

- `e2e/engine.spec.ts` — `loads at /elsewhere/ without errors, fills the viewport and travels on its own`
- `src/engine/Autopilot.test.ts` — `starts in CRUISE at cruise speed with full drift and no encounter`

## 2. Stars are crisp and correctly sized on high-DPI screens.

- `e2e/starfield.spec.ts` — `multiplies star pixel sizes by the applied DPR`
- `e2e/engine.spec.ts` — `backs the canvas at 2× and follows viewport resizes`
- `src/engine/Starfield.test.ts` — `use the applied DPR from computeRenderSize, and pixel size = base size × applied DPR`
- `src/engine/renderSize.test.ts` — `caps the device pixel ratio: (1000, 500, 3, 2) gives 2000×1000 at DPR 2`
- `src/config.test.ts` — `caps the device pixel ratio at 2`
- Manual: open the site on a Retina or other high-DPI display and on a standard one. Stars should look like small, sharp, round points of light, at the same CSS size on both. Automation checks the sizes, but whether stars look crisp is a visual judgement.

## 3. Refresh-rate independence: feeding the simulation update `dt = 1/60` 60 times and `dt = 1/120` 120 times gives the same distance within tolerance. 120 Hz is hard to reproduce with browser automation, so verify this way.

- `src/engine/Ship.test.ts` — `travels the same distance at 60 Hz and 120 Hz ($label)`
- `src/engine/Autopilot.test.ts` — `the timeline matches between dt = 1/60 and dt = 1/120 over %i encounters`
- `src/engine/Autopilot.test.ts` — `from load with defaults, goes APPROACH, FLYBY, DEPARTURE, CRUISE, and the planet is visible within 30-60 s (dt = %f)`

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
- `src/engine/Planet.test.ts` — `the atmosphere shell stays inside the guaranteed clearance, so the camera never enters it`
- `src/engine/EncounterView.test.ts` — `at the reduced-motion level the floored minimum speed keeps the clearance and gradual fades (dt = %f)`
- `e2e/encounter.spec.ts` — `three encounters run CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE and free their GPU resources`
- `e2e/encounter.spec.ts` — `mid-APPROACH the planet is lit on the engine canvas, and pause → resume → ArrowUp keeps the encounter consistent`

## 6. Objects never appear or vanish abruptly.

- `src/engine/Starfield.test.ts` — `is 0 on the cube boundary`
- `src/engine/Starfield.test.ts` — `is 0 at the camera`
- `src/engine/Starfield.test.ts` — `stays within [0, 1] and is continuous: no big step across a fine sample grid`
- `src/engine/encounter.test.ts` — `starts at opacity 0 and at full size for a non-default D (no pop-in)`
- `src/engine/encounter.test.ts` — `opacity is 0 at the spawn and despawn distances, and 1 around the closest approach`
- `src/engine/encounter.test.ts` — `changes by less than ${FADE_EPSILON} over a 0.1 s capped frame at the top speed`
- `src/engine/Nebula.test.ts` — `is 0 up to the minimum distance, 1 from the end of the fade, monotonic and continuous`
- `src/engine/Nebula.test.ts` — `every layer fades out continuously and is 0 before the camera is within the minimum of its plane (dt $dt, level $level)`
- `src/engine/EncounterView.test.ts` — `keeps a new planet hidden until its compile settles, then follows the fade`
- `src/engine/EncounterView.test.ts` — `keeps a new nebula hidden until its compile settles`
- `e2e/encounter.spec.ts` — `three encounters run CRUISE → APPROACH → FLYBY → DEPARTURE → CRUISE and free their GPU resources`
- Manual: watch a few encounters, either on the live site (the first planet appears within about a minute) or on the e2e build with a short interval (`npm run build:e2e && npx vite preview --outDir dist-e2e`, then open `/elsewhere/?encounterInterval=5`). Stars, planets and nebulae should fade in and out with no visible pop. Smoothness on screen is a visual judgement. The `Starfield.test.ts` checks above test `starFade` in `src/engine/Starfield.ts`, the TypeScript mirror of the shader's star fade, so the GLSL that actually runs on the GPU is covered only by this manual step.

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
- `src/engine/renderSize.test.ts` — `rounds fractional backing sizes down, like WebGLRenderer.setSize`

## 12. After 30 minutes, memory and FPS have not degraded noticeably.

- `e2e/soak/soak.spec.ts` — `soak: ${SOAK_MINUTES} min, heap, frame time and GPU resources stay stable`
- `.github/workflows/ci.yml` (the `soak` job runs the soak for 3 minutes on every pull request and on every push to `main`)
- `.github/workflows/soak.yml` (the full run, started by hand, 30 minutes by default)
- `e2e/acceleratedEncounters.spec.ts` — `ten encounters, accelerated with a fake clock, leave the GPU resources at their baseline every time`
- `e2e/starfield.spec.ts` — `soak: GPU resources stay constant and the JS heap does not grow`
- `src/engine/longRun.test.ts` — `100 accelerated encounters, planets and nebulae, each return every resource to baseline`
- Manual: CI runs only the 3-minute soak. For the full 30 minutes, start the Soak workflow from the Actions tab (`minutes` defaults to 30) and check the `soak-report` artifact. SwiftShader frame rates say nothing about a real GPU, so also leave the live site running for 30 minutes in desktop Chrome with DevTools' Performance monitor open. The JS heap and frame rate at the end should be close to their values just after start.

## 13. Asset paths resolve at `https://zeikar.dev/elsewhere/`.

- `scripts/check-base.mjs` (`npm run check:base`, in CI and in the deploy workflow before upload)
- `e2e/engine.spec.ts` — `loads at /elsewhere/ without errors, fills the viewport and travels on its own`
- Manual: after a deploy, open <https://zeikar.dev/elsewhere/> with DevTools' Network panel open. Every request should succeed, with no 404s, and travel should start.
