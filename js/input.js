// Mouse + touch input, elastic drag, hexagon links, radial menu,
// palette, text editing, image popup.
import {
  state, addRect, addCircle, addHexagon, addConnector, removeById, scheduleSave, COLORS, BUTTON_COLORS,
  findById, newId, sourceOf, displayImage, displayLink, displayText, getBoardId, undo,
} from './state.js?v=ms954yha';
import { screenToWorld, worldToScreen, zoomAt, panBy } from './camera.js?v=ms954yha';
import { dragTo, reset } from './physics.js?v=ms954yha';
import { pointInHex } from './geom.js?v=ms954yha';
import { pollConnector, stopPolling, toggleSwitch, applyConnectorProgram, refreshConnector, toggleStopwatch, resetStopwatch, setCountdownTarget } from './connector.js?v=ms954yha';
import { startHost, adoptHost, detachHost, refreshHostId, pushMove, pushDelete, isClient, isOwner, hostId, buildUrl, loadQR, reportCursor, shareImage, requestSwitchToggle } from './sync.js?v=ms954yha';
import { getUserId } from './users.js?v=ms954yha';
import { storeImage, resolveSrc, inlineImages, dataUrlToBlob, blobToDataUrl } from './images.js?v=ms954yha';
import { getAudio, putAudio } from './audio.js?v=ms954yha';
import { toast } from './main.js?v=ms954yha';
import { explodeElementCascade } from './fx.js?v=ms954yha';
import { genBoardId, listBoards, buildBoardUrl, recordBoard, rewriteLinksForBoard, parseBoardUrl, reservedBoardLabel, deleteBoardData } from './boards.js?v=ms954yha';
import { listLiaisons, removeLiaison } from './liaisons.js?v=ms954yha';
import { openSettings } from './settings.js?v=ms954yha';
import { recordVoiceMemo, toggleVoice, removeVoiceAudio } from './voice.js?v=ms954yha';
import { toggleDebug } from './debug.js?v=ms954yha';
import { youTubeId } from './yt.js?v=ms954yha';
import { setActiveVideo } from './video.js?v=ms954yha';
import { t } from './i18n.js?v=ms954yha';
import { openExternal } from './platform.js?v=ms954yha';
import { isIcsUrl } from './ics.js?v=ms954yha';

let canvas;
let drag = null;        // { mode, id, offx, offy, startX, startY }
let lastPos = { x: 0, y: 0, t: 0 };
let editing = null;     // { type, id }
let onChange = () => {};
let clipboard = null;   // { items: [{ isCircle?, isHex?, data }] } -- persisted to localStorage so it survives navigating to another board
const CLIPBOARD_KEY = 'bete:clipboard';
let internalSince = false; // have we copied a block since the last pasted image?
let lastImgSig = '';       // signature of the last system image pasted
let lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

// Pointer state (mouse or touch) for drag, pinch, long-press, etc.
let pinch = null;
let longPressTimer = null;
let lastTap = 0;
let lastTapPos = null;

// Touch mode: on mobile, interaction is disabled by default (you can only navigate: pan/zoom) to avoid accidentally moving blocks.
const isCoarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
let interactionEnabled = !isCoarse;

// Read-only board: true only for a connected GUEST (never for the host/owner,
// never for someone editing locally outside of a liaison). Enforced for real
// on the host side (sync.js ignores/never relays a guest's edits) -- this is
// just the matching read-only UI/UX on the guest's screen.
function isLocked() { return state.readOnly === true && isClient() && !isOwner(); }
function canInteract() { return interactionEnabled && !isLocked(); }

// Update the hint text based on the current interaction mode.
export function updateHint() {
  const h = document.getElementById('hint');
  if (!h) return;
  if (isLocked()) { h.textContent = t('hint.readOnly'); return; }
  if (!isCoarse) return;
  h.textContent = interactionEnabled ? t('hint.active') : t('hint.locked');
}

const RESIZE_TOL = 12;  // tolerance (px screen) for grabbing the edge of a zone

// ---- Radial Menu: colors + SVG icons (viewBox 0 0 24 24) ----
const COL = {
  green: '#39ff14', wood: '#b9772e', cyan: '#00b7eb', orange: '#ff8c00',
  magenta: '#e3008c', purple: '#9b30ff', yellow: '#ffd400', white: '#f2f2f2', red: '#fe4365',
};
const ICONS = {
  rect: '<rect x="3.5" y="6.5" width="17" height="11" rx="1.5"/>',
  pancarte: '<rect x="4" y="5" width="16" height="10" rx="1.5"/><line x1="12" y1="15" x2="12" y2="21"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  hexa: '<polygon points="12,3.2 19.5,7.6 19.5,16.4 12,20.8 4.5,16.4 4.5,7.6"/>',
  share: '<circle cx="6" cy="12" r="2.3"/><circle cx="18" cy="6" r="2.3"/><circle cx="18" cy="18" r="2.3"/><line x1="8" y1="11" x2="16" y2="7"/><line x1="8" y1="13" x2="16" y2="17"/>',
  export: '<line x1="12" y1="3" x2="12" y2="15"/><polyline points="7,10 12,15 17,10"/><line x1="4" y1="20" x2="20" y2="20"/>',
  import: '<line x1="12" y1="16" x2="12" y2="4"/><polyline points="7,9 12,4 17,9"/><line x1="4" y1="20" x2="20" y2="20"/>',
  edit: '<path d="M14.5 5.5l4 4"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>',
  text: '<line x1="5" y1="5" x2="19" y2="5"/><line x1="12" y1="5" x2="12" y2="20"/>',
  color: '<path d="M12 3C12 3 5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12z"/>',
  link: '<path d="M14 4h6v6"/><line x1="20" y1="4" x2="10" y2="14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  eye: '<path d="M2.5 12C5.5 6.5 18.5 6.5 21.5 12C18.5 17.5 5.5 17.5 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<line x1="4" y1="7" x2="20" y2="7"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 16V4h12"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 13.7-5.7M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.7M4 20v-4h4"/>',
  imgx: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><line x1="3" y1="3" x2="21" y2="21"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  board: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M14 4h6v6"/><line x1="20" y1="4" x2="13" y2="11"/>',
  select: '<rect x="3.5" y="3.5" width="17" height="17" rx="1" stroke-dasharray="3 3"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="17.5" x2="12" y2="21"/><line x1="8.5" y1="21" x2="15.5" y2="21"/>',
  undo: '<path d="M9 7H16a4 4 0 0 1 0 8h-4"/><polyline points="9,3 5,7 9,11"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5.5-5.5a1 1 0 0 0-1.4 0L9 15.5"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="14" r="3.5"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  triangle: '<polygon points="12,4 20,19 4,19"/>',
  power: '<line x1="12" y1="3" x2="12" y2="11"/><path d="M7 6a7 7 0 1 0 10 0"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.7-8.94 5.5 5.5 0 0 1 10.7 1.2A4 4 0 0 1 17 18H7z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/>',
};
let pendingBoardPos = null; // position where a new board will be created (if not null, a new board will be created on the next click)
let pendingBoardTarget = null; // target board to link to when creating a new board (if not null, a new board will be created on the next click and linked to this target)
let pendingImagePos = null;    // world position for a new image rectangle (file/camera picker)
let pendingImageTarget = null; // existing rectangle to set/replace the image on (file/camera picker)
// Radial menu (long press then drag to choose).
let radialPressActive = false;
let radialItems = [];
let radialHoverIdx = -1;
let radialCx = 0, radialCy = 0;
let radialRay = null, radialHalo = null;
let selectArmed = false; // arm a selection rectangle for the next drag (menu)
function svgEl(key) { return '<svg viewBox="0 0 24 24">' + (ICONS[key] || ICONS.dot) + '</svg>'; }

// ---- Initialization ----
// Set up event listeners for mouse, touch, keyboard, and drag-and-drop interactions on the canvas and window.
export function init(boardCanvas, changeCb) {
  canvas = boardCanvas;
  onChange = changeCb || (() => {});

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousemove', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; const w = screenToWorld(e.clientX, e.clientY); reportCursor(w.x, w.y); });
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('dblclick', (e) => handleDouble(e.clientX, e.clientY));
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextAt(e.clientX, e.clientY); });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('paste', onPaste);

  //  Touch events for mobile devices.
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // Drag-and-drop events for files (images, etc.) onto the canvas.
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); });
  canvas.addEventListener('drop', onDrop);
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  document.getElementById('editor').addEventListener('blur', commitEdit);

  // Button "OK" to validate/close the edit (reliable exit on touch).
  const done = document.getElementById('editDone');
  done.addEventListener('mousedown', (e) => { e.preventDefault(); commitEdit(); });
  done.addEventListener('touchstart', (e) => { e.preventDefault(); commitEdit(); });

  // Closing the image popup.
  const pop = document.getElementById('imgpopup');
  pop.addEventListener('mousedown', closeImagePopup);
  pop.addEventListener('touchstart', (e) => { e.preventDefault(); closeImagePopup(); });

  // The board picker doesn't close when clicking inside it.
  const bp = document.getElementById('boardpicker');
  bp.addEventListener('mousedown', (e) => e.stopPropagation());
  bp.addEventListener('touchstart', (e) => e.stopPropagation());

  // URL bar: clicking it follows the focused link.
  const lb = document.getElementById('linkbar');
  const followBar = (e) => { e.stopPropagation(); e.preventDefault(); if (linkFocus) { const u = linkFocus.url; clearLinkFocus(); followLink(u); } };
  lb.addEventListener('mousedown', followBar);
  lb.addEventListener('touchstart', followBar);

  // Image file picker / camera capture (radial menu > Upload image / Camera).
  const imgFileInput = document.getElementById('imageFileInput');
  if (imgFileInput) imgFileInput.addEventListener('change', () => { const f = imgFileInput.files && imgFileInput.files[0]; imgFileInput.value = ''; handleImageFile(f); });
  const imgCamInput = document.getElementById('imageCameraInput');
  if (imgCamInput) imgCamInput.addEventListener('change', () => { const f = imgCamInput.files && imgCamInput.files[0]; imgCamInput.value = ''; handleImageFile(f); });

  updateHint();
}

