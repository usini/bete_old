// Shared data model + localStorage persistence.
import { pointInHex } from './geom.js?v=msa0jvj9';
import { getUserId } from './users.js?v=msa0jvj9';
import { parseBoardUrl, buildBoardUrl } from './boards.js?v=msa0jvj9';

export const DEFAULT_GREEN = '#39ff14';

// Color presets (neon green + Xbox-style accents).
export const COLORS = [
  '#39ff14', // nuclear green
  '#107c10', // Xbox green
  '#00b7eb', // cyan
  '#e3008c', // magenta
  '#ff8c00', // orange
  '#9b30ff', // purple
  '#ffd400', // yellow
  '#f2f2f2', // off-white
];

// Color presets for connector "switch" (button) blocks -- plain named colors
// rather than the neon zone palette above, since these are meant to read as
// an actual painted button. See effectiveColor(): a containing circle/hexagon
// still supplants this (same rule as rectangles).
export const BUTTON_COLORS = [
  '#ff8c00', // orange
  '#e6342a', // red
  '#1a1a1a', // black
  '#8e3ee6', // purple
  '#2266dd', // blue
  '#2fa84f', // green
  '#f2c200', // yellow
  '#f2f2f2', // white
  '#7a4a2b', // brown
];

// Storage key per board (multi-boards). 'home' = default personal page.
let _boardId = 'home';
let _boardName = '';
let storageKey = 'bete:home';
export function setBoardId(id) { _boardId = id || 'home'; storageKey = 'bete:' + _boardId; }
export function getBoardId() { return _boardId; }
export function setBoardName(n) { _boardName = n || ''; }
export function getBoardName() { return _boardName; }

// Live app state. Fields prefixed with _ are never serialized.
export const state = {
  version: 1,
  camera: { x: 0, y: 0, zoom: 1 },
  // rectangles: { id, x, y, w, h, text, image } -- or link: { id, x, y, w, h, ref }
  nodes: [],
  circles: [],  // circles  : { id, x, y, r, color, description }
  hexagons: [], // hexagons : { id, x, y, r, color, description }
  selected: null, // selected id (rect, circle or hexagon)
  selectedIds: [], // multi-selection (rectangle ids) to move/delete as a group
  readOnly: false, // board-level: only the host/owner may edit while a guest is connected
};

let _id = 1;
export function newId() { return 'n' + (_id++).toString(36) + Date.now().toString(36); }

// ---- Element creation ----
export function addRect(wx, wy, text = '') {
  const n = { id: newId(), x: wx, y: wy, w: 150, h: 70, text };
  state.nodes.push(n);
  return n;
}

export function addCircle(wx, wy, color = COLORS[1]) {
  const c = { id: newId(), x: wx, y: wy, r: 160, color, description: '' };
  state.circles.push(c);
  return c;
}

export function addHexagon(wx, wy, color = COLORS[4]) {
  const h = { id: newId(), x: wx, y: wy, r: 170, color, description: '' };
  state.hexagons.push(h);
  return h;
}

// IoT/HTTP connector block (triangle by default): talks to a device via a
// small YAML program (see connector.js). 'display' picks the visual skin
// ('triangle' generic, 'switch' on/off toggle) independently of the yaml,
// so the same config can be shown differently per device without editing it.
// creatorUid: stamped once at creation, never touched again -- only this
// user may enable/disable network-bridge mode (see connector.js/input.js),
// since that's what exposes the switch to peers who don't have the yaml.
export function addConnector(wx, wy) {
  const n = { id: newId(), x: wx, y: wy, w: 150, h: 130, kind: 'connector', yaml: '', display: 'triangle', creatorUid: getUserId(), bridge: false };
  state.nodes.push(n);
  return n;
}

export function findById(id) {
  return state.nodes.find(n => n.id === id)
    || state.circles.find(c => c.id === id)
    || state.hexagons.find(h => h.id === id)
    || null;
}

export function removeById(id) {
  // Removes the element + any link pointing to it (cascade).
  state.nodes = state.nodes.filter(n => n.id !== id && n.ref !== id);
  state.circles = state.circles.filter(c => c.id !== id);
  state.hexagons = state.hexagons.filter(h => h.id !== id);
  if (state.selected === id) state.selected = null;
  if (state.selectedIds.length) state.selectedIds = state.selectedIds.filter(x => x !== id);
}

// ---- Links (rectangles inside a hexagon) ----
// A link's source is always a real rectangle (never another link).
export function sourceOf(node) {
  if (!node.ref) return null;
  return state.nodes.find(n => n.id === node.ref && !n.ref) || null;
}
export function displayText(node) {
  if (node.ref) { const s = sourceOf(node); return s ? s.text : ''; }
  return node.text;
}
export function displayImage(node) {
  if (node.ref) { const s = sourceOf(node); return s ? s.image : null; }
  return node.image;
}
export function displayLink(node) {
  if (node.ref) { const s = sourceOf(node); return s ? s.link : undefined; }
  return node.link;
}

