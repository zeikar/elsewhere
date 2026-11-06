/**
 * `test` for the fake-clock specs (e2e/warp.spec.ts, e2e/acceleratedEncounters.spec.ts): each test
 * runs in a browser of its own, which is killed when the test ends (issue #74).
 *
 * Stepping a fake clock (page.clock.fastForward) runs engine frames as fast as the page's main
 * thread can issue them, not as fast as SwiftShader can draw them: nothing waits for the GPU
 * between steps, and since issue #65 each planet encounter adds 48 slices of a 1024² cube-map bake.
 * The GPU process falls minutes behind. At the end of the first warp test, a 1-pixel readPixels
 * (which waits for every frame queued before it) took 178 s, after a 20 s test, and 144 s after the
 * second. When the page closes, the browser's main thread waits on the GPU process to finish its
 * share of that queue, with every core busy (on a 4-core machine: the GPU main thread at about 92%,
 * four SwiftShader threads at 60–90% each, the renderer idle). `Target.disposeBrowserContext`
 * returns at once, but the next command to the browser waited 27–37 s after a warp test and 408 s
 * after the ten-encounter test. Playwright gives each worker one browser, so the next test in the
 * worker waited in `browser.newContext`, under the default 30 s timeout (a `test.setTimeout` in the
 * body takes effect only once the fixtures are set up): the second warp test, which follows the
 * first in the same worker, failed with "Test timeout of 30000ms exceeded while setting up
 * "context"" in nearly every full run. When the fake-clock test was the worker's last, the wait went
 * into closing the browser instead (30 s, then Playwright kills it). e2e/starfield.spec.ts steps a
 * fake clock too, but takes a screenshot after every 8 s of steps, which waits for the frames to be
 * drawn: its tests left at most 3.3 s of such waiting, so it keeps the worker's browser.
 *
 * A browser per test, killed at the end, drops that queue: the next test starts in a browser whose
 * GPU process is idle, and the cores are free for the other worker's tests at once. Measured and
 * rejected: waiting for the browser after closing the page puts the wait in the test that queued
 * the work, but makes the ten-encounter test 408 s longer; syncing with the GPU after every batch
 * of clock steps bounds the queue, but makes each test wait for all of its frames to be drawn,
 * minutes each; crashing the GPU process (CDP `Browser.crashGpuProcess`) drops the queue too, but
 * after the third crash the browser runs no WebGL at all. A longer timeout for the next test's
 * set-up would only hide the wait, and could not cover the 408 s. Nothing a test checks changes:
 * the page gets the project's launch and context options as before (Playwright applies them to
 * every browser and context the worker creates).
 */
import { test as base } from '@playwright/test';

export const test = base.extend({
  context: async ({ playwright, browserName }, use) => {
    const browserType = playwright[browserName];
    const server = await browserType.launchServer();
    try {
      const browser = await browserType.connect(server.wsEndpoint());
      await use(await browser.newContext());
    } finally {
      // Not a graceful close: that waits on the GPU process as above (up to Playwright's 30 s).
      await server.kill();
    }
  },
});

export { expect } from '@playwright/test';