// ---- Hit testing (top to bottom) ----
function hitRect(w) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if (w.x >= n.x && w.x <= n.x + n.w && w.y >= n.y && w.y <= n.y + n.h) return n;
  }
  return null;
}

// ---- Hit testing for circles ----
function hitCircle(w) {
  const tol = RESIZE_TOL / state.camera.zoom;
  for (let i = state.circles.length - 1; i >= 0; i--) {
    const c = state.circles[i];
    const d = Math.hypot(w.x - c.x, w.y - c.y);
    if (Math.abs(d - c.r) <= tol) return { c, edge: true };
    if (d < c.r) return { c, edge: false };
  }
  return null;
}

// --- Hit testing for hexagons (pointy-top) ---
function hitHexagon(w) {
  const tol = RESIZE_TOL / state.camera.zoom;
  for (let i = state.hexagons.length - 1; i >= 0; i--) {
    const h = state.hexagons[i];
    if (pointInHex(w.x, w.y, h.x, h.y, h.r + tol)) {
      const edge = !pointInHex(w.x, w.y, h.x, h.y, h.r - tol);
      return { c: h, edge };
    }
  }
  return null;
}

// Hexagon (body) containing a point, topmost first.
function hexagonAt(px, py) {
  for (let i = state.hexagons.length - 1; i >= 0; i--) {
    const h = state.hexagons[i];
    if (pointInHex(px, py, h.x, h.y, h.r)) return h;
  }
  return null;
}

// Bottom-right corner of a rectangle (resize handle).
function nearCorner(w, r) {
  const tol = 14 / state.camera.zoom;
  return Math.abs(w.x - (r.x + r.w)) < tol && Math.abs(w.y - (r.y + r.h)) < tol;
}
function toggleSelect(id) {
  const i = state.selectedIds.indexOf(id);
  if (i === -1) state.selectedIds.push(id); else state.selectedIds.splice(i, 1);
}

// ---- Generic pointer (mouse + touch) ----
function pointerDown(sx, sy, opts) {
  closeMenus();
  const shift = !!(opts && opts.shift);
  // Locked interaction (mobile default, or a read-only guest): only pans.
  // (but a tap on a link is still handled at pointerUp, see finishDrag).
  if (!canInteract()) { drag = { mode: 'pan', px: sx, py: sy, sx0: sx, sy0: sy }; return; }
  const w = screenToWorld(sx, sy);

  const r = hitRect(w);
  if (r) {
    // Resize handle (bottom-right corner) of a non-link rectangle.
    if (!r.ref && r.kind !== 'liaison' && nearCorner(w, r)) {
      state.selected = r.id; state.selectedIds = [];
      drag = { mode: 'rectresize', id: r.id, aspect: r.image ? r.w / r.h : 0 };
      if (canvas) canvas.style.cursor = 'nwse-resize';
      return;
    }
    // Shift+click: adds/removes from the multi-selection.
    if (shift) { toggleSelect(r.id); state.selected = r.id; drag = null; scheduleSave(); return; }
    // Click on a member of a multi-selection: moves the whole group.
    if (state.selectedIds.length > 1 && state.selectedIds.indexOf(r.id) !== -1) {
      state.selected = r.id;
      drag = { mode: 'group', ids: state.selectedIds.slice(), lead: r.id, offx: w.x - r.x, offy: w.y - r.y, orig: {} };
      drag.ids.forEach((id) => { const m = findById(id); if (m) drag.orig[id] = { x: m.x, y: m.y }; });
      lastPos = { x: w.x, y: w.y, t: performance.now() };
      return;
    }
    // Simple selection.
    state.selectedIds = [];
    state.selected = r.id;
    drag = { mode: 'rect', id: r.id, offx: w.x - r.x, offy: w.y - r.y, startX: r.x, startY: r.y };
    lastPos = { x: w.x, y: w.y, t: performance.now() };
    return;
  }

  const hz = hitHexagon(w) || hitCircle(w);
  if (hz) {
    if (!hz.edge) {
      // Shift+click: adds/removes from the multi-selection.
      if (shift) { toggleSelect(hz.c.id); state.selected = hz.c.id; drag = null; scheduleSave(); return; }
      // Click on a member of a multi-selection: moves the whole group.
      if (state.selectedIds.length > 1 && state.selectedIds.indexOf(hz.c.id) !== -1) {
        state.selected = hz.c.id;
        drag = { mode: 'group', ids: state.selectedIds.slice(), lead: hz.c.id, offx: w.x - hz.c.x, offy: w.y - hz.c.y, orig: {} };
        drag.ids.forEach((id) => { const m = findById(id); if (m) drag.orig[id] = { x: m.x, y: m.y }; });
        lastPos = { x: w.x, y: w.y, t: performance.now() };
        return;
      }
    }
    state.selectedIds = [];
    state.selected = hz.c.id;
    drag = hz.edge
      ? { mode: 'resize', id: hz.c.id }
      : { mode: 'zone', id: hz.c.id, offx: w.x - hz.c.x, offy: w.y - hz.c.y };
    return;
  }

  // Background: selection rectangle if Shift (desktop) or armed mode (menu), otherwise pan.
  if (shift || selectArmed) {
    selectArmed = false;
    drag = { mode: 'marquee', x0: sx, y0: sy, x1: sx, y1: sy };
    showMarquee(sx, sy, sx, sy);
    return;
  }
  state.selected = null;
  state.selectedIds = [];
  drag = { mode: 'pan', px: sx, py: sy, sx0: sx, sy0: sy };
}

function pointerMove(sx, sy) {
  if (!drag) return;
  if (drag.mode === 'pan') {
    panBy(sx - drag.px, sy - drag.py);
    drag.px = sx; drag.py = sy;
    return;
  }
  const w = screenToWorld(sx, sy);

  if (drag.mode === 'rect') {
    const n = findById(drag.id);
    if (!n) return;
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastPos.t) / 1000);
    dragTo(n, w.x - drag.offx, w.y - drag.offy, dt);
    lastPos = { x: w.x, y: w.y, t: now };
    scheduleSave();
  } else if (drag.mode === 'zone') {
    const c = findById(drag.id);
    if (!c) return;
    c.x = w.x - drag.offx; c.y = w.y - drag.offy;
    scheduleSave();
  } else if (drag.mode === 'resize') {
    const c = findById(drag.id);
    if (!c) return;
    c.r = Math.max(40, Math.hypot(w.x - c.x, w.y - c.y));
    scheduleSave();
  } else if (drag.mode === 'rectresize') {
    const n = findById(drag.id);
    if (!n) return;
    let nw = Math.max(40, w.x - n.x);
    let nh = Math.max(40, w.y - n.y);
    if (drag.aspect) { if (nw / nh > drag.aspect) nh = nw / drag.aspect; else nw = nh * drag.aspect; } // keeps the image ratio
    n.w = nw; n.h = nh;
    scheduleSave();
  } else if (drag.mode === 'group') {
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastPos.t) / 1000);
    const tx = w.x - drag.offx, ty = w.y - drag.offy;
    const ddx = tx - drag.orig[drag.lead].x, ddy = ty - drag.orig[drag.lead].y;
    drag.ids.forEach((id) => { const m = findById(id); if (m && drag.orig[id]) dragTo(m, drag.orig[id].x + ddx, drag.orig[id].y + ddy, dt); });
    lastPos = { x: w.x, y: w.y, t: now };
    scheduleSave();
  } else if (drag.mode === 'marquee') {
    drag.x1 = sx; drag.y1 = sy;
    showMarquee(drag.x0, drag.y0, sx, sy);
  }
}

function showMarquee(x0, y0, x1, y1) {
  const m = document.getElementById('marquee');
  m.style.left = Math.min(x0, x1) + 'px';
  m.style.top = Math.min(y0, y1) + 'px';
  m.style.width = Math.abs(x1 - x0) + 'px';
  m.style.height = Math.abs(y1 - y0) + 'px';
  m.classList.add('show');
}
function hideMarquee() { document.getElementById('marquee').classList.remove('show'); }

function pointerUp() {
  if (drag) finishDrag();
  drag = null;
  if (canvas) canvas.style.cursor = ''; // the next mousemove recomputes it
}

// Resize cursor (PC) when hovering a resizable edge/corner.
function updateCursor(sx, sy) {
  if (!canvas || !canInteract()) return;
  const w = screenToWorld(sx, sy);
  let resize = false;
  const r = hitRect(w);
  if (r && r.kind !== 'liaison' && !r.ref && nearCorner(w, r)) resize = true;
  else if (!r) { const hz = hitHexagon(w) || hitCircle(w); if (hz && hz.edge) resize = true; }
  canvas.style.cursor = resize ? 'nwse-resize' : '';
}

