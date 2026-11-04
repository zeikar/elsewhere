import { expect, test, type Page } from '@playwright/test';

const APP_PATH = '/elsewhere/';

// SwiftShader renders at only a few fps, which slows every page interaction; leave headroom over
// Playwright's 30 s default.
test.describe.configure({ timeout: 60_000 });

interface WakeLockLog {
  requests: number;
  releases: number;
  held: number;
}

declare global {
  interface Window {
    __wakeLockLog?: WakeLockLog;
  }
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/**
 * Replaces navigator.wakeLock with a fake that records requests and releases, and lets the test
 * hide the tab (the browser then releases the lock, like a real one does).
 */
async function stubWakeLock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log = { requests: 0, releases: 0, held: 0 };
    window.__wakeLockLog = log;
    const live = new Set<EventTarget & { released: boolean }>();
    function releaseSentinel(sentinel: EventTarget & { released: boolean }): void {
      if (sentinel.released) return;
      sentinel.released = true;
      live.delete(sentinel);
      log.releases++;
      log.held = live.size;
      sentinel.dispatchEvent(new Event('release'));
    }
    const wakeLock = {
      request(type: string) {
        log.requests++;
        if (type !== 'screen') return Promise.reject(new TypeError('bad type'));
        if (document.visibilityState !== 'visible') {
          return Promise.reject(new DOMException('hidden', 'NotAllowedError'));
        }
        const sentinel = Object.assign(new EventTarget(), {
          released: false,
          type: 'screen',
          release: async () => releaseSentinel(sentinel),
        });
        live.add(sentinel);
        log.held = live.size;
        return Promise.resolve(sentinel);
      },
    };
    Object.defineProperty(navigator, 'wakeLock', { value: wakeLock, configurable: true });

    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => visibility === 'hidden', configurable: true });
    (window as unknown as { __setVisibility: (v: DocumentVisibilityState) => void }).__setVisibility = (v) => {
      visibility = v;
      // The browser releases wake locks when the page is hidden.
      if (v === 'hidden') for (const sentinel of [...live]) releaseSentinel(sentinel);
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

function wakeLockLog(page: Page): Promise<WakeLockLog> {
  return page.evaluate(() => ({ ...window.__wakeLockLog! }));
}

function setVisibility(page: Page, state: DocumentVisibilityState): Promise<void> {
  return page.evaluate(
    (v) => (window as unknown as { __setVisibility: (v: DocumentVisibilityState) => void }).__setVisibility(v),
    state,
  );
}

test('the wake lock is held while travelling, released on pause and re-requested on resume and return', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await stubWakeLock(page);
  await page.goto(APP_PATH);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);

  await expect.poll(() => wakeLockLog(page)).toEqual({ requests: 1, releases: 0, held: 1 });

  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__elsewhere!.snapshot().paused)).toBe(true);
  await expect.poll(() => wakeLockLog(page)).toEqual({ requests: 1, releases: 1, held: 0 });

  await page.keyboard.press('Space');
  await expect.poll(() => wakeLockLog(page)).toEqual({ requests: 2, releases: 1, held: 1 });

  // Hidden: released by the browser, and not requested again until the tab is visible.
  await setVisibility(page, 'hidden');
  await expect.poll(() => wakeLockLog(page)).toEqual({ requests: 2, releases: 2, held: 0 });
  await setVisibility(page, 'visible');
  await expect.poll(() => wakeLockLog(page)).toEqual({ requests: 3, releases: 2, held: 1 });
  expect(errors).toEqual([]);
});
