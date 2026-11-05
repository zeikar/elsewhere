import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { SHIP_SPEED_LEVELS, initialSpeedSettings } from '../src/config';
import { appUrl } from './app';

// SwiftShader renders at only a few fps, which slows every page interaction; leave headroom over
// Playwright's 30 s default.
test.describe.configure({ timeout: 60_000 });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(appUrl());
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

test.describe('with prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  test('travel starts at the reduced default speed and streak time, and ArrowUp still raises the speed', async ({
    page,
  }) => {
    const reduced = initialSpeedSettings(true);
    expect(reduced.speedLevel).toBeLessThan(SHIP_SPEED_LEVELS.length - 1);
    const errors = collectErrors(page);
    await openApp(page);

    const snap = await snapshot(page);
    expect(snap.speed).toBe(reduced.speedLevel);
    expect(snap.starfield.streakTime).toBeCloseTo(reduced.streakTime, 6);
    expect(snap.paused).toBe(false);

    await page.keyboard.press('ArrowUp');
    expect((await snapshot(page)).speed).toBeGreaterThan(reduced.speedLevel);
    expect(errors).toEqual([]);
  });
});

test.describe('without reduced motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('travel starts at the normal default speed and streak time', async ({ page }) => {
    const defaults = initialSpeedSettings(false);
    const errors = collectErrors(page);
    await openApp(page);

    const snap = await snapshot(page);
    expect(snap.speed).toBe(defaults.speedLevel);
    expect(snap.starfield.streakTime).toBeCloseTo(defaults.streakTime, 6);
    expect(errors).toEqual([]);
  });
});