// Dropping a real rectangle into a hexagon => creates a link, the original goes back.
function finishDrag() {
  if (drag.mode === 'rect') {
    const n = findById(drag.id);
    // Liaison block: a click (negligible movement) copies the link.
    if (n && n.kind === 'liaison') {
      if (Math.hypot(n.x - drag.startX, n.y - drag.startY) < 3 && n.url) copyLink(n);
      scheduleSave();
      return;
    }
    // Voice memo block: a click plays/pauses playback.
    if (n && n.kind === 'voice') {
      if (Math.hypot(n.x - drag.startX, n.y - drag.startY) < 3) toggleVoice(n);
      scheduleSave();
      return;
    }
    // Tap (negligible movement) on a linked node => focus then follow (2-step).
    if (n) {
      const tap = Math.hypot(n.x - drag.startX, n.y - drag.startY) < 3;
      if (tap && !n.ref && youTubeId(n.text)) { setActiveVideo(n); return; } // video block: play
      if (tap && displayLink(n)) { handleLinkTap(n); return; }
      if (tap) clearLinkFocus();
    }
    // "boards" directory board: dropping a board-link block inside a liaison
    // circle (or back outside any circle) re-pairs that board with the
    // circle's peer -- the simplest way to say "open this board through that
    // liaison from now on" without a picker. See main.js: loadBoardsDirectory
    // for how circles/peers are built, and state.js: effectiveColor for the
    // same "last circle containing the center wins" containment rule.
    if (n && n.link && getBoardId() === 'boards') {
      const bu = parseBoardUrl(n.link);
      if (bu) {
        const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
        let newCircle = null;
        for (const c of state.circles) { const dx = cx - c.x, dy = cy - c.y; if (dx * dx + dy * dy <= c.r * c.r) newCircle = c; }
        const newPeer = newCircle ? newCircle.peer : null;
        if ((bu.peer || null) !== (newPeer || null)) {
          recordBoard(bu.id, null, newPeer); // null: keeps whatever name this board already has on file
          n.link = buildBoardUrl(bu.id, newPeer);
          // Propagates to every OTHER saved board's own link blocks pointing
          // at this one (e.g. Home's link to it) -- otherwise only the
          // directory's own display node here would know about the re-pair.
          rewriteLinksForBoard(bu.id, newPeer, 'boards');
          toast(newPeer ? t('boardsView.linked', { name: newCircle.description || newPeer }) : t('boardsView.unlinked'));
        }
      }
    }
    if (n && !n.ref && n.kind !== 'connector') {
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      const hex = hexagonAt(cx, cy);
      if (hex) {
        const startedOutside = !pointInHex(drag.startX + n.w / 2, drag.startY + n.h / 2, hex.x, hex.y, hex.r);
        const dupInHex = state.nodes.some(m =>
          m.ref === n.id && pointInHex(m.x + m.w / 2, m.y + m.h / 2, hex.x, hex.y, hex.r));
        if (startedOutside && !dupInHex) {
          const link = { id: newId(), x: cx - n.w / 2, y: cy - n.h / 2, w: n.w, h: n.h, ref: n.id };
          state.nodes.push(link);
          reset(link);
          n.x = drag.startX; n.y = drag.startY; reset(n);
          state.selected = link.id;
        }
      }
    }
  } else if (drag.mode === 'pan') {
    // Tap on the background: in locked mode (mobile default, or a read-only
    // guest), playback still works -- only actual editing needs "Enable"
    // first. Mirrors the same three cases already allowed unlocked in the
    // 'rect' branch above (voice memo / video / link).
    const moved = Math.hypot((drag.px - drag.sx0), (drag.py - drag.sy0));
    if (moved < 6) {
      const w = screenToWorld(drag.px, drag.py);
      const r = hitRect(w);
      if (r && r.kind === 'voice') { toggleVoice(r); return; }
      if (r && !r.ref && youTubeId(r.text)) { setActiveVideo(r); return; }
      if (r && displayLink(r)) { handleLinkTap(r); return; }
      clearLinkFocus();
    }
  } else if (drag.mode === 'marquee') {
    hideMarquee();
    const a = screenToWorld(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1));
    const b = screenToWorld(Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
    const ids = [];
    for (const nd of state.nodes) {
      if (nd.kind === 'liaison') continue;
      const cx = nd.x + nd.w / 2, cy = nd.y + nd.h / 2;
      if (cx >= a.x && cx <= b.x && cy >= a.y && cy <= b.y) ids.push(nd.id);
    }
    for (const z of state.circles) if (z.x >= a.x && z.x <= b.x && z.y >= a.y && z.y <= b.y) ids.push(z.id);
    for (const z of state.hexagons) if (z.x >= a.x && z.x <= b.x && z.y >= a.y && z.y <= b.y) ids.push(z.id);
    // 0 or 1 block: falls back to simple selection (resize/edit possible).
    state.selectedIds = ids.length > 1 ? ids : [];
    state.selected = ids.length === 1 ? ids[0] : null;
    return;
  }

  // Dropped position: syncs the final position (not during the drag itself).
  if (drag.mode === 'group') {
    drag.ids.forEach((id) => {
      const m = findById(id);
      if (m && m.kind !== 'liaison') pushMove(m);
    });
  } else {
    const el = findById(drag.id);
    if (el && el.kind !== 'liaison') pushMove(el);
  }
  scheduleSave();
}

// ---- Mouse ----
function onMouseDown(e) {
  if (e.button === 1 || e.button === 2) return; // middle/right handled elsewhere
  pointerDown(e.clientX, e.clientY, { shift: e.shiftKey });
}
function onMouseMove(e) { if (drag) pointerMove(e.clientX, e.clientY); else updateCursor(e.clientX, e.clientY); }
function onMouseUp() { pointerUp(); }

function onWheel(e) {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomAt(e.clientX, e.clientY, factor);
  scheduleSave();
}

// ---- Touch ----
function onTouchStart(e) {
  // While editing: a tap outside the textarea validates and closes it (otherwise
  // preventDefault would block the blur, and we'd stay stuck in edit mode on mobile).
  if (editing) { document.getElementById('editor').blur(); e.preventDefault(); return; }

  if (e.touches.length === 1) {
    const t = e.touches[0];
    const now = performance.now();
    if (now - lastTap < 300 && lastTapPos &&
        Math.hypot(t.clientX - lastTapPos.x, t.clientY - lastTapPos.y) < 30) {
      // Double-tap.
      lastTap = 0;
      handleDouble(t.clientX, t.clientY);
      e.preventDefault();
      return;
    }
    lastTap = now;
    lastTapPos = { x: t.clientX, y: t.clientY };
    pointerDown(t.clientX, t.clientY);
    // Long press => radial menu (then drag-to-choose without releasing).
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      drag = null;
      openContextAt(t.clientX, t.clientY);
      radialPressActive = true;
      updateRadialHover(t.clientX, t.clientY);
    }, 450);
  } else if (e.touches.length === 2) {
    clearTimeout(longPressTimer);
    drag = null;
    const [a, b] = e.touches;
    pinch = {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      mx: (a.clientX + b.clientX) / 2,
      my: (a.clientY + b.clientY) / 2,
    };
  }
  e.preventDefault();
}

function onTouchMove(e) {
  if (e.touches.length === 2 && pinch) {
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    if (pinch.dist > 0) zoomAt(mx, my, dist / pinch.dist);
    panBy(mx - pinch.mx, my - pinch.my);
    pinch = { dist, mx, my };
    scheduleSave();
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    // Pie-menu open and finger still down: choose by dragging.
    if (radialPressActive) { updateRadialHover(t.clientX, t.clientY); e.preventDefault(); return; }
    if (lastTapPos && Math.hypot(t.clientX - lastTapPos.x, t.clientY - lastTapPos.y) > 10) {
      clearTimeout(longPressTimer);
    }
    const cw = screenToWorld(t.clientX, t.clientY); reportCursor(cw.x, cw.y); // cursor = finger position
    pointerMove(t.clientX, t.clientY);
  }
  e.preventDefault();
}

function onTouchEnd(e) {
  clearTimeout(longPressTimer);
  if (radialPressActive) { selectRadialHover(); e.preventDefault(); return; }
  if (e.touches.length < 2) pinch = null;
  if (e.touches.length === 0) pointerUp();
  e.preventDefault();
}

// ---- Image drop ----
function onDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const w = screenToWorld(e.clientX, e.clientY);
  placeImage(file, w.x, w.y, hitRect(w));
}

// Shared by drag-drop, paste, the file picker and the camera capture: creates
// a new image rectangle at (wx, wy), or sets/replaces the image on an
// existing one if target is given (its source, if target is a link).
function placeImage(file, wx, wy, target) {
  if (isLocked()) return; // read-only guest: paste/drop/picker/camera all funnel through here
  if (!file || !file.type.startsWith('image/')) return;
  if (target && target.ref) target = sourceOf(target);

  processImage(file, (src, ratio) => {
    let node;
    if (target) { node = target; }
    else {
      const { w: nw, h: nh } = imageRectSize(ratio);
      node = addRect(wx - nw / 2, wy - nh / 2, '');
      node.w = nw; node.h = nh; reset(node);
    }
    state.selected = node.id;
    setNodeImage(node, src);
  });
}

// ---- Image file picker / camera capture (radial menu) ----
function openImageFilePicker(wx, wy, target) {
  pendingImagePos = { x: wx, y: wy };
  pendingImageTarget = target || null;
  document.getElementById('imageFileInput').click();
}
function openCameraPicker(wx, wy, target) {
  pendingImagePos = { x: wx, y: wy };
  pendingImageTarget = target || null;
  document.getElementById('imageCameraInput').click();
}
function handleImageFile(file) {
  const target = pendingImageTarget; pendingImageTarget = null;
  const pos = pendingImagePos || screenToWorld(lastMouse.x, lastMouse.y); pendingImagePos = null;
  if (file) placeImage(file, pos.x, pos.y, target);
}

