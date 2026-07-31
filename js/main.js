// Bootstrap + render loop.
import { state, addRect, load, setSaveSuppressed, scheduleSave, newId, setBoardId, setBoardName, getBoardName, initUndoBaseline, restore, COLORS } from './state.js?v=ms8kvlur';
import { setView } from './camera.js?v=ms8kvlur';
import { render } from './render.js?v=ms8kvlur';
import { step, reset } from './physics.js?v=ms8kvlur';
import * as minimap from './minimap.js?v=ms8kvlur';
import * as input from './input.js?v=ms8kvlur';
import * as fx from './fx.js?v=ms8kvlur';
import { joinOrHost, getNetMode, liaisonStatus, disconnect, getUserCount, getPresence } from './sync.js?v=ms8kvlur';
import { recordBoard, getBoardEntry, listBoards, buildBoardUrl, parseBoardUrl, reservedBoardLabel } from './boards.js?v=ms8kvlur';
import { TUTORIAL_FR, TUTORIAL_EN } from './tutorial.js?v=ms8kvlur';
import { applyTheme } from './theme.js?v=ms8kvlur';
import { initSettings, openSettings } from './settings.js?v=ms8kvlur';
import { recordLiaison, getLiaison, listLiaisons } from './liaisons.js?v=ms8kvlur';
import { positionVideoOverlay } from './video.js?v=ms8kvlur';
import { toggleMic, isMicOn, toggleListen, isListenOn } from './voicechat.js?v=ms8kvlur';
import { migrateImages } from './images.js?v=ms8kvlur';
import { restoreAudio } from './voice.js?v=ms8kvlur';
import { ensureTodaySnapshot } from './history.js?v=ms8kvlur';
import { pollConnector } from './connector.js?v=ms8kvlur';
import { t, getLang, applyStaticI18n } from './i18n.js?v=ms8kvlur';
import { initDesktopLink, checkWebUpdate, isDesktop, getExportFolder, setExportFolder, pickExportFolder } from './platform.js?v=ms8kvlur';
import { checkForUpdate } from './update.js?v=ms8kvlur';
import { exportAllBoardsToPath } from './io.js?v=ms8kvlur';

applyTheme(); // apply the saved theme right at startup
applyStaticI18n(); // translate the static HTML chrome (buttons, hint, etc.)
initDesktopLink(); // no-op on the web build; resolves the LAN address on desktop
checkForUpdate(); // no-op on the web build; offers to install a newer desktop release (Rust/plugin changes)
// no-op on the web build; hot-updates js/css/html only, no reinstall needed.
// The download itself runs off the main thread (Rust: spawn_blocking) so it
// doesn't freeze the window, but a page reload with zero warning still reads
// as "did this just crash?" -- so a brief toast announces it first.
checkWebUpdate(() => toast(t('update.webApplying'), 1500));
if (isDesktop) initExportOnExit(); // no-op on the web build (tab close can't be intercepted/exported anyway)

// Exports every board to a remembered folder right before the window
// actually closes -- the first time, there's nothing to remember yet, so
// this doubles as the "pick your default folder" prompt. Cancelling the
// picker (or the export itself failing) never blocks the close -- this is a
// convenience backup, not a save confirmation the user has to get past.
const WINDOW_MOD = 'https://esm.sh/@tauri-apps/api@2/window';
async function initExportOnExit() {
  let win;
  try {
    const { getCurrentWindow } = await import(WINDOW_MOD);
    win = getCurrentWindow();
  } catch (e) { console.error('Bete: failed to load window API', e); return; }
  win.onCloseRequested(async (event) => {
    event.preventDefault();
    try {
      let dir = getExportFolder();
      if (!dir) { dir = await pickExportFolder(); if (dir) setExportFolder(dir); }
      if (dir) await exportAllBoardsToPath(dir);
    } catch (e) {
      console.error('Bete: export-on-exit failed', e);
    }
    win.destroy();
  });
}

let toastTimer = null;
export function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Shown when the liaison keeps flapping (see sync.js noteReconnectCycle): a
// toast would auto-hide and go unnoticed, so this is a persistent popup with
// an explicit action instead.
function showReconnectLoopPopup() {
  const el = document.getElementById('reconnectpopup');
  if (el) el.classList.remove('hidden');
}

