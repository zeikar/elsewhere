/**
 * Controls UI (docs/PLAN.md section 7): Pause/Resume, Fullscreen and Speed buttons, keyboard
 * shortcuts, and auto-hide of the UI and the cursor. Plain DOM; the styles live in style.css.
 *
 * The UI talks to the engine only through the small public API in `ControlsEngine`.
 */
import { UI_HIDE_DELAY_MS } from '../config';

/** The part of the engine's public API the controls use. */
export interface ControlsEngine {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /** Speed level, an index into the discrete speed levels (the engine clamps). */
  setSpeed(level: number): void;
  getSpeed(): number;
  getSpeedLevelCount(): number;
}

export interface ControlsOptions {
  /** Element the controls are appended to; its cursor is hidden along with the UI. Default: document.body. */
  root?: HTMLElement;
  /** Delay before the UI and cursor hide with no input, in milliseconds. */
  hideDelayMs?: number;
}

export interface Controls {
  readonly element: HTMLElement;
  isVisible(): boolean;
  dispose(): void;
}

/** Vendor-prefixed Fullscreen API (Safari on iPad and older WebKit). */
interface WebkitDocument {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface WebkitElement {
  webkitRequestFullscreen?: () => void;
}

const HIDDEN_CLASS = 'is-hidden';
/** Events that count as input and show the UI. */
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'touchstart', 'keydown'] as const;

export function fullscreenSupported(doc: Document): boolean {
  return doc.fullscreenEnabled === true || (doc as WebkitDocument).webkitFullscreenEnabled === true;
}

function fullscreenElement(doc: Document): Element | null {
  return doc.fullscreenElement ?? (doc as WebkitDocument).webkitFullscreenElement ?? null;
}

function makeButton(doc: Document, name: string, title: string, shortcut: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `controls__button controls__${name}`;
  button.title = title;
  button.setAttribute('aria-keyshortcuts', shortcut);
  return button;
}

export function createControls(engine: ControlsEngine, options: ControlsOptions = {}): Controls {
  const root = options.root ?? document.body;
  const hideDelayMs = options.hideDelayMs ?? UI_HIDE_DELAY_MS;
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;

  const element = doc.createElement('div');
  element.className = 'controls';
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', 'Controls');

  const pauseButton = makeButton(doc, 'pause', 'Pause or resume (Space)', 'Space');
  const fullscreenButton = makeButton(doc, 'fullscreen', 'Fullscreen (F)', 'F');
  const speedButton = makeButton(doc, 'speed', 'Speed (Up / Down arrows)', 'ArrowUp ArrowDown');
  const speedLabel = doc.createElement('span');
  speedLabel.textContent = 'Speed';
  const speedPips = doc.createElement('span');
  speedPips.className = 'controls__pips';
  speedPips.setAttribute('aria-hidden', 'true');
  speedButton.append(speedLabel, speedPips);

  const canFullscreen = fullscreenSupported(doc);
  fullscreenButton.hidden = !canFullscreen;
  element.append(pauseButton, fullscreenButton, speedButton);
  root.append(element);

  let visible = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function render(): void {
    pauseButton.textContent = engine.isPaused() ? 'Resume' : 'Pause';
    fullscreenButton.textContent = fullscreenElement(doc) ? 'Exit fullscreen' : 'Fullscreen';
    const count = engine.getSpeedLevelCount();
    const level = engine.getSpeed();
    if (speedPips.childElementCount !== count) {
      speedPips.replaceChildren(...Array.from({ length: count }, () => doc.createElement('i')));
    }
    Array.from(speedPips.children).forEach((pip, i) => pip.classList.toggle('is-on', i <= level));
    speedButton.setAttribute('aria-label', `Speed ${level + 1} of ${count}`);
  }

  function setVisible(next: boolean): void {
    visible = next;
    element.classList.toggle(HIDDEN_CLASS, !next);
    // Hidden controls can be neither focused nor clicked, so a tap on a hidden UI only reveals it.
    element.toggleAttribute('inert', !next);
    root.style.cursor = next ? '' : 'none';
  }

  function hide(): void {
    hideTimer = undefined;
    setVisible(false);
  }

  function show(): void {
    if (!visible) {
      render();
      setVisible(true);
    }
    if (hideTimer !== undefined) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, hideDelayMs);
  }

  function togglePause(): void {
    if (engine.isPaused()) engine.resume();
    else engine.pause();
    render();
  }

  function stepSpeed(delta: number): void {
    const max = engine.getSpeedLevelCount() - 1;
    const next = Math.min(max, Math.max(0, engine.getSpeed() + delta));
    if (next !== engine.getSpeed()) engine.setSpeed(next);
    render();
  }

  /** The Speed button cycles through the levels, wrapping from the fastest back to the slowest. */
  function cycleSpeed(): void {
    const count = engine.getSpeedLevelCount();
    engine.setSpeed((engine.getSpeed() + 1) % count);
    render();
  }

  function toggleFullscreen(): void {
    if (!canFullscreen) return;
    const webkitDoc = doc as WebkitDocument;
    try {
      if (fullscreenElement(doc)) {
        if (doc.exitFullscreen) void doc.exitFullscreen().catch(logFullscreenError);
        else webkitDoc.webkitExitFullscreen?.();
      } else {
        const target = doc.documentElement;
        if (target.requestFullscreen) void target.requestFullscreen().catch(logFullscreenError);
        else (target as WebkitElement).webkitRequestFullscreen?.();
      }
    } catch (err) {
      logFullscreenError(err);
    }
  }

  function logFullscreenError(err: unknown): void {
    console.warn('Fullscreen request failed:', err);
  }

  const onActivity = (): void => show();

  const onKeyDown = (event: KeyboardEvent): void => {
    // Leave browser and OS shortcuts (Ctrl/Cmd+F, Alt+Arrow, …) alone.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.code === 'Space' || event.key === ' ') {
      // Also stops a focused button from treating Space as a click, so Space always means pause.
      event.preventDefault();
      if (!event.repeat) togglePause();
    } else if (event.key === 'f' || event.key === 'F' || event.code === 'KeyF') {
      event.preventDefault();
      if (!event.repeat) toggleFullscreen();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      stepSpeed(1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      stepSpeed(-1);
    }
  };

  // A focused button would otherwise fire its click on Space keyup.
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space' || event.key === ' ') event.preventDefault();
  };

  const onPauseClick = (): void => togglePause();
  const onFullscreenClick = (): void => toggleFullscreen();
  const onSpeedClick = (): void => cycleSpeed();
  const onFullscreenChange = (): void => render();

  pauseButton.addEventListener('click', onPauseClick);
  fullscreenButton.addEventListener('click', onFullscreenClick);
  speedButton.addEventListener('click', onSpeedClick);
  for (const type of ACTIVITY_EVENTS) win.addEventListener(type, onActivity, { passive: true });
  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  doc.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // Show the controls briefly on load so they can be found, then let them fade.
  show();

  return {
    element,
    isVisible: () => visible,
    dispose() {
      if (hideTimer !== undefined) clearTimeout(hideTimer);
      hideTimer = undefined;
      pauseButton.removeEventListener('click', onPauseClick);
      fullscreenButton.removeEventListener('click', onFullscreenClick);
      speedButton.removeEventListener('click', onSpeedClick);
      for (const type of ACTIVITY_EVENTS) win.removeEventListener(type, onActivity);
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      doc.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      root.style.cursor = '';
      element.remove();
    },
  };
}
