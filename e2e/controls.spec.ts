import { expect, test, type Page } from '@playwright/test';
import type { E2EHookSnapshot } from '../src/e2eHook';
import { SHIP_DEFAULT_SPEED_LEVEL, UI_HIDE_DELAY_MS } from '../src/config';

const APP_PATH = '/elsewhere/';

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
  await page.goto(APP_PATH);
  await page.waitForFunction(() => (window.__elsewhere?.snapshot().frames ?? 0) > 0);
}

function snapshot(page: Page): Promise<E2EHookSnapshot> {
  return page.evaluate(() => window.__elsewhere!.snapshot());
}

function bodyCursor(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).cursor);
}

test('Space toggles pause, and the arrow keys change the speed', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  expect((await snapshot(page)).paused).toBe(false);

  await page.keyboard.press('Space');
  expect((await snapshot(page)).paused).toBe(true);
  await page.keyboard.press('Space');
  expect((await snapshot(page)).paused).toBe(false);

  const before = (await snapshot(page)).speed;
  expect(before).toBe(SHIP_DEFAULT_SPEED_LEVEL);
  await page.keyboard.press('ArrowUp');
  expect((await snapshot(page)).speed).toBe(before + 1);
  await page.keyboard.press('ArrowDown');
  expect((await snapshot(page)).speed).toBe(before);
  expect(errors).toEqual([]);
});

test('the UI shows on mouse move and hides, with the cursor, after about 3 s', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const controls = page.getByRole('toolbar', { name: 'Controls' });

  // Shown on load, then hidden once the delay passes with no input.
  await expect(controls).toBeHidden({ timeout: 15_000 });
  expect(await bodyCursor(page)).toBe('none');

  await page.mouse.move(200, 200);
  await page.mouse.move(240, 220);
  await expect(controls).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Pause' })).toBeVisible();
  expect(await bodyCursor(page)).not.toBe('none');

  // Still shown well before the delay is up, gone by about 3 s (2.5 s plus the fade).
  const shownAt = Date.now();
  await page.waitForTimeout(UI_HIDE_DELAY_MS / 2);
  await expect(controls).toBeVisible({ timeout: 1 });
  await expect(controls).toBeHidden({ timeout: 10_000 });
  expect(Date.now() - shownAt).toBeGreaterThanOrEqual(UI_HIDE_DELAY_MS);
  expect(await bodyCursor(page)).toBe('none');
  expect(errors).toEqual([]);
});

test('the buttons pause, resume and cycle the speed', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await page.mouse.move(100, 100);
  const controls = page.getByRole('toolbar', { name: 'Controls' });

  await controls.getByRole('button', { name: 'Pause' }).click();
  expect((await snapshot(page)).paused).toBe(true);
  await controls.getByRole('button', { name: 'Resume' }).click();
  expect((await snapshot(page)).paused).toBe(false);

  const before = (await snapshot(page)).speed;
  await controls.getByRole('button', { name: /^Speed/ }).click();
  expect((await snapshot(page)).speed).toBe(before + 1);

  // The clicked button keeps focus; Space must still mean pause, not a second click on it.
  await page.keyboard.press('Space');
  const after = await snapshot(page);
  expect(after.paused).toBe(true);
  expect(after.speed).toBe(before + 1);
  expect(errors).toEqual([]);
});