const board = document.getElementById('board');
const ctx = board.getContext('2d');
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  board.width = Math.floor(w * dpr);
  board.height = Math.floor(h * dpr);
  board.style.width = w + 'px';
  board.style.height = h + 'px';
  setView(w, h);
}

window.addEventListener('resize', resize);
resize();


// ---- Board selection (multi-boards) ----
function sanitizeId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
}
const params = new URLSearchParams(location.search);
const idParam = params.get('id');
const peerId = params.get('peer');
const fileUrl = params.get('file');

// First launch: send the user to the tutorial (afterwards the app lives on home).
const REDIRECT = !localStorage.getItem('bete:seen') && !idParam && !peerId && !fileUrl;
if (REDIRECT) {
  try { localStorage.setItem('bete:seen', '1'); } catch (e) { /* */ }
  recordBoard('home', 'Home', null);
  recordBoard('tutorial', 'Tutorial', null);
  location.replace(location.pathname + '?id=tutorial');
}

let boardId = 'home';

if (!REDIRECT) {
  if (idParam) boardId = sanitizeId(idParam);
  else if (peerId) boardId = 'peer-' + sanitizeId(peerId);
  else boardId = 'home';
  setBoardId(boardId);

  if (boardId === 'tutorial') {
    load(getLang() === 'fr' ? TUTORIAL_FR : TUTORIAL_EN); // built-in board, read-only
    setSaveSuppressed(true);
    state.nodes.forEach(reset);
  } else if (boardId === 'boards') {
    loadBoardsDirectory(); // built-in board, regenerated on every open -- not user-editable
    setSaveSuppressed(true);
    state.nodes.forEach(reset);
  } else if (peerId && boardId !== 'home') {
    const isNew = !restore();
    if (isNew) { seedHomeLink(); scheduleSave(); }
    state.nodes.forEach(reset);
    recordLiaison(peerId); // remembers the active liaison; its display name arrives via sync (see sync.js: merge())
    toast(t('toast.connecting'));
    joinOrHost(peerId, (st) => {
      if (st === 'host') toast(t('toast.noHost'), 3500);
      else if (st === 'synced') toast(t('toast.synced'));
      else if (st === 'connected') toast(t('toast.connectedReceiving'));
      else if (st === 'error') toast(t('toast.unreachable'), 4000);
      else if (st === 'closed') toast(t('toast.hostDisconnected'), 4000);
      else if (st === 'loop') showReconnectLoopPopup();
    });
  } else if (fileUrl) {
    setSaveSuppressed(true);
    loadFromUrl(fileUrl);
    state.nodes.forEach(reset);
  } else {
    // Home is sanctuarized: never connected (so it can't be overwritten).
    if (peerId && boardId === 'home') toast(t('toast.homeLocal'), 3500);
    if (!restore() && boardId !== 'home') { seedHomeLink(); scheduleSave(); }
    if (boardId === 'home') ensureBoardsLinkOnHome();
    state.nodes.forEach(reset);
  }

  // Board name: serialized > ?name= > history > default. Then display + history.
  resolveBoardName(boardId);
  recordBoard(boardId, getBoardName(), (boardId !== 'home' && peerId) || null);
  applyBoardNameUI();
  initUndoBaseline(); // reference state for undo

  // Daily history snapshot (see history.js): mirrors today's starting state
  // once per calendar day, before any of today's edits (or an incoming peer
  // sync) can touch it. Not on the tutorial (read-only) or the regenerated
  // "boards" directory (never persisted content, nothing meaningful to keep).
  if (boardId !== 'tutorial' && boardId !== 'boards') ensureTodaySnapshot(boardId).catch(() => {});

  // Soft migration of legacy images (inline base64 -> IndexedDB ref): lightens
  // localStorage AND sync. Not on the tutorial (read-only). Best-effort, in the background.
  if (boardId !== 'tutorial') migrateImages(state.nodes, scheduleSave).catch(() => {});
  // Same for a voice memo's inlined audio (see voice.js: restoreAudio) -- needed
  // here too (not just io.js: importJSON) because a bulk restore (importAllBoards)
  // writes each board's raw JSON straight to localStorage without loading it, so
  // any inlined audioData only gets pulled back into IndexedDB once that board
  // is actually opened.
  if (boardId !== 'tutorial') restoreAudio(state.nodes).catch(() => {});

  // Starts polling every connector block already on this board (each device polls independently).
  for (const n of state.nodes) if (n.kind === 'connector') pollConnector(n).catch(() => {});
}

