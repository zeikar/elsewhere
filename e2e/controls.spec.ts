import { expect, test, type Locator, type Page } from '@playwright/test';
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

// The UI hides UI_HIDE_DELAY_MS after the last input. Under SwiftShader a single Playwright step
// can take longer than that, so no test may assume the UI is still shown from an earlier step: the
// helpers below re-reveal it right before they use it, and retry if it hid again in between.

/** Shows the UI with a mouse move and waits until it is visible, moving again if it hid meanwhile. */
async function revealControls(page: Page): Promise<void> {
  const controls = page.getByRole('group', { name: 'Controls' });
  await expect(async () => {
    // Two moves, so there is always a real mousemove whatever the pointer's last position.
    await page.mouse.move(100, 100);
    await page.mouse.move(120, 110);
    await expect(controls).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Clicks a control button on the shown UI. Playwright only delivers the click when the button is
 * the hit target, so an attempt that finds the UI hidden (the canvas intercepts the pointer)
 * presses nothing, and the retry cannot press the button twice.
 */
async function clickControl(page: Page, button: Locator): Promise<void> {
  await expect(async () => {
    await revealControls(page);
    await button.click({ timeout: UI_HIDE_DELAY_MS });
  }).toPass({ timeout: 45_000 });
}

/** One UI state change: the controls shown or hidden, with the cursor at that moment. */
interface UiChange {
  at: number;
  hidden: boolean;
  cursor: string;
}

interface UiLog {
  /** performance.now() of each input event that shows the UI. */
  inputs: number[];
  changes: UiChange[];
  /** For each pointerdown, whether the controls were hidden when it started. */
  downsOnHidden: boolean[];
}

declare global {
  interface Window {
    __uiLog?: UiLog;
  }
}

/**
 * Records, in the page, when input arrives and when the controls show or hide. Timing the hide in
 * the page measures the real delay, unaffected by how slowly Playwright's steps run.
 */
function recordUi(page: Page): Promise<void> {
  return page.evaluate(() => {
    const controls = document.querySelector('.controls')!;
    const log: UiLog = { inputs: [], changes: [], downsOnHidden: [] };
    window.__uiLog = log;
    // The same events as ACTIVITY_EVENTS in src/ui/controls.ts. Capture listeners on window run
    // before the app's own listeners, so each timestamp is no later than the show it causes.
    for (const type of ['mousemove', 'mousedown', 'touchstart', 'keydown']) {
      window.addEventListener(type, () => log.inputs.push(performance.now()), { capture: true, passive: true });
    }
    // Pointer events fire before touchstart / mousedown, so this sees the state before the tap.
    window.addEventListener(
      'pointerdown',
      () => log.downsOnHidden.push(controls.classList.contains('is-hidden')),
      { capture: true, passive: true },
    );
    new MutationObserver(() => {
      const hidden = controls.classList.contains('is-hidden');
      if (log.changes.at(-1)?.hidden === hidden) return;
      log.changes.push({ at: performance.now(), hidden, cursor: getComputedStyle(document.body).cursor });
    }).observe(controls, { attributes: true, attributeFilter: ['class'] });
  });
}

function uiLog(page: Page): Promise<UiLog> {
  return page.evaluate(() => window.__uiLog!);
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
  const controls = page.getByRole('group', { name: 'Controls' });

  // Shown on load, then hidden once the delay passes with no input.
  await expect(controls).toBeHidden({ timeout: 15_000 });
  expect(await bodyCursor(page)).toBe('none');

  await recordUi(page);
  await revealControls(page);

  // Gone by about 3 s (2.5 s plus the fade).
  await expect(controls).toBeHidden({ timeout: 10_000 });
  expect(await bodyCursor(page)).toBe('none');

  // Timed in the page: shown with the cursor on input, and hidden with it no sooner than the real
  // delay after the last input.
  const log = await uiLog(page);
  const lastInput = Math.max(...log.inputs);
  const hide = log.changes.at(-1)!;
  expect(hide.hidden).toBe(true);
  expect(hide.cursor).toBe('none');
  expect(hide.at - lastInput).toBeGreaterThanOrEqual(UI_HIDE_DELAY_MS);
  const show = log.changes.at(-2)!;
  expect(show.hidden).toBe(false);
  expect(show.cursor).not.toBe('none');
  expect(errors).toEqual([]);
});

test('the buttons pause, resume and cycle the speed', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const controls = page.getByRole('group', { name: 'Controls' });

  await clickControl(page, controls.getByRole('button', { name: 'Pause' }));
  expect((await snapshot(page)).paused).toBe(true);
  await clickControl(page, controls.getByRole('button', { name: 'Resume' }));
  expect((await snapshot(page)).paused).toBe(false);

  const before = (await snapshot(page)).speed;
  const speedButton = controls.getByRole('button', { name: /^Speed/ });
  await clickControl(page, speedButton);
  expect((await snapshot(page)).speed).toBe(before + 1);

  // The clicked button keeps focus; Space must still mean pause, not a second click on it. If the
  // UI hid since the click, it was inert and lost focus, so show it and focus the button again.
  await expect(async () => {
    await revealControls(page);
    if (!(await speedButton.evaluate((el) => el === document.activeElement))) await speedButton.focus();
    await expect(speedButton).toBeFocused({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press('Space');
  const after = await snapshot(page);
  expect(after.paused).toBe(true);
  expect(after.speed).toBe(before + 1);
  expect(errors).toEqual([]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a tap on a hidden button only reveals the UI; a tap on a visible one presses it', async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await recordUi(page);
    const controls = page.getByRole('group', { name: 'Controls' });
    await expect(controls).toBeHidden({ timeout: 15_000 });

    // The hidden button still has its layout box, so tap where it sits.
    const box = await page.locator('.controls__pause').boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    /** Taps the button's spot; returns whether the UI was hidden when the tap started. */
    async function tap(): Promise<boolean> {
      await page.touchscreen.tap(x, y);
      return (await uiLog(page)).downsOnHidden.at(-1)!;
    }

    // Checked in the page log rather than with toBeVisible, which under load could run after the
    // UI has hidden again.
    const changesBefore = (await uiLog(page)).changes.length;
    expect(await tap()).toBe(true);
    expect((await snapshot(page)).paused).toBe(false);
    expect((await uiLog(page)).changes[changesBefore]?.hidden).toBe(false);

    // Now visible, the same tap presses the button. Under load the UI can hide again before the tap
    // lands; that tap must again only reveal it, so then tap once more.
    for (let attempt = 1; ; attempt++) {
      const startedHidden = await tap();
      const { paused } = await snapshot(page);
      if (!startedHidden) {
        expect(paused).toBe(true);
        break;
      }
      expect(paused).toBe(false);
      expect(attempt).toBeLessThan(5);
    }
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a tap elsewhere on the hidden UI just reveals it', async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await recordUi(page);
    const controls = page.getByRole('group', { name: 'Controls' });
    await expect(controls).toBeHidden({ timeout: 15_000 });

    // Revealed: checked in the page log, as above.
    const changesBefore = (await uiLog(page)).changes.length;
    await page.touchscreen.tap(50, 50);
    expect((await uiLog(page)).changes[changesBefore]?.hidden).toBe(false);
    const after = await snapshot(page);
    expect(after.paused).toBe(false);
    expect(after.speed).toBe(SHIP_DEFAULT_SPEED_LEVEL);
    expect(errors).toEqual([]);
  });
});
