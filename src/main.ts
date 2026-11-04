import './style.css';
import { initialSpeedSettings } from './config';
import { Engine } from './engine/Engine';
import { installE2EHook } from './e2eHook';
import { createControls } from './ui/controls';
import { createWakeLock } from './ui/wakeLock';

// Bootstrap: a full-viewport canvas driven by the engine, plus the controls UI. Travel starts on load.
const canvas = document.createElement('canvas');
canvas.id = 'scene';
canvas.setAttribute('aria-label', 'Starfield');
document.body.append(canvas);

// Reduced motion: start slower, with shorter streaks (the user can still raise the speed).
const prefersReducedMotion =
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const engine = new Engine(canvas, initialSpeedSettings(prefersReducedMotion));
engine.start();
createControls(engine);

// Keep the screen on while travelling; released on pause, requested again on resume.
const wakeLock = createWakeLock();
engine.onPausedChange((paused) => wakeLock.setActive(!paused));
wakeLock.setActive(!engine.isPaused());

// Statically replaced by Vite, so production builds drop this branch and the hook module.
if (import.meta.env.MODE === 'e2e') {
  installE2EHook(engine);
}