// Resolves and applies the displayed board name. No URL fallback anymore
// (see sync.js: a board/liaison's name is now learned from the P2P sync
// payload itself, like the rest of the content) -- just what's already
// saved locally, or the raw id until a sync (or a manual rename) fills it in.
// Deliberately does NOT setBoardName(id) when nothing is actually known: the
// id is only ever a DISPLAY fallback (below, and in applyBoardNameUI) -- if
// it were persisted as the real name, it would get serialized/exported and
// sent out as this board's `bn` on the very next sync, and a peer (or a
// headless host with no name of its own yet) has no way to tell that apart
// from a real one someone actually chose (see sync.js/bete-host.js: merge()).
function resolveBoardName(id) {
  const known = reservedBoardLabel(id, t) || getBoardName() || (getBoardEntry(id) && getBoardEntry(id).name);
  if (known) setBoardName(known);
  document.title = 'Bete' + (id === 'home' ? '' : ' · ' + (known || id));
}

function applyBoardNameUI() {
  const el = document.getElementById('boardname');
  el.textContent = getBoardName() || boardId; // display-only fallback -- see resolveBoardName
  const editable = boardId !== 'home' && boardId !== 'tutorial' && boardId !== 'boards';
  el.classList.toggle('editable', editable);
  if (editable && !el._wired) { el._wired = true; el.addEventListener('click', beginRenameBoard); }
}

// Called by sync.js once a name arrives over the wire for a board we didn't
// already have one for (see merge(): adopted only when getBoardName() was
// empty) -- refreshes the title bar and tab title to reflect it right away,
// since resolveBoardName/applyBoardNameUI above only run once at boot.
export function refreshBoardNameUI() {
  document.title = 'Bete' + (boardId === 'home' ? '' : ' · ' + getBoardName());
  applyBoardNameUI();
}

function beginRenameBoard() {
  const el = document.getElementById('boardname');
  if (el.getAttribute('contenteditable') === 'true') return;
  el.setAttribute('contenteditable', 'true');
  el.focus();
  const range = document.createRange(); range.selectNodeContents(el);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { el.textContent = getBoardName() || boardId; el.blur(); }
  };
  const commit = () => {
    el.removeAttribute('contenteditable');
    el.removeEventListener('blur', commit);
    el.removeEventListener('keydown', onKey);
    const nm = (el.textContent || '').replace(/\n/g, ' ').trim().slice(0, 40) || getBoardName() || boardId;
    setBoardName(nm); el.textContent = nm;
    document.title = 'Bete · ' + nm;
    recordBoard(boardId, nm, peerId || null);
    scheduleSave();
  };
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', commit);
}

async function loadFromUrl(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!load(await res.json())) throw new Error('Invalid JSON');
    state.nodes.forEach(reset);
  } catch (err) {
    console.warn('Bete: failed to load', url, err);
    // Fallback: localStorage (re-enable saving); nothing to seed for home.
    setSaveSuppressed(false);
    restore();
    state.nodes.forEach(reset);
  }
}

// Any board opened for the very first time (never saved locally) gets a way
// back: a plain link block to Home. Home itself never needs this (it's the
// hub), and it's skipped when restore() succeeded (an existing board keeps
// whatever the user already has, even if they later deleted this link).
function seedHomeLink() {
  const n = addRect(-80, -140, '🛖 ' + t('board.home'));
  n.w = 160;
  n.link = buildBoardUrl('home');
  reset(n);
}

