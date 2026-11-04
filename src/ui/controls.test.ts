// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHIP_SPEED_LEVELS, UI_HIDE_DELAY_MS } from '../config';
import { createControls, type Controls, type ControlsEngine } from './controls';

const LEVELS = SHIP_SPEED_LEVELS.length;

function mockEngine(initialSpeed = 1) {
  let paused = false;
  let speed = initialSpeed;
  return {
    pause: vi.fn(() => {
      paused = true;
    }),
    resume: vi.fn(() => {
      paused = false;
    }),
    isPaused: vi.fn(() => paused),
    setSpeed: vi.fn((level: number) => {
      speed = Math.min(LEVELS - 1, Math.max(0, level));
    }),
    getSpeed: vi.fn(() => speed),
    getSpeedLevelCount: vi.fn(() => LEVELS),
  } satisfies ControlsEngine;
}

/** Stubs (or removes, with `enabled: undefined`) the Fullscreen API on the document. */
function stubFullscreen(enabled: boolean | undefined) {
  let current: Element | null = null;
  const request = vi.fn(() => {
    current = document.documentElement;
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    current = null;
    return Promise.resolve();
  });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => enabled });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
  Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, get: () => undefined });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: enabled === undefined ? undefined : exit,
  });
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: enabled === undefined ? undefined : request,
  });
  return { request, exit };
}

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

