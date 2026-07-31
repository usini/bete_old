// Debug panel for tweaking wobble physics parameters.
// Panel is hidden by default and can be toggled with the '²' key.
import { wobbleCfg, WOBBLE_DEFAULTS } from './physics.js?v=ms954yha';
import { t } from './i18n.js?v=ms954yha';

let panel = null;

// Wobble physics parameters that can be adjusted in the debug panel.
function fields() {
  return [
    { key: 'stiffness', label: t('debug.stiffness'), min: 20, max: 400, step: 1 },
    { key: 'damping', label: t('debug.damping'), min: 1, max: 40, step: 0.5 },
    { key: 'maxStretch', label: t('debug.maxStretch'), min: 0, max: 0.4, step: 0.01 },
    { key: 'stretchK', label: t('debug.stretchK'), min: 0, max: 0.004, step: 0.0001 },
  ];
}

// Create a row in the debug panel for a given wobble parameter.
function row(f) {
  const wrap = document.createElement('div');
  wrap.className = 'dbg-row';
  const lab = document.createElement('label');
  lab.textContent = f.label;
  const val = document.createElement('span');
  val.className = 'dbg-val';
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = f.min; inp.max = f.max; inp.step = f.step;
  inp.value = wobbleCfg[f.key];
  const show = () => { val.textContent = String(wobbleCfg[f.key]); };
  show();
  inp.addEventListener('input', () => { wobbleCfg[f.key] = parseFloat(inp.value); show(); });
  inp._sync = () => { inp.value = wobbleCfg[f.key]; show(); };
  wrap.appendChild(lab);
  wrap.appendChild(inp);
  wrap.appendChild(val);
  return wrap;
}

// Build the debug panel and append it to the document body.
function build() {
  panel = document.createElement('div');
  panel.id = 'debug';
  const head = document.createElement('div');
  head.className = 'dbg-head';
  head.textContent = t('debug.header');
  panel.appendChild(head);
  const rows = fields().map(row);
  rows.forEach((r) => panel.appendChild(r));
  const reset = document.createElement('button');
  reset.className = 'dbg-reset';
  reset.textContent = t('debug.reset');
  reset.addEventListener('click', () => {
    Object.assign(wobbleCfg, WOBBLE_DEFAULTS);
    rows.forEach((r) => r.querySelector('input')._sync());
  });
  panel.appendChild(reset);
  // Prevents clicks from falling through to the canvas.
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(panel);
}

// Toggle the visibility of the debug panel.
export function toggleDebug() {
  if (!panel) build();
  panel.classList.toggle('show');
}