// Stores the image in IndexedDB (ref 'idb:<hash>') then shares it with peers.
// Falls back to the raw data URL if IndexedDB fails (rare).
function setNodeImage(node, dataUrl) {
  storeImage(dataUrl).then((ref) => {
    node.image = ref; scheduleSave(); shareImage(ref);
  }).catch(() => { node.image = dataUrl; scheduleSave(); });
}

// Dimensions of an image rectangle: ~constant area, ratio = the image's.
function imageRectSize(ratio) {
  const TARGET = 185;
  let w = TARGET * Math.sqrt(ratio);
  let h = TARGET / Math.sqrt(ratio);
  w = Math.max(70, Math.min(340, Math.round(w)));
  h = Math.max(70, Math.min(340, Math.round(h)));
  return { w, h };
}

// True when the focus is in any text-entry element (textarea, input, or a
// contenteditable like the board-name div): keyboard/paste shortcuts must
// then keep their normal text behavior instead of acting on blocks. The
// editing flag alone is not enough -- it only covers the #editor textarea,
// not the connector YAML editor, the board-picker input or the board rename.
function isTextEntryFocused() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
}

// Paste (Ctrl-V): an image from the clipboard creates an image rectangle;
// otherwise pastes the copied internal element.
function onPaste(e) {
  if (editing) return; // while editing, the textarea pastes normally
  if (isTextEntryFocused()) return; // pasting text in a field must stay a text paste
  if (isLocked()) return;
  const cb = loadClipboard();
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const file = it.getAsFile();
      if (file) {
        // Guard: if this is the SAME system image as the last one pasted and
        // we've copied a block since then, paste the internal block (not the stale image).
        const sig = file.size + ':' + file.type;
        if (cb && internalSince && sig === lastImgSig) break;
        e.preventDefault();
        lastImgSig = sig; internalSince = false;
        const w = screenToWorld(lastMouse.x, lastMouse.y);
        placeImage(file, w.x, w.y, null);
        return;
      }
    }
  }
  if (cb) { e.preventDefault(); pasteClipboard(); }
}

// Resizes (max 800px) and re-encodes to save on localStorage.
function processImage(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 800;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const cw = Math.max(1, Math.round(img.naturalWidth * scale));
      const ch = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      cb(cv.toDataURL(type, 0.85), img.naturalWidth / img.naturalHeight);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---- Double-click / double-tap ----
function handleDouble(sx, sy) {
  const w = screenToWorld(sx, sy);
  const r = hitRect(w);
  // Double-tap/click on a link => follows it directly (allowed even when locked).
  if (r && displayLink(r)) { clearLinkFocus(); followLink(displayLink(r)); return; }
  if (r && r.kind === 'voice') { toggleVoice(r); return; } // double-click = playback
  if (r && !r.ref && youTubeId(r.text)) { setActiveVideo(r); return; } // same for a video block
  // Connector switch: like voice playback, allowed even with mobile interaction
  // locked (that lock is only meant to prevent accidental drags/edits) -- but
  // still blocked for a real read-only P2P guest, who shouldn't flip a device.
  if (r && r.kind === 'connector' && r.display === 'switch') {
    if (isLocked()) return;
    r._pressT = performance.now(); // drives the click animation (render.js), never synced
    // Actuation (the write side) is reserved to the creator's own device --
    // not just in bridge mode, where that's the only device with the real
    // yaml, but for every connector: a non-bridge connector's yaml IS synced
    // to every peer, so without this a malicious guest could plant a
    // connector pointing at, say, an address on someone else's LAN and have
    // THEIR browser actually fire the request on every double-click. Reading
    // (refreshConnector/pollConnector) stays unrestricted for everyone --
    // only the write path is gated, same requestSwitchToggle relay this
    // already used for bridge mode.
    if (r.creatorUid && r.creatorUid !== getUserId()) { requestSwitchToggle(r.id); return; }
    toggleSwitch(r);
    return;
  }
  // Generic (triangle) or readout connector: double-click force-refreshes it
  // on demand -- useful on its own with poll_interval: 0 in the yaml (no
  // background timer at all, purely click-to-fetch), and harmless otherwise
  // (just an early refresh). A clock has no network involved, nothing to do.
  if (r && r.kind === 'connector' && r.display !== 'clock') {
    if (isLocked()) return;
    refreshConnector(r);
    return;
  }
  // Clock display, stopwatch/countdown modes: double-click is the quick
  // control (start/pause, or open the target picker) -- same actions as the
  // radial menu entries, just faster to reach.
  if (r && r.kind === 'connector' && r.display === 'clock' && r.clockFormat === 'STOPWATCH') {
    if (isLocked()) return;
    toggleStopwatch(r);
    return;
  }
  if (r && r.kind === 'connector' && r.display === 'clock' && r.clockFormat === 'COUNTDOWN') {
    if (isLocked()) return;
    openCountdownPicker(r);
    return;
  }
  if (!canInteract()) return; // locked: no editing/opening
  if (r) {
    const img = displayImage(r);
    if (img) { openImagePopup(img); return; }
    const editTarget = r.ref ? sourceOf(r) : r; // editing a link = editing its source
    if (editTarget) startEdit('rect', editTarget, r);
    return;
  }
  const hz = hitHexagon(w) || hitCircle(w);
  if (hz) startEdit('zone', hz.c, hz.c);
}

function onKeyDown(e) {
  if (editing) return;
  // Any other text field with focus (e.g. the connector YAML textarea, a
  // settings input) must keep normal text-editing keys -- otherwise Delete/
  // Backspace/Ctrl+Z there would hit the canvas shortcuts below and delete
  // the selected block instead of editing the text.
  if (isTextEntryFocused()) return;

  // '²' key (left of 1 on AZERTY): wobble debug panel.
  if (e.key === '²' || e.code === 'Backquote') { toggleDebug(); e.preventDefault(); return; }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'c' || e.key === 'C')) {
    // Text highlighted anywhere in the page (link bar, popup...): let the
    // browser copy that text instead of hijacking Ctrl+C for the block.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    copySelection(); e.preventDefault(); return; // read-only: copying locally is fine
  }
  if (isLocked()) return; // read-only guest: no undo, no delete
  if (mod && (e.key === 'z' || e.key === 'Z')) { doUndo(); e.preventDefault(); return; }
  // Pasting (Ctrl-V) is handled by the 'paste' event (see onPaste) so we can
  // read an image from the clipboard.

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedIds.length) {
      state.selectedIds.slice().forEach((id) => removeMaybeConfirm(findById(id)));
      state.selectedIds = [];
      e.preventDefault();
      return;
    }
    if (state.selected) { removeMaybeConfirm(findById(state.selected)); e.preventDefault(); }
  }
}

// Routes a delete to the confirm-first flow on the "boards" directory board,
// the normal no-questions-asked one everywhere else.
function removeMaybeConfirm(el) {
  if (el && getBoardId() === 'boards' && el.link) { deleteBoardBlock(el); return; }
  removeElement(el);
}

// Undoes the last change + recalibrates physics/selection.
function doUndo() {
  if (undo()) { state.nodes.forEach(reset); state.selected = null; state.selectedIds = []; }
}

// Creates a Liaison block. Standalone: starts the P2P host. As a client: just
// shows the link/QR of the host we're connected to (without becoming a host).
function createLiaison(wx, wy) {
  if (getBoardId() === 'home') return; // home is sanctuarized: never connected P2P
  const n = { id: newId(), kind: 'liaison', x: wx - 100, y: wy - 115, w: 200, h: 230, status: 'init' };
  state.nodes.push(n);
  reset(n);
  state.selected = n.id;
  if (isClient()) {
    loadQR(); // as a client, startHost isn't called: we load the QR lib here
    const id = hostId();
    if (id) { n.peerId = id; n.code = id; n.url = buildUrl(id); n.status = 'online'; }
    else n.status = 'error';
  } else if (!adoptHost(n)) {
    startHost(n); // no live host peer: starts one
  } else {
    loadQR(); // reused peer: make sure the QR lib is loaded
  }
}

// Copies a Liaison block's link to the clipboard + visual feedback.
function copyLink(n) {
  const done = () => { n._copiedUntil = performance.now() + 1400; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(n.url).then(done).catch(done);
  } else {
    done();
  }
}

// ---- Two-step links: 1st tap = focus (shows the URL), 2nd = follows it ----
let linkFocus = null; // { id, url }

function handleLinkTap(n) {
  const lk = displayLink(n);
  if (!lk) return;
  if (linkFocus && linkFocus.id === n.id) {
    const url = lk; clearLinkFocus(); followLink(url);
  } else {
    linkFocus = { id: n.id, url: lk };
    state.selected = n.id;
    showLinkBar(lk);
  }
}

function showLinkBar(url) {
  const el = document.getElementById('linkbar');
  el.textContent = t('linkbar.prefix') + url;
  el.title = url;
  el.classList.add('show');
}
function clearLinkFocus() {
  linkFocus = null;
  document.getElementById('linkbar').classList.remove('show');
}

// Follows a link: board => same tab (+ history); external => new tab. A
// board URL may still carry a full origin (legacy links, or one pasted by
// hand into the link editor) -- navigation is always rebuilt origin-less
// on the LOCAL page so it stays inside the app (the desktop webview must
// never leave 127.0.0.1).
function followLink(url) {
  const bu = parseBoardUrl(url);
  if (bu) { recordBoard(bu.id, null, bu.peer); location.href = buildBoardUrl(bu.id, bu.peer); return; }
  openLink(url);
}