// ---- Effective color of a rectangle ----
// Link: color of its source (hence of the source's circle). Otherwise: the
// node's own chosen color if it has one (see BUTTON_COLORS -- connector
// switch blocks), else the default; then a containing circle/hexagon
// (z-order) always supplants either one, same as for a plain rectangle.
export function effectiveColor(node) {
  if (node.ref) {
    const src = sourceOf(node);
    return src ? effectiveColor(src) : DEFAULT_GREEN;
  }
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  let color = node.color || DEFAULT_GREEN;
  for (const c of state.circles) {
    const dx = cx - c.x, dy = cy - c.y;
    if (dx * dx + dy * dy <= c.r * c.r) color = c.color;
  }
  for (const h of state.hexagons) {
    if (pointInHex(cx, cy, h.x, h.y, h.r)) color = h.color;
  }
  return color;
}

// ---- Serialization ----
export function serialize() {
  return {
    version: state.version,
    name: _boardName || undefined,
    readOnly: state.readOnly || undefined,
    camera: { ...state.camera },
    nodes: state.nodes
      .filter(n => n.kind !== 'liaison') // liaison blocks are transient
      .map(n => {
        if (n.ref) return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, ref: n.ref };
        if (n.kind === 'voice') return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, kind: 'voice', dur: n.dur || 0 }; // audio in IndexedDB
        if (n.kind === 'connector') {
          return {
            id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, kind: 'connector', yaml: n.yaml || '',
            display: n.display || 'triangle', clockFormat: n.clockFormat || 'HH:MM:SS',
            creatorUid: n.creatorUid || null, bridge: !!n.bridge, color: n.color || undefined,
            // Clock display, stopwatch/countdown modes only:
            stopwatchStart: n.stopwatchStart || undefined, stopwatchElapsed: n.stopwatchElapsed || undefined,
            countdownTarget: n.countdownTarget || undefined,
          };
        }
        return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, text: n.text, image: n.image || undefined, link: n.link || undefined, color: n.color || undefined, kind: n.kind === 'pancarte' ? 'pancarte' : undefined };
      }),
    circles: state.circles.map(c => ({
      id: c.id, x: c.x, y: c.y, r: c.r, color: c.color, description: c.description || '',
    })),
    hexagons: state.hexagons.map(h => ({
      id: h.id, x: h.x, y: h.y, r: h.r, color: h.color, description: h.description || '',
    })),
  };
}

export function load(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.name != null) _boardName = obj.name;
  state.readOnly = !!obj.readOnly;
  state.camera = obj.camera ? { ...obj.camera } : { x: 0, y: 0, zoom: 1 };
  state.nodes = Array.isArray(obj.nodes) ? obj.nodes.map(n => ({ ...n })) : [];
  state.circles = Array.isArray(obj.circles) ? obj.circles.map(c => ({ ...c })) : [];
  state.hexagons = Array.isArray(obj.hexagons) ? obj.hexagons.map(h => ({ ...h })) : [];
  // Prunes orphan links (source gone).
  state.nodes = state.nodes.filter(n => !n.ref || state.nodes.some(m => m.id === n.ref && !m.ref));
  // Corrects legacy board links that still carry a full origin (old exports,
  // boards synced before buildBoardUrl dropped it) back to the origin-less
  // form, so they keep working after an import/fork on a different domain.
  for (const n of state.nodes) {
    if (!n.link) continue;
    const bu = parseBoardUrl(n.link);
    if (bu) n.link = buildBoardUrl(bu.id, bu.peer);
  }
  state.selected = null;
  state.selectedIds = [];
  // Avoids id collisions after import.
  _id = Math.max(1, state.nodes.length + state.circles.length + state.hexagons.length) + (Date.now() % 1000);
  return true;
}

// ---- localStorage persistence (throttled) + undo history ----
let _saveTimer = null;
let _saveSuppressed = false;
// When opening a file via ?file=, we don't overwrite the personal localStorage.
export function setSaveSuppressed(v) { _saveSuppressed = v; }

let _undoStack = [];        // previous serialized states (for undo)
let _lastSaved = null;      // last saved state (JSON)
let _applyingUndo = false;
const UNDO_MAX = 25;

// Sets the reference state (after loading): the 1st edit becomes undoable.
export function initUndoBaseline() {
  _lastSaved = JSON.stringify(serialize());
  _undoStack = [];
}

function commitSave() {
  const cur = JSON.stringify(serialize());
  if (cur === _lastSaved) return;
  if (!_applyingUndo && _lastSaved != null) {
    _undoStack.push(_lastSaved);
    if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  }
  _lastSaved = cur;
  try { localStorage.setItem(storageKey, cur); } catch (e) { /* quota */ }
}

export function scheduleSave() {
  if (_saveSuppressed || _saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; commitSave(); }, 400);
}

export function canUndo() { return _undoStack.length > 0; }

// Undoes the last change (reverts to the previous state).
export function undo() {
  if (!_undoStack.length) return false;
  const prev = _undoStack.pop();
  const cam = { ...state.camera }; // undo must not move the view
  _applyingUndo = true;
  load(JSON.parse(prev));
  state.camera = cam;
  _applyingUndo = false;
  _lastSaved = prev;
  try { localStorage.setItem(storageKey, prev); } catch (e) { /* */ }
  return true;
}

export function restore() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return load(JSON.parse(raw));
  } catch (e) { /* corrupted */ }
  return false;
}
