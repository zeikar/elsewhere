# ELSEWHERE

> An endless journey into the unknown.

Autopilot space travel in the browser. Stars stream past, and now and then a procedurally generated planet or nebula drifts by. No missions, no combat, no destination. Just the journey.

Inspired by the Windows Starfield screensaver. Built with Vite, TypeScript and Three.js.

**Live:** <https://zeikar.dev/elsewhere/>

**Status:** Phase 1 (starfield). The design and the phased roadmap are in [docs/PLAN.md](docs/PLAN.md).

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
```

Before the first e2e run, install the browser with `npx playwright install chromium`. The e2e suite builds the site in e2e mode into `dist-e2e/` and runs against `vite preview`. In that build only, `?encounterInterval=<seconds>` overrides the mean encounter interval (each cruise is still seeded-jittered around it) so encounters come quickly, and `?encounterKind=planet` or `?encounterKind=nebula` makes every encounter that kind.

A long-run soak travels through many planet and nebula encounters at a short interval and fails if the JS heap (after a forced GC) grows, if the frame time late in the run is worse than early on, or if the renderer's resource counts drift:

```sh
npm run soak                  # 30 minutes (the default)
SOAK_MINUTES=3 npm run soak   # what CI runs
```

It samples every 30 s (`SOAK_SAMPLE_SECONDS`) and writes `soak-report.json` under `test-results/`. The full run can also be started from the Actions tab ([.github/workflows/soak.yml](.github/workflows/soak.yml)).

After `npm run build`, two checks guard the production build:

```sh
npm run check:base   # asset paths resolve under /elsewhere/
npm run check:hook   # the e2e test hook is not in the production build
```

## Deployment

Every push to `main` is built and deployed to GitHub Pages by [.github/workflows/deploy.yml](.github/workflows/deploy.yml). It can also be run by hand from the Actions tab. Pages must use **GitHub Actions** as its source (Settings → Pages → Source).

## License

[MIT](LICENSE)
