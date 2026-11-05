# ELSEWHERE

> An endless journey into the unknown.

Autopilot space travel in the browser. Stars stream past, and now and then a procedurally generated planet or nebula drifts by. No missions, no combat, no destination. Just the journey.

An ambient space voyage: a screensaver by format, exploration by content. Cruise is the screensaver, with white stars rushing past in warp. Each encounter is the exploration: the ship drops out of warp, the streaks shrink to dots as it slows, and a planet or nebula appears against the fixed far stars.

Inspired by the Windows Starfield screensaver. Built with Vite, TypeScript and Three.js.

**Live:** <https://zeikar.dev/elsewhere/>

**Status:** MVP complete. Every required feature in [docs/PLAN.md](docs/PLAN.md) section 5 is built, and each item of its verification checklist (section 10) is mapped to a test or a manual step in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Features

- **Autopilot from the first frame.** Travel starts as soon as the page opens, with no interaction. The heading drifts slowly, and the ship eases between speeds.
- **A starfield with depth.** The sky has two layers, each star an instanced quad. 4,000 far stars sit at effectively infinite distance: they turn only with the camera, never move with travel, and stay round dots in subtle blue-white to orange tints, a fixed backdrop for the planets and nebulae. In front of them, 8,000 motes of faint, nearly colourless dust stream past, dimmer than the far stars, as streaks whose length follows the speed. They wrap around the camera and fade near the edges, so none ever pops in or out. Star sizes scale with the device pixel ratio (capped at 2), so stars stay crisp on Retina screens. Most trips also have one to three distant galaxies among the far stars. These are tiny, faint spirals and ellipticals, a few degrees across, with a seeded tilt, rotation and colour. They come from the trip seed, so a shared link shows the same ones, and like the far stars they never move with travel.
- **Planet and nebula encounters.** About every 40 s (each cruise is seeded-jittered around that), something appears in the distance as a faint dot. Before it appears, a ship faster than the default speed drops out of warp to the default speed, so every flyby looks the same from the default speed up. The ship slows as it approaches, passes alongside, and speeds back up into warp as soon as the object is out of view. The first planet appears within 30 to 60 s of load.
- **A new trip on every load, and a link to share it.** Each load draws a random trip seed, which fixes every encounter's kind, look and placement. After load the URL shows it as `?seed=` followed by 8 hex digits (for example `?seed=91b3a5ba`), so copying the URL replays the same trip. A missing or malformed seed starts a new random trip. Every trip starts with a planet.
  - Seeded rocky and gas planets, drawn from palette families such as terran, desert, volcanic, jovian and neptunian, with procedural surfaces, lighting and atmospheric glow. About one in six has a ring system: a thin, banded, translucent annulus with a main gap, tilted toward the ship, which the planet shadows. About one in nine is a Pluto-like icy dwarf, with pale nitrogen-ice plains, dark reddish patches and craters. Planets range from small dwarfs to giants about eight times wider, and each passes at its own distance, so at the closest approach one may fill a wide part of the view and another stay a small disc.
  - Seeded nebulae made of layered, soft-blended planes, in palette families such as emission, reflection, oxygen and planetary.
  - About a third of encounters are nebulae, and never more than three of the same kind come in a row. The path is planned beside each object, so it never passes through a planet, its ring or a nebula's bright core. The ship may drift through a nebula's faint outer wisps, and each layer fades out as the camera nears it.
- **Floating origin.** The camera stays at the origin and the travel position is kept on the CPU in float64, so nothing jitters, however long the journey.
- **Stable over time.** Tab switches stop the clock, so stars don't teleport on return. Every encounter frees its GPU resources, and a soak test checks that heap, frame time and resource counts stay level.
- **Out of the way.** The controls and the cursor hide after 2.5 s without input. A Screen Wake Lock keeps the screen on while travelling, where the browser supports it. With `prefers-reduced-motion: reduce`, travel starts slower with shorter streaks.

## Controls

Travel starts on its own when the page opens. The controls appear on mouse move, touch or key press and hide again after 2.5 s without input.