function button(name: 'pause' | 'fullscreen' | 'speed'): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.controls__${name}`)!;
}

let controls: Controls | undefined;

function setup(engine: ControlsEngine): Controls {
  controls = createControls(engine);
  return controls;
}

beforeEach(() => {
  vi.useFakeTimers();
  stubFullscreen(true);
});

afterEach(() => {
  controls?.dispose();
  controls = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('auto-hide', () => {
  it('shows on mousemove, hides after the delay, and hides the cursor exactly while hidden', () => {
    const c = setup(mockEngine());
    const root = document.body;

    // Shown briefly on load.
    expect(c.isVisible()).toBe(true);
    expect(root.style.cursor).not.toBe('none');
    vi.advanceTimersByTime(UI_HIDE_DELAY_MS);
    expect(c.isVisible()).toBe(false);
    expect(root.style.cursor).toBe('none');
    expect(c.element.classList.contains('is-hidden')).toBe(true);
    expect(c.element.hasAttribute('inert')).toBe(true);

    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(c.isVisible()).toBe(true);
    expect(root.style.cursor).not.toBe('none');
    expect(c.element.classList.contains('is-hidden')).toBe(false);
    expect(c.element.hasAttribute('inert')).toBe(false);

    vi.advanceTimersByTime(UI_HIDE_DELAY_MS - 1);
    expect(c.isVisible()).toBe(true);
    expect(root.style.cursor).not.toBe('none');
    vi.advanceTimersByTime(1);
    expect(c.isVisible()).toBe(false);
    expect(root.style.cursor).toBe('none');
  });

  it('further input restarts the hide timer', () => {
    const c = setup(mockEngine());
    vi.advanceTimersByTime(UI_HIDE_DELAY_MS - 500);
    window.dispatchEvent(new MouseEvent('mousemove'));
    vi.advanceTimersByTime(UI_HIDE_DELAY_MS - 1);
    expect(c.isVisible()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(c.isVisible()).toBe(false);
  });

  it('a keydown or a touchstart shows it again', () => {
    const c = setup(mockEngine());
    vi.advanceTimersByTime(UI_HIDE_DELAY_MS);
    expect(c.isVisible()).toBe(false);

    key('a');
    expect(c.isVisible()).toBe(true);
    expect(document.body.style.cursor).not.toBe('none');

    vi.advanceTimersByTime(UI_HIDE_DELAY_MS);
    expect(c.isVisible()).toBe(false);

    document.body.dispatchEvent(new Event('touchstart', { bubbles: true }));
    expect(c.isVisible()).toBe(true);
    expect(document.body.style.cursor).not.toBe('none');
  });

  it('dispose removes the UI, its listeners and the cursor override', () => {
    const engine = mockEngine();
    const c = setup(engine);
    vi.advanceTimersByTime(UI_HIDE_DELAY_MS);
    c.dispose();
    controls = undefined;
    expect(document.querySelector('.controls')).toBeNull();
    expect(document.body.style.cursor).toBe('');
    key(' ');
    expect(engine.pause).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('keyboard', () => {
  it('Space calls pause() and resume() alternately', () => {
    const engine = mockEngine();
    setup(engine);
    const first = key(' ');
    expect(first.defaultPrevented).toBe(true);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(engine.resume).not.toHaveBeenCalled();
    expect(button('pause').textContent).toBe('Resume');

    key(' ');
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(button('pause').textContent).toBe('Pause');

    key(' ');
    expect(engine.pause).toHaveBeenCalledTimes(2);
  });

  it('ignores auto-repeated Space', () => {
    const engine = mockEngine();
    setup(engine);
    key(' ');
    key(' ', { repeat: true });
    key(' ', { repeat: true });
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(engine.resume).not.toHaveBeenCalled();
  });

  it('Up/Down step to the next/previous level and clamp at the ends', () => {
    const engine = mockEngine(1);
    setup(engine);

    key('ArrowUp');
    expect(engine.setSpeed).toHaveBeenLastCalledWith(2);
    for (let i = 0; i < LEVELS + 2; i++) key('ArrowUp');
    expect(engine.getSpeed()).toBe(LEVELS - 1);
    for (const [level] of engine.setSpeed.mock.calls) expect(level).toBeLessThanOrEqual(LEVELS - 1);

    engine.setSpeed.mockClear();
    key('ArrowDown');
    expect(engine.setSpeed).toHaveBeenLastCalledWith(LEVELS - 2);
    for (let i = 0; i < LEVELS + 2; i++) key('ArrowDown');
    expect(engine.getSpeed()).toBe(0);
    for (const [level] of engine.setSpeed.mock.calls) expect(level).toBeGreaterThanOrEqual(0);
    expect(button('speed').getAttribute('aria-label')).toBe(`Speed 1 of ${LEVELS}`);
  });

  it('F toggles fullscreen (either case)', async () => {
    const fs = stubFullscreen(true);
    setup(mockEngine());
    key('f');
    expect(fs.request).toHaveBeenCalledTimes(1);
    expect(fs.exit).not.toHaveBeenCalled();
    key('F', { code: 'KeyF' });
    expect(fs.exit).toHaveBeenCalledTimes(1);
  });

  it('ignores keys with modifiers so browser shortcuts still work', () => {
    const fs = stubFullscreen(true);
    const engine = mockEngine();
    setup(engine);
    const events = [
      key('f', { ctrlKey: true }),
      key('f', { metaKey: true }),
      key('f', { altKey: true }),
      key('F', { shiftKey: true }),
      key(' ', { ctrlKey: true }),
      key(' ', { metaKey: true }),
      key('ArrowUp', { metaKey: true }),
      key('ArrowDown', { altKey: true }),
      key('ArrowUp', { ctrlKey: true }),
    ];
    expect(fs.request).not.toHaveBeenCalled();
    expect(engine.pause).not.toHaveBeenCalled();
    expect(engine.setSpeed).not.toHaveBeenCalled();
    for (const event of events) expect(event.defaultPrevented).toBe(false);
  });

  it('ignores unrelated keys', () => {
    const engine = mockEngine();
    setup(engine);
    const event = key('Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(engine.pause).not.toHaveBeenCalled();
    expect(engine.setSpeed).not.toHaveBeenCalled();
  });
});

describe('buttons', () => {
  it('Pause/Resume toggles and relabels', () => {
    const engine = mockEngine();
    setup(engine);
    expect(button('pause').textContent).toBe('Pause');
    button('pause').click();
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(button('pause').textContent).toBe('Resume');
    button('pause').click();
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(button('pause').textContent).toBe('Pause');
  });

  it('Speed cycles through the levels, wrapping from the fastest to the slowest', () => {
    const engine = mockEngine(0);
    setup(engine);
    const seen: number[] = [];
    for (let i = 0; i < LEVELS; i++) {
      button('speed').click();
      seen.push(engine.setSpeed.mock.lastCall![0]);
    }
    expect(seen).toEqual([...Array.from({ length: LEVELS - 1 }, (_, i) => i + 1), 0]);
  });

  it('Speed shows one pip per level, lit up to the current level', () => {
    setup(mockEngine(1));
    const pips = Array.from(document.querySelectorAll('.controls__pips i'));
    expect(pips).toHaveLength(LEVELS);
    expect(pips.map((pip) => pip.classList.contains('is-on'))).toEqual(
      Array.from({ length: LEVELS }, (_, i) => i <= 1),
    );
  });

  it('Fullscreen requests and exits fullscreen', () => {
    const fs = stubFullscreen(true);
    setup(mockEngine());
    expect(button('fullscreen').hidden).toBe(false);
    button('fullscreen').click();
    expect(fs.request).toHaveBeenCalledTimes(1);
    button('fullscreen').click();
    expect(fs.exit).toHaveBeenCalledTimes(1);
  });

  it('a failed fullscreen request is logged, not thrown', async () => {
    const fs = stubFullscreen(true);
    fs.request.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setup(mockEngine());
    expect(() => button('fullscreen').click()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});

describe('without the Fullscreen API', () => {
  for (const enabled of [undefined, false]) {
    it(`hides the button and makes F a no-op when fullscreenEnabled is ${enabled}`, () => {
      const fs = stubFullscreen(enabled);
      const engine = mockEngine();
      setup(engine);
      expect(button('fullscreen').hidden).toBe(true);
      expect(() => key('f')).not.toThrow();
      expect(fs.request).not.toHaveBeenCalled();
      expect(engine.pause).not.toHaveBeenCalled();
    });
  }

  it('uses the webkit-prefixed API where only that exists', () => {
    stubFullscreen(undefined);
    const request = vi.fn();
    Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, get: () => true });
    Object.defineProperty(document.documentElement, 'webkitRequestFullscreen', { configurable: true, value: request });
    setup(mockEngine());
    expect(button('fullscreen').hidden).toBe(false);
    key('f');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