// Home always gets a link to the built-in "Boards" directory (idempotent --
// checked/added on every Home load, not just when seeding fresh content, so
// it also reaches existing Home boards created before this feature existed).
function ensureBoardsLinkOnHome() {
  const already = state.nodes.some((n) => !n.ref && n.link && (parseBoardUrl(n.link) || {}).id === 'boards');
  if (already) return;
  const n = addRect(150, -140, '🗂 ' + t('board.boards'));
  n.w = 160;
  n.link = buildBoardUrl('boards');
  reset(n);
  scheduleSave();
}

// Built-in "Boards" directory: a link block per known board, laid out in a
// grid. Regenerated on every open (setSaveSuppressed keeps edits from
// persisting) so it always reflects the current board list.
// Boards grouped by liaison: one circle per known liaison (the peer they're
// tied to -- see recordBoard's `peer` field), board-link blocks placed
// inside the matching circle, anything without a (recognized) liaison in a
// plain grid below. Dragging a block in/out of a circle re-pairs it with
// that liaison (js/input.js: finishDrag), deleting a circle forgets that
// liaison entirely (js/input.js: deleteLiaisonCircle) -- the circle's
// `.peer` is an in-memory-only field (this whole board is regenerated on
// every open, see setSaveSuppressed in the caller, so it never needs to
// round-trip through serialize()'s field whitelist).
function loadBoardsDirectory() {
  const BOARD_GAP_X = 170, BOARD_GAP_Y = 90;
  const list = listBoards().filter((b) => b.id !== 'boards');
  const liaisons = listLiaisons();
  const peerSet = new Set(liaisons.map((l) => l.peer));

  const grouped = new Map(); // peer -> boards[]
  const ungrouped = [];
  list.forEach((b) => {
    if (b.peer && peerSet.has(b.peer)) { if (!grouped.has(b.peer)) grouped.set(b.peer, []); grouped.get(b.peer).push(b); }
    else ungrouped.push(b);
  });

  const boardNode = (b, x, y) => ({ id: newId(), x: x - 80, y: y - 35, w: 160, h: 70, text: reservedBoardLabel(b.id, t) || b.name || b.id, link: buildBoardUrl(b.id, b.peer) });

  // Each circle is sized to actually contain its grid of boards (a fixed
  // radius either clipped a big group or left a lone board looking lost in
  // a huge empty circle) -- roughly square grid, radius = the grid's own
  // half-diagonal plus padding for the description label drawn just above it.
  const circles = [];
  const nodes = [];
  let cx = 0;
  liaisons.forEach((l, i) => {
    const boards = grouped.get(l.peer) || [];
    const n = Math.max(boards.length, 1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const r = Math.max(150, Math.hypot(cols * BOARD_GAP_X, rows * BOARD_GAP_Y) / 2 + 30);
    if (i > 0) cx += circles[i - 1].r + r + 50;
    const c = { id: newId(), x: cx, y: 0, r, color: COLORS[(i % (COLORS.length - 1)) + 1], description: l.name || l.peer };
    c.peer = l.peer;
    circles.push(c);
    boards.forEach((b, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      nodes.push(boardNode(b, c.x + (col - (cols - 1) / 2) * BOARD_GAP_X, c.y + (row - (rows - 1) / 2) * BOARD_GAP_Y));
    });
  });

  const cols2 = 4, gapX2 = 190, gapY2 = 100;
  const baseY = circles.length ? Math.max(...circles.map((c) => c.r)) + 130 : -100;
  ungrouped.forEach((b, i) => {
    const col = i % cols2, row = Math.floor(i / cols2);
    nodes.push(boardNode(b, (col - (cols2 - 1) / 2) * gapX2, baseY + row * gapY2));
  });

  load({ version: 1, camera: { x: 0, y: 0, zoom: 1 }, nodes, circles, hexagons: [] });
}

if (!REDIRECT) {
  minimap.init();
  input.init(board, () => { state.nodes.forEach(reset); });
  initSettings();
  const vbtn = document.getElementById('voicebtn');
  if (vbtn) {
    const tog = async (e) => { e.preventDefault(); e.stopPropagation(); await toggleMic(); vbtn.classList.toggle('on', isMicOn()); };
    vbtn.addEventListener('mousedown', tog);
    vbtn.addEventListener('touchstart', tog);
  }
  const spk = document.getElementById('speakerbtn');
  if (spk) {
    const tog = (e) => { e.preventDefault(); e.stopPropagation(); toggleListen(); spk.classList.toggle('off', !isListenOn()); };
    spk.addEventListener('mousedown', tog);
    spk.addEventListener('touchstart', tog);
  }
  const rpRefresh = document.getElementById('reconnectRefresh');
  if (rpRefresh) rpRefresh.addEventListener('click', () => location.reload());
  const rpDismiss = document.getElementById('reconnectDismiss');
  if (rpDismiss) rpDismiss.addEventListener('click', () => document.getElementById('reconnectpopup').classList.add('hidden'));

  // Debug handle (console inspection: bete.state).
  window.bete = { state, fx };
  requestAnimationFrame(loop);
}

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;

  // Rectangle physics + particles.
  for (const n of state.nodes) step(n, dt);
  fx.update(dt);

  // Render the board (in CSS px coordinates thanks to the DPR scale).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  render(ctx);
  fx.render(ctx);

  minimap.render();
  updateNetMode();
  updateLiaisonBadge();
  input.updateHint(); // reflects a read-only lock/unlock received from the host at any time
  positionVideoOverlay(); // realigns the inline YouTube player on its block
  requestAnimationFrame(loop);
}