| Input | Action |
| --- | --- |
| Space | Pause / resume |
| F | Toggle fullscreen (the button is hidden where the Fullscreen API is unavailable) |
| Up / Down arrows | Faster / slower |
| Tap (touch screens) | Show the controls |

## Running locally

Requires Node.js 22.12 or newer.

```sh
npm ci        # install dependencies
npm run dev   # start the Vite dev server, then open the printed URL (served under /elsewhere/)
```

To build and preview the production site:

```sh
npm run build     # type check and build into dist/
npm run preview   # serve dist/ locally
```

## Testing

```sh
npm test            # unit tests (Vitest)
npm run test:e2e    # end-to-end tests (Playwright, Chromium)
npm run typecheck   # type check the app and the e2e suite
```

Before the first e2e run, install the browser with `npx playwright install chromium`. The e2e suite builds the site in e2e mode into `dist-e2e/` and runs against `vite preview`. In that build only, `?encounterInterval=<seconds>` overrides the mean encounter interval (each cruise is still seeded-jittered around it) so encounters come quickly, and `?encounterKind=planet` or `?encounterKind=nebula` makes every encounter that kind. The specs load the app through `appUrl` (e2e/app.ts), which pins the test default trip seed `?seed=91b3a5ba` (`ENCOUNTER_BASE_SEED`), so the suite stays deterministic. The unit tests default to the same seed.

A long-run soak travels through many planet and nebula encounters at a short interval and fails if the JS heap (after a forced GC) grows, if the frame time late in the run is worse than early on, or if the renderer's resource counts drift:

```sh
npm run soak                  # 30 minutes (the default)
SOAK_MINUTES=3 npm run soak   # what CI runs
```

Each sample is taken at CRUISE, at the first one at least 30 s (`SOAK_SAMPLE_SECONDS`) after the previous sample, so samples are spaced by the later of `SOAK_SAMPLE_SECONDS` and the end of the encounter in progress (about one per encounter cycle, 70–80 s under SwiftShader). The early and late frame-time comparison fails if either side pools fewer than 30 CRUISE frames. It writes `soak-report.json` under `test-results/`. The full run can also be started from the Actions tab ([.github/workflows/soak.yml](.github/workflows/soak.yml)).

After `npm run build`, two checks guard the production build:

```sh
npm run check:base   # asset paths resolve under /elsewhere/
npm run check:hook   # the e2e test hook is not in the production build
```

[docs/VERIFICATION.md](docs/VERIFICATION.md) maps each item of the PLAN.md section 10 checklist to the tests above, or to a manual step where automation can't cover it, such as the screen staying on with a real device. `npm test` checks that every file and test title cited there exists.

## Known issues and limitations

- **Fullscreen on iPhone:** Safari on iPhone has no Fullscreen API for pages, so the Fullscreen button is hidden there and F does nothing.
- **Mobile:** Phones and tablets work (tap shows the controls), but performance is tuned for desktop. Expect lower frame rates and more battery use on mobile.
- **Nebulae are the main GPU cost:** During a nebula encounter, large soft-blended layers cover much of the screen, so a weak GPU may drop frames there. Quality presets and adaptive resolution are an Optional item in PLAN.md section 5, and are not built.
- **Screen Wake Lock:** Where the browser doesn't support it, the screen follows the device's own sleep settings. A failed request is logged to the console.
- **Soak length:** CI runs the soak for 3 minutes, under SwiftShader (software rendering), so its frame times say nothing absolute about real hardware. The 30-minute run is started by hand from the Soak workflow ([.github/workflows/soak.yml](.github/workflows/soak.yml)).
- **Not built yet:** The open items in PLAN.md section 5: the Optional quality presets and sound. Ideas that came up while building it are in [IDEAS.md](IDEAS.md).

## Deployment

Every push to `main` is built and deployed to GitHub Pages by [.github/workflows/deploy.yml](.github/workflows/deploy.yml). It can also be run by hand from the Actions tab. Pages must use **GitHub Actions** as its source (Settings → Pages → Source).

## License

[MIT](LICENSE)