// Opens an external link in a new tab (prefixes https:// if needed).
let _lastLinkOpen = 0;
function openLink(url) {
  const t = performance.now();
  if (t - _lastLinkOpen < 600) return; // avoids double-opening (double-click)
  _lastLinkOpen = t;
  let u = String(url).trim();
  if (!u) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  openExternal(u);
}

// Modal YAML program editor for a connector block (see connector.js).
function openConnectorEditor(node) {
  const m = document.createElement('div');
  m.className = 'recmodal';
  m.innerHTML = '<div class="connector-card">'
    + '<div class="connector-title">' + t('connector.title') + '</div>'
    + '<textarea class="connector-yaml" spellcheck="false"></textarea>'
    + '<div class="connector-error"></div>'
    + '<div class="connector-actions">'
    + '<button class="connector-save">' + t('connector.save') + '</button>'
    + '<button class="connector-cancel">' + t('connector.cancel') + '</button>'
    + '</div></div>';
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);

  const ta = m.querySelector('.connector-yaml');
  const errEl = m.querySelector('.connector-error');
  ta.value = node.yaml || '';
  setTimeout(() => ta.focus(), 50);

  m.querySelector('.connector-cancel').addEventListener('click', () => m.remove());
  m.querySelector('.connector-save').addEventListener('click', async () => {
    try {
      await applyConnectorProgram(node, ta.value);
      m.remove();
    } catch (e) {
      errEl.textContent = t('alert.yamlInvalid') + (e.message ? ' (' + e.message + ')' : '');
    }
  });
}

// Confirmation before turning on a connector's network-bridge mode: from
// then on, the yaml (device address/credentials) stops being synced at all
// (see sync.js buildContent) and every other connected peer can flip the
// switch through us instead -- worth a deliberate "yes, really" click.
// Reuses the connector-editor's modal look (recmodal/connector-card) rather
// than window.confirm(), which the desktop build can't use at all (Tauri's
// dialog ACL blocks it -- see platform.js).
function openBridgeWarning(node) {
  const m = document.createElement('div');
  m.className = 'recmodal';
  m.innerHTML = '<div class="connector-card">'
    + '<div class="connector-title">' + t('bridge.warnTitle') + '</div>'
    + '<div class="connector-error" style="color: var(--ink); min-height: 0;">' + t('bridge.warnBody') + '</div>'
    + '<div class="connector-actions">'
    + '<button class="connector-save">' + t('bridge.confirm') + '</button>'
    + '<button class="connector-cancel">' + t('connector.cancel') + '</button>'
    + '</div></div>';
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);
  m.querySelector('.connector-cancel').addEventListener('click', () => m.remove());
  m.querySelector('.connector-save').addEventListener('click', () => {
    node.bridge = true;
    scheduleSave();
    pollConnector(node);
    m.remove();
  });
}

// Format picker for the clock display: picking any option also switches the
// block to display:'clock' if it wasn't already (same modal reopens later
// via the "clock format" radial entry to just change the format).
const CLOCK_FORMATS = ['HH:MM', 'HH:MM:SS', 'HH:MM:SS+DATE', 'DAY', 'FULLDATE', 'STOPWATCH', 'COUNTDOWN'];
function openClockFormatPicker(node) {
  const m = document.createElement('div');
  m.className = 'recmodal';
  m.innerHTML = '<div class="connector-card">'
    + '<div class="connector-title">' + t('clock.formatTitle') + '</div>'
    + '<div class="connector-actions connector-actions-col">'
    + CLOCK_FORMATS.map((f) => '<button class="connector-pick" data-fmt="' + f + '">' + t('clock.' + f) + '</button>').join('')
    + '</div>'
    + '<div class="connector-actions"><button class="connector-cancel">' + t('connector.cancel') + '</button></div>'
    + '</div>';
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);
  m.querySelectorAll('.connector-pick').forEach((b) => b.addEventListener('click', () => {
    node.clockFormat = b.dataset.fmt;
    if (node.display !== 'clock') node.display = 'clock';
    scheduleSave();
    pollConnector(node);
    m.remove();
    if (node.clockFormat === 'COUNTDOWN' && !node.countdownTarget) openCountdownPicker(node);
  }));
  m.querySelector('.connector-cancel').addEventListener('click', () => m.remove());
}

// Countdown target picker: a single datetime-local input, reusing the same
// modal chrome as the clock format picker and the connector YAML editor.
function openCountdownPicker(node) {
  const m = document.createElement('div');
  m.className = 'recmodal';
  const toLocalInputValue = (ms) => {
    const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  };
  const initial = node.countdownTarget ? toLocalInputValue(node.countdownTarget) : '';
  m.innerHTML = '<div class="connector-card">'
    + '<div class="connector-title">' + t('clock.setTarget') + '</div>'
    + '<div class="connector-actions connector-actions-col">'
    + '<input type="datetime-local" class="countdown-input" value="' + initial + '">'
    + '</div>'
    + '<div class="connector-actions">'
    + '<button class="connector-save">' + t('connector.save') + '</button>'
    + '<button class="connector-cancel">' + t('connector.cancel') + '</button>'
    + '</div></div>';
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);
  const inp = m.querySelector('.countdown-input');
  m.querySelector('.connector-save').addEventListener('click', () => {
    const ms = inp.value ? new Date(inp.value).getTime() : 0;
    setCountdownTarget(node, ms > 0 ? ms : null);
    m.remove();
  });
  m.querySelector('.connector-cancel').addEventListener('click', () => m.remove());
}

// Removes an element (explosion + propagation; detaches the host if it's a Liaison).
function removeElement(el) {
  if (!el) return;
  if (el.kind === 'liaison') {
    // Detaches without destroying the peer: the liaison stays alive for the
    // session and recreating the block is instant (see adoptHost). As a client, nothing to cut.
    if (!isClient()) detachHost();
    removeById(el.id); scheduleSave(); return;
  }
  if (el.kind === 'voice') {
    explodeElementCascade(el);
    removeVoiceAudio(el.id); // erases the audio in IndexedDB
    removeById(el.id); scheduleSave(); return;
  }
  if (el.kind === 'connector') {
    explodeElementCascade(el);
    stopPolling(el.id);
    removeById(el.id); scheduleSave(); return;
  }
  explodeElementCascade(el); // local explosion
  pushDelete(el.id);         // explosion + deletion for peers
  removeById(el.id);
  scheduleSave();
}

// ---- Copy / paste ----
// The clipboard is persisted to localStorage (not just kept in memory) so it
// survives navigating to another board -- switching boards in Bete is always
// a full page reload (see boards.js/main.js), which would otherwise wipe it.
// Each item is made self-contained: images are inlined to data URLs (an
// 'idb:<hash>' ref is only guaranteed to resolve in the SAME browser/board
// session) and voice-memo audio (keyed by node id, not content hash) is
// carried along as a data URL too, since a pasted node gets a fresh id and
// would otherwise point at a non-existent audio blob. Link nodes (ref) are
// flattened to a real copy of their source's content, since the source node
// they point to may not exist on the destination board.
async function copySelection() {
  const ids = state.selectedIds.length ? state.selectedIds.slice() : (state.selected ? [state.selected] : []);
  const els = ids.map(findById).filter((el) => el && el.kind !== 'liaison'); // a P2P link can't be copied
  if (!els.length) return;

  const items = [];
  for (const el of els) {
    const data = {};
    for (const k in el) if (k[0] !== '_' && k !== 'id') data[k] = el[k];
    if (data.ref) { // link node: flatten to a standalone copy of its resolved content
      const src = sourceOf(el);
      delete data.ref;
      if (src) { data.text = src.text; data.image = src.image; data.link = src.link; }
    }
    if (data.image && data.image.indexOf('idb:') === 0) await inlineImages([data]);
    if (el.kind === 'voice') {
      try { const blob = await getAudio(el.id); if (blob) data._audioData = await blobToDataUrl(blob); } catch (e) { /* */ }
    }
    items.push({ isCircle: state.circles.includes(el), isHex: state.hexagons.includes(el), data });
  }
  clipboard = { items };
  persistClipboard();
  internalSince = true; // an internal copy happened -> takes priority over the stale system image
  // Overwrites the SYSTEM clipboard (text): otherwise a previously copied image
  // resurfaces on the next Ctrl-V (onPaste detects the system image first).
  try {
    const txt = els[0].text || els[0].description || ' ';
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {});
  } catch (e) { /* */ }
  toast(t('toast.copied', { n: items.length }));
}

function persistClipboard() {
  try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboard)); } catch (e) { /* quota / private mode: in-memory clipboard still works this session */ }
}

function loadClipboard() {
  if (clipboard) return clipboard;
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (raw) clipboard = JSON.parse(raw);
  } catch (e) { /* */ }
  return clipboard;
}

// Circles/hexagons store x,y as their CENTER; rect-like nodes store x,y as
// their TOP-LEFT corner (see render.js) -- normalize to a center point so
// items of different kinds keep a correct relative layout on paste.
function centerOf(item) {
  const d = item.data;
  return (item.isCircle || item.isHex) ? { x: d.x, y: d.y } : { x: d.x + (d.w || 150) / 2, y: d.y + (d.h || 70) / 2 };
}

