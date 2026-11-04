import './style.css';
import { Engine } from './engine/Engine';
import { installE2EHook } from './e2eHook';
import { createControls } from './ui/controls';

// Bootstrap: a full-viewport canvas driven by the engine, plus the controls UI. Travel starts on load.
const canvas = document.createElement('canvas');
canvas.id = 'scene';
canvas.setAttribute('aria-label', 'Starfield');
document.body.append(canvas);

const engine = new Engine(canvas);
engine.start();
createControls(engine);

// Statically replaced by Vite, so production builds drop this branch and the hook module.
if (import.meta.env.MODE === 'e2e') {
  installE2EHook(engine);
}
