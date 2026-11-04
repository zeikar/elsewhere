import './style.css';

// Placeholder bootstrap: a full-viewport black page with a single canvas.
// The engine (renderer, frame loop) attaches to this canvas in a later step.
const canvas = document.createElement('canvas');
canvas.id = 'scene';
canvas.setAttribute('aria-label', 'Starfield');
document.body.append(canvas);