async function pasteClipboard() {
  const cb = loadClipboard();
  if (!cb || !cb.items || !cb.items.length) return;
  const w = screenToWorld(lastMouse.x, lastMouse.y);
  // Anchor on the first item, centered at the mouse, so a multi-selection
  // paste keeps its relative layout (matches the old single-item behavior).
  const anchor = centerOf(cb.items[0]);
  const newIds = [];
  for (const item of cb.items) {
    const d = item.data;
    const c = centerOf(item);
    const cx = w.x + (c.x - anchor.x), cy = w.y + (c.y - anchor.y);
    let img = d.image;
    if (img && img.indexOf('data:') === 0) { try { img = await storeImage(img); } catch (e) { /* keeps the data URL */ } }
    if (item.isCircle || item.isHex) {
      const z = { ...d, id: newId(), x: cx, y: cy };
      (item.isHex ? state.hexagons : state.circles).push(z);
      newIds.push(z.id);
    } else {
      const id = newId();
      const n = { ...d, id, x: cx - (d.w || 150) / 2, y: cy - (d.h || 70) / 2 };
      if (img) n.image = img;
      delete n._audioData;
      state.nodes.push(n);
      reset(n);
      if (d._audioData) {
        try { const blob = dataUrlToBlob(d._audioData); await putAudio(id, blob); } catch (e) { /* */ }
      }
      newIds.push(id);
    }
  }
  if (newIds.length > 1) { state.selectedIds = newIds; state.selected = null; }
  else { state.selected = newIds[0]; state.selectedIds = []; }
  scheduleSave();
  toast(t('toast.pasted', { n: newIds.length }));
}

// ---- Radial menu ----
function openContextAt(sx, sy) {
  closeMenus();
  // Locked (mobile): the menu only offers to enable interaction.
  if (!interactionEnabled) {
    openRadial(sx, sy, [{ label: t('radial.enable'), icon: 'unlock', color: COL.green, fn: () => { interactionEnabled = true; updateHint(); } }]);
    return;
  }
  const w = screenToWorld(sx, sy);
  const r = hitRect(w);
  const hz = !r ? (hitHexagon(w) || hitCircle(w)) : null;

  let items;
  // The built-in "boards" directory is auto-generated and otherwise
  // non-editable (see main.js: loadBoardsDirectory) -- only three actions
  // are allowed here: delete a board (with confirmation, deleteBoardBlock),
  // delete a liaison circle (also forgets that liaison, deleteLiaisonCircle),
  // and dragging a block in/out of a circle (see finishDrag), which needs no
  // menu at all.
  if (getBoardId() === 'boards') {
    if (r && r.link) items = [{ label: t('radial.delete'), icon: 'trash', color: COL.red, fn: () => deleteBoardBlock(r) }];
    else if (hz) items = [{ label: t('radial.delete'), icon: 'trash', color: COL.red, fn: () => deleteLiaisonCircle(hz.c) }];
    else items = [{ label: t('radial.settings'), icon: 'gear', color: COL.white, fn: () => openSettings() }];
    openRadial(sx, sy, items);
    return;
  }
  if (isLocked()) {
    // Read-only guest: no creation/edit/delete anywhere. A liaison block still
    // offers "Copy link" (a read action), everything else just informs.
    items = (r && r.kind === 'liaison')
      ? [{ label: t('radial.copyLink'), icon: 'copy', color: COL.green, fn: () => copyLink(r) }]
      : [{ label: t('radial.readOnly'), icon: 'lock', color: COL.orange, fn: () => {} }];
  } else if (r && r.kind === 'liaison') {
    items = [{ label: t('radial.copyLink'), icon: 'copy', color: COL.green, fn: () => copyLink(r) }];
    if (!isClient()) items.push({ label: t('radial.newLink'), icon: 'refresh', color: COL.yellow, fn: () => refreshHostId(r) });
    items.push({ label: t('radial.delete'), icon: 'trash', color: COL.red, fn: () => removeElement(r) });
  } else if (r && state.selectedIds.length > 1 && state.selectedIds.indexOf(r.id) !== -1) {
    // Multi-selection menu.
    const ids = state.selectedIds.slice();
    items = [{ label: t('radial.deleteN', { n: ids.length }), icon: 'trash', color: COL.red, fn: () => { ids.forEach((id) => removeElement(findById(id))); state.selectedIds = []; } }];
  } else if (r && r.kind === 'voice') {
    items = [
      { label: t('radial.playPause'), icon: 'mic', color: COL.green, fn: () => toggleVoice(r) },
      { label: t('radial.delete'), icon: 'trash', color: COL.red, fn: () => removeElement(r) },
    ];
  } else if (r && r.kind === 'connector') {
    items = [{ label: t('radial.editProgram'), icon: 'edit', color: COL.cyan, fn: () => openConnectorEditor(r) }];
    if (r.display !== 'switch') items.push({ label: t('radial.makeSwitch'), icon: 'power', color: COL.wood, fn: () => { r.display = 'switch'; scheduleSave(); pollConnector(r); } });
    else items.push({ label: t('radial.color'), icon: 'color', color: COL.purple, fn: () => openPalette(sx, sy, r, BUTTON_COLORS) });
    if (r.display !== 'readout') items.push({ label: t('radial.makeReadout'), icon: 'rect', color: COL.green, fn: () => { r.display = 'readout'; scheduleSave(); pollConnector(r); } });
    items.push(r.display === 'clock'
      ? { label: t('radial.clockFormat'), icon: 'clock', color: COL.cyan, fn: () => openClockFormatPicker(r) }
      : { label: t('radial.makeClock'), icon: 'clock', color: COL.cyan, fn: () => openClockFormatPicker(r) });
    if (r.display === 'clock' && r.clockFormat === 'STOPWATCH') {
      items.push({ label: r.stopwatchStart ? t('radial.pauseStopwatch') : t('radial.startStopwatch'), icon: 'clock', color: COL.green, fn: () => toggleStopwatch(r) });
      items.push({ label: t('radial.resetStopwatch'), icon: 'undo', color: COL.yellow, fn: () => resetStopwatch(r) });
    }
    if (r.display === 'clock' && r.clockFormat === 'COUNTDOWN') {
      items.push({ label: t('radial.setCountdown'), icon: 'clock', color: COL.green, fn: () => openCountdownPicker(r) });
    }
    // Network bridge: reserved to whoever created this connector (creatorUid
    // is stamped once at creation, see state.js/addConnector) -- enabling it
    // is what starts exposing the switch (without the yaml) to every other
    // peer, so only the person who actually owns the local device should
    // be able to flip that on. Doesn't apply to a clock: no network involved.
    if (r.display !== 'clock' && (!r.creatorUid || r.creatorUid === getUserId())) {
      items.push(r.bridge
        ? { label: t('radial.bridgeOff'), icon: 'cloud', color: COL.cyan, fn: () => { r.bridge = false; scheduleSave(); pollConnector(r); } }
        : { label: t('radial.bridgeOn'), icon: 'cloud', color: COL.cyan, fn: () => openBridgeWarning(r) });
    }
    items.push({ label: t('radial.delete'), icon: 'trash', color: COL.red, fn: () => removeElement(r) });
  } else if (r) {
    const isLink = !!r.ref;
    items = [{ label: t('radial.editText'), icon: 'edit', color: COL.cyan, fn: () => { const t = isLink ? sourceOf(r) : r; if (t) startEdit('rect', t, r); } }];
    // A link has no color of its own -- it always mirrors its source's (see
    // effectiveColor()), so recoloring only makes sense on a real rectangle.
    if (!isLink) items.push({ label: t('radial.color'), icon: 'color', color: COL.purple, fn: () => openPalette(sx, sy, r, BUTTON_COLORS) });
    items.push({ label: t('radial.clickableLink'), icon: 'link', color: COL.purple, fn: () => { const t = isLink ? sourceOf(r) : r; if (t) openLinkEditor(t); } });
    const img = displayImage(r);
    if (img) items.push({ label: t('radial.viewImage'), icon: 'eye', color: COL.white, fn: () => openImagePopup(img) });
    if (!isLink) items.push({ label: t('radial.uploadImage'), icon: 'image', color: COL.cyan, fn: () => openImageFilePicker(r.x, r.y, r) });
    // Camera only makes sense on touch devices: on desktop capture= is ignored
    // and it would just open the same file dialog as "Upload image".
    if (!isLink && isCoarse) items.push({ label: t('radial.camera'), icon: 'camera', color: COL.cyan, fn: () => openCameraPicker(r.x, r.y, r) });
    if (!isLink && r.image) items.push({ label: t('radial.removeImage'), icon: 'imgx', color: COL.orange, fn: () => { delete r.image; scheduleSave(); } });
    // Transforming this rectangle (instead of dedicated entries in the main menu).
    if (!isLink && r.kind !== 'pancarte') {
      items.push({ label: t('radial.boardLink'), icon: 'board', color: COL.cyan, fn: () => openBoardPicker(r.x, r.y, r) });
      if (!r.image) items.push({ label: t('radial.voiceMemo'), icon: 'mic', color: COL.red, fn: () => recordVoiceMemo(r.x, r.y, r) });
      items.push({
        label: t('radial.makeSign'), icon: 'pancarte', color: COL.wood,
        fn: () => {
          // Signs read as larger wooden boards: grow towards that size (keeping the center fixed) instead of just relabeling.
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          r.w = Math.max(r.w, 240); r.h = Math.max(r.h, 130);
          r.x = cx - r.w / 2; r.y = cy - r.h / 2;
          r.kind = 'pancarte';
          scheduleSave();
        },
      });
    } else if (!isLink && r.kind === 'pancarte') {
      items.push({ label: t('radial.makeRect'), icon: 'rect', color: COL.green, fn: () => { delete r.kind; scheduleSave(); } });
    }
    items.push({ label: isLink ? t('radial.unlink') : t('radial.delete'), icon: 'trash', color: COL.red, fn: () => { removeById(r.id); scheduleSave(); } });
  } else if (hz) {
    const c = hz.c;
    items = [
      { label: t('radial.color'), icon: 'color', color: COL.purple, fn: () => openPalette(sx, sy, c) },
      { label: t('radial.text'), icon: 'text', color: COL.cyan, fn: () => startEdit('zone', c, c) },
      { label: t('radial.delete'), icon: 'trash', color: COL.red, fn: () => { removeById(c.id); scheduleSave(); } },
    ];
  } else {
    items = [
      { label: t('radial.rectangle'), icon: 'rect', color: COL.green, fn: () => { const n = addRect(w.x - 75, w.y - 35); reset(n); state.selected = n.id; startEdit('rect', n, n); scheduleSave(); } },
      { label: t('radial.circle'), icon: 'circle', color: COL.cyan, fn: () => { const c = addCircle(w.x, w.y); state.selected = c.id; scheduleSave(); } },
      { label: t('radial.hexagon'), icon: 'hexa', color: COL.orange, fn: () => { const h = addHexagon(w.x, w.y); state.selected = h.id; scheduleSave(); } },
      { label: t('radial.connector'), icon: 'triangle', color: COL.red, fn: () => { const n = addConnector(w.x - 75, w.y - 65); reset(n); state.selected = n.id; scheduleSave(); } },
      // Home is sanctuarized (never connected P2P), so no liaison block there.
      ...(getBoardId() === 'home' ? [] : [{ label: t('radial.liaison'), icon: 'share', color: COL.magenta, fn: () => createLiaison(w.x, w.y) }]),
      { label: t('radial.undo'), icon: 'undo', color: COL.yellow, fn: () => doUndo() },
      { label: t('radial.selection'), icon: 'select', color: COL.yellow, fn: () => { selectArmed = true; } },
      { label: t('radial.settings'), icon: 'gear', color: COL.white, fn: () => openSettings() },
    ];
    // On mobile: option to re-lock interaction.
    if (isCoarse) items.push({ label: t('radial.lock'), icon: 'lock', color: COL.orange, fn: () => { interactionEnabled = false; state.selected = null; updateHint(); } });
  }
  openRadial(sx, sy, items);
}

