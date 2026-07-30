// Minimap : vue d'ensemble + viewport courant, clic pour recentrer.
import { state, effectiveColor } from './state.js?v=ms7chxev';
import { view, centerOn } from './camera.js?v=ms7chxev';
import { hexCorners } from './geom.js?v=ms7chxev';

let canvas, ctx, W, H;

export function init() {
  canvas = document.getElementById('minimap');
  W = canvas.width = 220;
  H = canvas.height = 150;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const recenter = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (clientX - rect.left) / rect.width * W;
    const my = (clientY - rect.top) / rect.height * H;
    const b = bounds();
    const w = b.maxx - b.minx, h = b.maxy - b.miny;
    centerOn(b.minx + (mx / W) * w, b.miny + (my / H) * h);
  };
  canvas.addEventListener('mousedown', (e) => { recenter(e.clientX, e.clientY); e.stopPropagation(); });
  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t) recenter(t.clientX, t.clientY);
    e.stopPropagation();
    e.preventDefault();
  }, { passive: false });
}

// Bounding box monde de tout le contenu (+ padding), avec garde-fous.
function bounds() {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const push = (x, y) => {
    if (x < minx) minx = x; if (y < miny) miny = y;
    if (x > maxx) maxx = x; if (y > maxy) maxy = y;
  };
  for (const n of state.nodes) { push(n.x, n.y); push(n.x + n.w, n.y + n.h); }
  for (const c of state.circles) { push(c.x - c.r, c.y - c.r); push(c.x + c.r, c.y + c.r); }
  for (const h of state.hexagons) { push(h.x - h.r, h.y - h.r); push(h.x + h.r, h.y + h.r); }
  // Includes the camera so it stays locatable even with no content.
  push(state.camera.x, state.camera.y);
  if (!isFinite(minx)) { minx = -200; miny = -200; maxx = 200; maxy = 200; }
  const pad = Math.max((maxx - minx), (maxy - miny)) * 0.15 + 60;
  return { minx: minx - pad, miny: miny - pad, maxx: maxx + pad, maxy: maxy + pad };
}

export function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const b = bounds();
  const w = b.maxx - b.minx, h = b.maxy - b.miny;
  const sx = W / w, sy = H / h;
  const X = (wx) => (wx - b.minx) * sx;
  const Y = (wy) => (wy - b.miny) * sy;

  // Cercles.
  for (const c of state.circles) {
    ctx.beginPath();
    ctx.arc(X(c.x), Y(c.y), Math.max(2, c.r * sx), 0, Math.PI * 2);
    ctx.strokeStyle = c.color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Hexagones.
  for (const h of state.hexagons) {
    const pts = hexCorners(X(h.x), Y(h.y), Math.max(2, h.r * sx));
    ctx.beginPath();
    pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.strokeStyle = h.color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Rectangles (couleur effective = celle de leur cercle/hexagone englobant).
  for (const n of state.nodes) {
    ctx.fillStyle = effectiveColor(n);
    ctx.fillRect(X(n.x), Y(n.y), Math.max(2, n.w * sx), Math.max(2, n.h * sy));
  }

  // Viewport courant.
  const z = state.camera.zoom;
  const vw = view.w / z, vh = view.h / z;
  const vx = state.camera.x - vw / 2, vy = state.camera.y - vh / 2;
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1;
  ctx.strokeRect(X(vx), Y(vy), vw * sx, vh * sy);
  ctx.globalAlpha = 1;
}