// "Who's talking" banner: list of participants with the mic active.
let lastSpeakers = '';
function updateSpeakers(connected) {
  const el = document.getElementById('speakers');
  if (!el) return;
  const talkers = connected ? getPresence().filter((u) => u.voice).map((u) => (u.me ? t('liaison.you') : (u.name || t('liaison.guest')))) : [];
  const sig = talkers.join(',');
  if (sig === lastSpeakers) return;
  lastSpeakers = sig;
  if (!talkers.length) { el.classList.remove('show'); el.textContent = ''; return; }
  el.textContent = '🎤 ' + talkers.join(', ');
  el.classList.add('show');
}

// Active liaison indicator (top center) + disconnect button.
let lastLiaison = '';
function updateLiaisonBadge() {
  const st = liaisonStatus();
  const name = st.role === 'host' ? t('liaison.host') : (st.role === 'client' ? ((getLiaison(st.peer) && getLiaison(st.peer).name) || st.peer) : '');
  const count = st.role ? getUserCount() : 0;
  const sig = (st.role || '') + '|' + name + '|' + count;
  const vb = document.getElementById('voicebtn');
  if (vb) { vb.classList.toggle('hidden', !st.role); if (!st.role) vb.classList.remove('on'); }
  const spk = document.getElementById('speakerbtn');
  if (spk) spk.classList.toggle('hidden', !st.role);
  updateSpeakers(!!st.role);
  if (sig === lastLiaison) return;
  lastLiaison = sig;
  const el = document.getElementById('liaisonbadge');
  if (!el) return;
  if (!st.role) { el.classList.remove('show'); el.innerHTML = ''; return; }
  el.innerHTML = '';
  const lbl = document.createElement('span');
  lbl.className = 'lb-name';
  lbl.textContent = (st.role === 'host' ? '🟢 ' : '🔗 ') + name + (count > 1 ? '  👤' + count : '');
  lbl.title = t('liaison.manage');
  lbl.addEventListener('click', () => openSettings());
  const x = document.createElement('button');
  x.className = 'lb-x';
  x.textContent = '✕';
  x.title = t('liaison.disconnect');
  x.addEventListener('click', (e) => { e.stopPropagation(); disconnect(); });
  el.appendChild(lbl); el.appendChild(x);
  el.classList.add('show');
}

// Direct P2P / TURN relay indicator (only updated when it changes).
let lastNet;
function updateNetMode() {
  const nm = getNetMode();
  if (nm === lastNet) return;
  lastNet = nm;
  const el = document.getElementById('netmode');
  if (!nm) { el.className = ''; el.textContent = ''; }
  else if (nm === 'relay') { el.className = 'show relay'; el.textContent = t('net.relay'); }
  else if (nm === 'p2p') { el.className = 'show p2p'; el.textContent = t('net.p2p'); }
  else { el.className = 'show'; el.textContent = t('net.connecting'); }
}

// Clean re-render once the pixel font has loaded.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { /* the RAF loop resumes rendering */ });
}