function mkRitem(it, extraClass) {
  const el = document.createElement('div');
  el.className = 'ritem' + (extraClass ? ' ' + extraClass : '');
  el.title = it.label;
  el.style.setProperty('--c', it.color || COL.green);
  el.innerHTML = svgEl(it.icon);
  el.addEventListener('mousedown', (ev) => ev.stopPropagation());
  el.addEventListener('touchstart', (ev) => ev.stopPropagation());
  el.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenus(); it.fn(); });
  return el;
}

function openRadial(x, y, items) {
  const radial = document.getElementById('radial');
  radial.innerHTML = '';
  radial.classList.remove('hidden');

  const n = items.length;
  const D = isCoarse ? 62 : 52;        // button diameter
  const start = -Math.PI / 2;

  // Radius: the chord between two neighboring buttons exceeds their diameter (no overlap).
  let radius = n > 1 ? (D + 14) / (2 * Math.sin(Math.PI / n)) : 0;
  radius = Math.max(radius, D + 6);

  // Recenters so the whole menu stays visible.
  const m = radius + D / 2 + 6;
  const cx = Math.max(m, Math.min(x, window.innerWidth - m));
  const cy = Math.max(m, Math.min(y, window.innerHeight - m));
  radial.style.left = cx + 'px';
  radial.style.top = cy + 'px';

  // Center button: closes the menu (visual anchor).
  const center = mkRitem({ label: t('radial.close'), icon: 'close', color: COL.green, fn: () => {} }, 'ritem-center show');
  center.style.transform = 'translate(-50%, -50%) scale(1)';
  center.style.opacity = '1';
  radial.appendChild(center);

  // Center->finger line (SVG) + halo under the finger: touch-drag guides.
  const ray = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ray.setAttribute('class', 'radial-ray');
  ray.innerHTML = '<line x1="0" y1="0" x2="0" y2="0" />';
  radial.appendChild(ray);
  radialRay = ray;
  const halo = document.createElement('div');
  halo.className = 'radial-halo';
  radial.appendChild(halo);
  radialHalo = halo;

  // Items fanning out (staggered spring animation).
  radialItems = [];
  radialHoverIdx = -1;
  radialCx = cx; radialCy = cy;
  items.forEach((it, i) => {
    const ang = start + (i / n) * Math.PI * 2;
    const dx = Math.cos(ang) * radius, dy = Math.sin(ang) * radius;
    const el = mkRitem(it);
    radial.appendChild(el);
    radialItems.push({ el, fn: it.fn, dx, dy, ang, color: it.color || COL.green });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transitionDelay = (i * 32) + 'ms';
      el.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`;
      el.classList.add('show');
    }));
  });
  armCloseOnce();
}

function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* */ } }

// Touch pie-menu: dragging the finger towards an item selects it (by direction).
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); }

function updateRadialHover(x, y) {
  const dx = x - radialCx, dy = y - radialCy;
  const dist = Math.hypot(dx, dy);
  let idx = -1;
  if (dist > 30 && radialItems.length) { // outside the central deadzone
    const a = Math.atan2(dy, dx);
    let best = Infinity;
    radialItems.forEach((it, i) => { const d = angDiff(a, it.ang); if (d < best) { best = d; idx = i; } });
  }
  if (idx !== radialHoverIdx) vibrate(idx >= 0 ? 10 : 4); // haptic tick on item change
  radialHoverIdx = idx;
  radialItems.forEach((it, i) => {
    const on = i === idx;
    it.el.style.transitionDelay = '0ms';
    it.el.style.transform = `translate(calc(-50% + ${it.dx}px), calc(-50% + ${it.dy}px)) scale(${on ? 1.5 : 1})`;
    it.el.classList.toggle('hover', on);
  });
  // Line from the center to the finger + halo under the finger.
  const active = dist > 30;
  if (radialRay) {
    const col = idx >= 0 ? radialItems[idx].color : COL.green;
    const ln = radialRay.firstChild;
    if (ln) { ln.setAttribute('x2', dx); ln.setAttribute('y2', dy); ln.setAttribute('stroke', col); }
    radialRay.style.opacity = active ? '1' : '0';
  }
  if (radialHalo) {
    radialHalo.style.transform = `translate(${dx}px, ${dy}px) translate(-50%, -50%)`;
    radialHalo.style.borderColor = idx >= 0 ? radialItems[idx].color : COL.green;
    radialHalo.style.opacity = active ? '1' : '0';
  }
}

function selectRadialHover() {
  radialPressActive = false;
  const idx = radialHoverIdx;
  if (idx >= 0 && radialItems[idx]) { vibrate(22); const fn = radialItems[idx].fn; closeMenus(); fn(); }
  // otherwise (finger at the center / no selection): leave the menu open for a tap.
}

// ---- Color palette ----
// `colors` defaults to the neon zone palette (circles/hexagons); pass
// BUTTON_COLORS for a connector switch block instead (see radial.color above).
function openPalette(x, y, zone, colors = COLORS) {
  const pal = document.getElementById('palette');
  pal.innerHTML = '';
  pal.style.left = Math.min(x, window.innerWidth - 150) + 'px';
  pal.style.top = Math.min(y, window.innerHeight - 130) + 'px';
  pal.classList.remove('hidden');
  colors.forEach((col) => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = col;
    sw.addEventListener('mousedown', (ev) => ev.stopPropagation());
    sw.addEventListener('touchstart', (ev) => ev.stopPropagation());
    sw.addEventListener('click', (ev) => { ev.stopPropagation(); zone.color = col; scheduleSave(); closeMenus(); });
    pal.appendChild(sw);
  });
  armCloseOnce();
}

function armCloseOnce() {
  setTimeout(() => {
    document.addEventListener('mousedown', closeMenusOnce, { once: true });
    document.addEventListener('touchstart', closeMenusOnce, { once: true });
  }, 0);
}
function closeMenusOnce() { closeMenus(); }
function closeMenus() {
  document.getElementById('radial').classList.add('hidden');
  document.getElementById('palette').classList.add('hidden');
  document.getElementById('boardpicker').classList.add('hidden');
  radialPressActive = false; radialItems = []; radialHoverIdx = -1;
  document.removeEventListener('mousedown', closeMenusOnce);
  document.removeEventListener('touchstart', closeMenusOnce);
}

// ---- Board picker (create a link to another board) ----
// Picking a liaison is a separate, explicit choice from picking the target
// board -- previously the link's peer was silently inherited from whichever
// liaison happened to be currently connected (or the board's last-used one),
// which meant the only way to point a link at a different liaison was to
// hand-edit the generated URL. selectedLiaisonPeer holds that choice for the
// lifetime of one picker session; undefined = not decided yet (defaults to
// the current connection), null = explicitly "no liaison / local board".
let selectedLiaisonPeer;

function openBoardPicker(wx, wy, target) {
  closeMenus();
  pendingBoardPos = { x: wx, y: wy };
  pendingBoardTarget = target || null; // if provided: transforms this block into a link
  selectedLiaisonPeer = hostId() || null;
  const bp = document.getElementById('boardpicker');
  bp.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'bp-title';
  title.textContent = t('boardPicker.title');
  bp.appendChild(title);

  // Liaison choice: which peer (if any) the link should carry.
  const liaisonLabel = document.createElement('div');
  liaisonLabel.className = 'bp-title';
  liaisonLabel.textContent = t('boardPicker.liaison');
  bp.appendChild(liaisonLabel);
  const liaisonRows = [];
  const addLiaisonRow = (label, peer) => {
    const row = document.createElement('div');
    row.className = 'bp-row bp-liaison-row';
    row.textContent = label;
    if (peer === selectedLiaisonPeer) row.classList.add('bp-selected');
    row.addEventListener('click', () => {
      selectedLiaisonPeer = peer;
      liaisonRows.forEach((r) => r.el.classList.toggle('bp-selected', r.peer === peer));
    });
    liaisonRows.push({ el: row, peer });
    bp.appendChild(row);
  };
  const currentHost = hostId();
  if (currentHost) addLiaisonRow(t('boardPicker.liaisonCurrent'), currentHost);
  listLiaisons().filter((l) => l.peer !== currentHost).forEach((l) => addLiaisonRow(l.name || l.peer, l.peer));
  addLiaisonRow(t('boardPicker.liaisonNone'), null);

  // Create a new board.
  const newRow = document.createElement('div');
  newRow.className = 'bp-new';
  const inp = document.createElement('input');
  inp.maxLength = 40; inp.placeholder = t('boardPicker.newPlaceholder');
  const okb = document.createElement('button');
  okb.textContent = '+';
  newRow.appendChild(inp); newRow.appendChild(okb);
  bp.appendChild(newRow);
  const createNew = () => { const nm = inp.value.trim(); if (nm) createBoardLink(genBoardId(), nm, selectedLiaisonPeer); };
  okb.addEventListener('click', createNew);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') createNew(); });

  // Already-visited boards.
  const cur = getBoardId();
  const visited = listBoards().filter((b) => b.id !== cur);
  if (!visited.length) {
    const empty = document.createElement('div');
    empty.className = 'bp-empty';
    empty.textContent = t('boardPicker.empty');
    bp.appendChild(empty);
  }
  visited.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'bp-row';
    row.textContent = reservedBoardLabel(b.id, t) || b.name || b.id;
    row.addEventListener('click', () => createBoardLink(b.id, b.name, selectedLiaisonPeer));
    bp.appendChild(row);
  });

  bp.classList.remove('hidden');
  armCloseOnce();
  setTimeout(() => inp.focus(), 50);
}

function createBoardLink(targetId, name, peer) {
  closeMenus();
  const url = buildBoardUrl(targetId, peer); // origin-less; resolves against whichever page it's clicked from
  if (pendingBoardTarget) {
    // Transforms the existing block into a link to the board (keeps its text if any).
    const t = pendingBoardTarget; pendingBoardTarget = null;
    t.link = url;
    if (!t.text) t.text = name || targetId;
    state.selected = t.id;
  } else {
    const pos = pendingBoardPos || screenToWorld(lastMouse.x, lastMouse.y);
    const n = addRect(pos.x - 80, pos.y - 30, name || targetId);
    n.w = 160; n.link = url;
    reset(n);
    state.selected = n.id;
  }
  recordBoard(targetId, name, peer);
  scheduleSave();
}

// ---- Image popup ----
function openImagePopup(ref) {
  closeMenus();
  const pop = document.getElementById('imgpopup');
  pop.classList.add('show');
  resolveSrc(ref).then((src) => { if (src) pop.querySelector('img').src = src; });
}
function closeImagePopup() {
  document.getElementById('imgpopup').classList.remove('show');
}

// ---- Text editing ----
// target = element being edited (for a link: its source); posNode = element to hover over.
function startEdit(type, target, posNode) {
  posNode = posNode || target;
  closeMenus();
  editing = { type, id: target.id };
  const ed = document.getElementById('editor');
  const z = state.camera.zoom;

  if (type === 'rect') {
    const p = worldToScreen(posNode.x, posNode.y);
    ed.style.left = p.x + 'px';
    ed.style.top = p.y + 'px';
    ed.style.width = (posNode.w * z) + 'px';
    ed.style.height = (posNode.h * z) + 'px';
    ed.value = target.text || '';
  } else {
    const p = worldToScreen(posNode.x, posNode.y - posNode.r);
    const wpx = 220;
    ed.style.left = (p.x - wpx / 2) + 'px';
    ed.style.top = p.y + 'px';
    ed.style.width = wpx + 'px';
    ed.style.height = '40px';
    ed.value = target.description || '';
  }
  ed.style.fontSize = Math.max(8, Math.min(18, 11 * z)) + 'px';
  ed.classList.add('show');
  document.getElementById('editDone').classList.add('show');
  ed.focus();
  ed.select();
}

// A .ics url (pasted as text or set as a link) turns the block into a week
// calendar (render.js): give it room to be readable right away (still freely
// resizable afterwards).
function growForIcs(target, value) {
  if (!value || !isIcsUrl(value) || target.ref) return;
  if ((target.w || 0) < 340) target.w = 340;
  if ((target.h || 0) < 260) target.h = 260; // agenda layout: room for all 7 day headings + a line each
  reset(target);
}

// Clickable-link editor: a proper modal instead of the tiny on-canvas editor
// (which shrinks to an unreadable font at low zoom and is barely 40px tall --
// fine for a block's own text, useless for pasting/checking a URL).
function openLinkEditor(target) {
  closeMenus();
  const m = document.createElement('div');
  m.className = 'recmodal';
  m.innerHTML = '<div class="connector-card">'
    + '<div class="connector-title">' + t('linkEditor.title') + '</div>'
    + '<input type="text" class="link-input" placeholder="' + t('linkEditor.placeholder') + '">'
    + '<div class="connector-actions">'
    + '<button class="connector-save">' + t('connector.save') + '</button>'
    + (target.link ? '<button class="link-remove">' + t('linkEditor.remove') + '</button>' : '')
    + '<button class="connector-cancel">' + t('connector.cancel') + '</button>'
    + '</div></div>';
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);
  const inp = m.querySelector('.link-input');
  inp.value = target.link || '';
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  const save = () => {
    const v = inp.value.trim();
    // A pasted full board URL (e.g. copied from the address bar) is
    // corrected back to the origin-less form -- see boards.js: buildBoardUrl.
    const bu = v ? parseBoardUrl(v) : null;
    if (bu) target.link = buildBoardUrl(bu.id, bu.peer);
    else if (v) target.link = v;
    else delete target.link;
    growForIcs(target, v);
    scheduleSave();
    m.remove();
  };
  m.querySelector('.connector-save').addEventListener('click', save);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const rm = m.querySelector('.link-remove');
  if (rm) rm.addEventListener('click', () => { delete target.link; scheduleSave(); m.remove(); });
  m.querySelector('.connector-cancel').addEventListener('click', () => m.remove());
}

// Generic Yes/Cancel confirmation modal (reuses the connector-card chrome).
function openConfirmModal(title, body, onConfirm) {
  closeMenus();
  const m = document.createElement('div');
  m.className = 'recmodal';
  m.innerHTML = '<div class="connector-card">'
    + '<div class="connector-title">' + title + '</div>'
    + '<div class="confirm-body">' + body + '</div>'
    + '<div class="connector-actions">'
    + '<button class="connector-danger">' + t('connector.confirmDelete') + '</button>'
    + '<button class="connector-cancel">' + t('connector.cancel') + '</button>'
    + '</div></div>';
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);
  m.querySelector('.connector-danger').addEventListener('click', () => { m.remove(); onConfirm(); });
  m.querySelector('.connector-cancel').addEventListener('click', () => m.remove());
}

// Deletes a board-link block from the built-in "boards" directory: unlike a
// normal rectangle, this destroys real data (the board's saved content), so
// -- per the user's request -- it goes through a confirmation modal instead
// of the usual no-questions-asked delete.
function deleteBoardBlock(node) {
  const bu = parseBoardUrl(node.link);
  if (!bu) return;
  const label = reservedBoardLabel(bu.id, t) || node.text || bu.id;
  openConfirmModal(t('boardsView.deleteTitle'), t('boardsView.deleteBody', { name: label }), () => {
    deleteBoardData(bu.id);
    removeById(node.id);
    scheduleSave();
  });
}

// Deleting a liaison circle also forgets that liaison entirely (not just the
// visual grouping) -- the circle only exists here as a stand-in for a real
// liaison (js/main.js: loadBoardsDirectory), so removing it and keeping the
// liaison around would be confusing (it'd just reappear on the next open).
function deleteLiaisonCircle(circle) {
  const label = circle.description || circle.peer;
  openConfirmModal(t('boardsView.deleteLiaisonTitle'), t('boardsView.deleteLiaisonBody', { name: label }), () => {
    if (circle.peer) removeLiaison(circle.peer);
    removeById(circle.id);
    scheduleSave();
  });
}

function commitEdit() {
  if (!editing) return;
  const ed = document.getElementById('editor');
  const target = findById(editing.id);
  let openMenuFor = null;
  if (target) {
    if (editing.type === 'rect') {
      target.text = ed.value;
      growForIcs(target, ed.value.trim());
      // Left empty (clicked away without typing anything): assume a plain
      // text rectangle isn't actually what's wanted here -- the radial menu
      // is the fastest way to turn it into a link, an image, a connector...
      if (!target.text.trim() && !target.image) openMenuFor = target;
    }
    else target.description = ed.value.replace(/\n/g, ' ').trim();
    scheduleSave();
  }
  editing = null;
  ed.classList.remove('show');
  document.getElementById('editDone').classList.remove('show');
  if (openMenuFor) {
    const p = worldToScreen(openMenuFor.x + openMenuFor.w / 2, openMenuFor.y + openMenuFor.h / 2);
    openContextAt(p.x, p.y);
  }
}

// Escape: closes the editor or the image popup.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (editing) { e.preventDefault(); document.getElementById('editor').blur(); }
  closeImagePopup();
});
