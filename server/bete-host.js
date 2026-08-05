// Headless PeerJS host for Bete — meant to run permanently
// (e.g. Raspberry Pi). Same sync protocol as the app, so web clients
// connect via ?peer=<id> with no app modification needed.
//
// MULTI-BOARD: a single peer hosts several boards. Each client announces
// its board id (connection metadata). The server keeps one board per id,
// persists it to data/boards/<id>.json, and only relays between clients of the same board.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// --- WebRTC/WebSocket polyfills to run the PeerJS client under Node ---
import wrtc from '@roamhq/wrtc';
import WebSocket from 'ws';
globalThis.RTCPeerConnection = wrtc.RTCPeerConnection;
globalThis.RTCSessionDescription = wrtc.RTCSessionDescription;
globalThis.RTCIceCandidate = wrtc.RTCIceCandidate;
globalThis.WebSocket = WebSocket;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node', product: 'node' };
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const _peerjs = await import('peerjs');
const Peer = (_peerjs.default && _peerjs.default.Peer) || _peerjs.Peer;

// --- Config ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BETE_DATA || path.join(__dirname, 'data');
const BOARDS_DIR = path.join(DATA_DIR, 'boards');
const OLD_BOARD_FILE = path.join(DATA_DIR, 'board.json'); // legacy single-board file
const ID_FILE = path.join(DATA_DIR, 'peer-id');
// Base URL of the static app, used only to display a full link at startup
// (no effect on the protocol). Empty by default to stay portable across
// instances: set BETE_APP_URL to display it.
const APP_URL = process.env.BETE_APP_URL || '';
const MAX_BOARDS = parseInt(process.env.BETE_MAX_BOARDS || '300', 10);

fs.mkdirSync(BOARDS_DIR, { recursive: true });

function resolveId() {
  if (process.env.BETE_ID) return process.env.BETE_ID;
  try { const id = fs.readFileSync(ID_FILE, 'utf8').trim(); if (id) return id; } catch (e) { /* */ }
  const id = 'p-' + crypto.randomBytes(16).toString('hex'); // 128 bits: anti-collision/guessability
  try { fs.writeFileSync(ID_FILE, id); } catch (e) { /* */ }
  return id;
}
const PEER_ID = resolveId();

const now = () => Date.now();
function sanitizeBoard(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
}

// ---- Untrusted-data sanitizers (mirror of js/state.js -- see there) ----
// A client's sync/move payload must not be able to set NaN/strings/absurd
// sizes (physics/render of every connected device) nor multi-MB texts
// (RAM+disk growth on the host). Also caps ids stored in tombstones.
const LIMITS = { pos: 1e6, w: 1e5, h: 1e5, r: 1e5, text: 20000, yaml: 50000 };
function clampNum(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
function clampText(v, max = LIMITS.text) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).slice(0, max);
}
function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return {};
  const out = { ...e };
  if (typeof out.x !== 'undefined') out.x = clampNum(out.x, -LIMITS.pos, LIMITS.pos) ?? 0;
  if (typeof out.y !== 'undefined') out.y = clampNum(out.y, -LIMITS.pos, LIMITS.pos) ?? 0;
  if (typeof out.w !== 'undefined') out.w = clampNum(out.w, 8, LIMITS.w) ?? 150;
  if (typeof out.h !== 'undefined') out.h = clampNum(out.h, 8, LIMITS.h) ?? 70;
  if (typeof out.r !== 'undefined') out.r = clampNum(out.r, 1, LIMITS.r) ?? 50;
  if (typeof out.t !== 'undefined') out.t = clampText(out.t);
  if (typeof out.d !== 'undefined') out.d = clampText(out.d);
  if (typeof out.yml !== 'undefined') out.yml = clampText(out.yml, LIMITS.yaml);
  if (typeof out.col !== 'undefined') out.col = clampText(out.col, 32);
  if (typeof out.img !== 'undefined') out.img = clampText(out.img, 200);
  if (typeof out.lk !== 'undefined') out.lk = clampText(out.lk, 1000);
  return out;
}

// --- Boards in memory: id -> { content, mt, del, conns, lastSig, saveTimer } ---
const boards = new Map();

// In-memory cache of voice memos (id -> received audioRes message, resent as-is).
// Allows sharing between clients + retrieval by a late arrival while the
// server is running. (No disk persistence: transient binary data.) Bounded
// the same way imgMem is below -- previously unbounded, so a client could
// grow server RAM without limit just by recording (or claiming to record)
// many distinct voice memos.
const audioMem = new Map();
const AUDIO_MAX = 200; // memos run bigger than the average image, so a lower cap
function cacheAudio(id, msg) {
  if (audioMem.has(id)) audioMem.delete(id);
  audioMem.set(id, msg);
  while (audioMem.size > AUDIO_MAX) audioMem.delete(audioMem.keys().next().value);
}

// In-memory cache of images (hash -> imgRes message), same principle as audio:
// an image only transits once, then the server re-serves it to newcomers.
// Bounded: keeps at most IMG_MAX images (FIFO eviction) to avoid bloating RAM.
const imgMem = new Map();
const IMG_MAX = 400;
function cacheImg(hash, msg) {
  if (imgMem.has(hash)) imgMem.delete(hash);
  imgMem.set(hash, msg);
  while (imgMem.size > IMG_MAX) imgMem.delete(imgMem.keys().next().value);
}

function fromExport(obj) {
  const n = {}, c = {}, h = {}, m = {}; const t = now();
  for (const nd of obj.nodes || []) {
    if (nd.kind === 'liaison') continue;
    if (nd.ref !== undefined) n[nd.id] = { ref: nd.ref, x: nd.x, y: nd.y, w: nd.w, h: nd.h };
    else if (nd.kind === 'connector') n[nd.id] = { cn: 1, yml: nd.yaml || '', disp: nd.display || 'triangle', x: nd.x, y: nd.y, w: nd.w, h: nd.h };
    else {
      const e = { t: nd.text || '', img: nd.image || null, x: nd.x, y: nd.y, w: nd.w, h: nd.h };
      if (nd.kind === 'pancarte') e.k = 'pancarte';
      if (nd.link) e.lk = nd.link;
      n[nd.id] = e;
    }
    m[nd.id] = t;
  }
  for (const z of obj.circles || []) { c[z.id] = { col: z.color, d: z.description || '', x: z.x, y: z.y, r: z.r }; m[z.id] = t; }
  for (const z of obj.hexagons || []) { h[z.id] = { col: z.color, d: z.description || '', x: z.x, y: z.y, r: z.r }; m[z.id] = t; }
  return { n, c, h, mt: m, del: [], name: obj.name || '' };
}

function boardFromObj(obj) {
  const st = Array.isArray(obj.nodes) ? fromExport(obj) : obj; // export or native format
  return {
    content: { n: st.n || {}, c: st.c || {}, h: st.h || {} },
    mt: st.mt || {},
    del: new Set(st.del || []),
    readOnly: !!st.readOnly,
    ownerToken: st.ownerToken || null, // first client to say 'hello' on a fresh board claims it (see handleData)
    name: st.name || '', // learned from whichever client's sync first carried one -- see merge()
    // Optional passphrase hash (SHA-256 hex, or null): only ever settable by
    // an already-recognized owner (see 'setpass' in handleData below), never
    // first-claimed like ownerToken -- otherwise anyone could "claim" the
    // passphrase requirement by just connecting first, defeating the point.
    passHash: st.passHash || null,
    conns: [], lastSig: '', saveTimer: null,
  };
}

function loadBoards() {
  let files = [];
  try { files = fs.readdirSync(BOARDS_DIR).filter((f) => f.endsWith('.json')); } catch (e) { /* */ }
  for (const f of files) {
    const id = sanitizeBoard(f.replace(/\.json$/, ''));
    try { boards.set(id, boardFromObj(JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, f), 'utf8')))); } catch (e) { /* */ }
  }
  // Migrates the legacy single-board file -> home.
  if (!boards.has('home') && fs.existsSync(OLD_BOARD_FILE)) {
    try { boards.set('home', boardFromObj(JSON.parse(fs.readFileSync(OLD_BOARD_FILE, 'utf8')))); } catch (e) { /* */ }
  }
  console.log(`[bete] ${boards.size} board(s) loaded: ${[...boards.keys()].join(', ') || '(none)'}`);
}

// Returns null if this would be a brand-new board past MAX_BOARDS -- caller
// must reject the connection instead of proceeding with an unmanaged board.
// Previously this only logged a warning and created the board anyway, so an
// attacker who knew the peer id could keep connecting with fresh random
// board ids forever and grow this Map without bound until the process ran
// out of memory.
function getBoard(id) {
  let b = boards.get(id);
  if (!b) {
    if (boards.size >= MAX_BOARDS) { console.warn('[bete] board limit reached, refusing new board:', id); return null; }
    b = { content: { n: {}, c: {}, h: {} }, mt: {}, del: new Set(), readOnly: false, ownerToken: null, name: '', passHash: null, conns: [], lastSig: '', saveTimer: null };
    boards.set(id, b);
  }
  return b;
}

function scheduleSave(id, b) {
  if (b.saveTimer || boards.size > MAX_BOARDS) return;
  b.saveTimer = setTimeout(() => {
    b.saveTimer = null;
    try {
      fs.writeFileSync(path.join(BOARDS_DIR, id + '.json'), JSON.stringify({ ...b.content, mt: b.mt, del: [...b.del], readOnly: b.readOnly, ownerToken: b.ownerToken, name: b.name, passHash: b.passHash }));
    } catch (e) { console.error('[bete] save failed', id, e); }
  }, 1000);
}

// --- Sync (LWW + host priority on tie), per board ---
// `owner` is set per-connection (never broadcast): only this specific client
// gets told whether its token was recognized.
function buildPayload(id, b, conn) {
  return { type: 'sync', from: 'host', n: b.content.n, c: b.content.c, h: b.content.h, mt: { ...b.mt }, del: [...b.del], readOnly: b.readOnly, owner: !!(conn && conn._owner), bn: realName(id, b) };
}

// A name equal to the board/peer id is just the "nothing chosen yet"
// fallback (see js/boards.js, js/liaisons.js), not a real name -- never
// treat it as one, whether reading it or about to broadcast it. Without
// this guard, a headless host (whose own name always starts unset) could
// pick up a client's still-unset fallback and hand it on to every future
// client as if it were the genuine name (that client's real rename would
// then never stick, since the host thinks it already has one).
function realName(id, b) { return (b.name && b.name !== id) ? b.name : undefined; }

// First-claim: a fresh board (no owner yet) adopts whichever token shows up
// first, same trust model as the peer id itself. Later connections are only
// recognized as owner if their token matches.
function resolveOwner(id, b, conn, token) {
  if (!token) { conn._owner = false; return; }
  if (!b.ownerToken) { b.ownerToken = token; conn._owner = true; scheduleSave(id, b); return; }
  conn._owner = b.ownerToken === token;
}

function merge(id, b, remote) {
  let changed = false;
  // Board name: learned once from whichever client's sync first carries one
  // (a browser client's own local name -- see js/sync.js), then kept and
  // relayed to everyone else, including a brand-new client that has none yet.
  // remote.bn === id is that client's own not-yet-set fallback, not a real
  // name (see realName above) -- ignored, so a genuine name can still land later.
  if (remote.bn && remote.bn !== id && !b.name) { b.name = remote.bn; changed = true; }
  const win = (id) => {
    const rm = (remote.mt && remote.mt[id]) || 0;
    const lm = b.mt[id] || 0;
    return rm > lm || (rm === lm && remote.from === 'host');
  };
  for (const id of remote.del || []) {
    const cid = clampText(id, 64);
    if (!b.del.has(cid)) b.del.add(cid);
    if (b.content.n[cid] || b.content.c[cid] || b.content.h[cid]) {
      delete b.content.n[cid]; delete b.content.c[cid]; delete b.content.h[cid]; delete b.mt[cid]; changed = true;
    }
  }
  const mergeMap = (map, rem) => {
    for (const id in rem || {}) {
      if (b.del.has(id)) continue;
      if (win(id)) { map[id] = sanitizeEntry(rem[id]); b.mt[id] = (remote.mt && remote.mt[id]) || now(); changed = true; }
    }
  };
  mergeMap(b.content.n, remote.n);
  mergeMap(b.content.c, remote.c);
  mergeMap(b.content.h, remote.h);
  return changed;
}

function applyMove(b, msg) {
  const e = b.content.n[msg.id] || b.content.c[msg.id] || b.content.h[msg.id];
  if (!e) return;
  const x = clampNum(msg.x, -LIMITS.pos, LIMITS.pos); if (x != null) e.x = x;
  const y = clampNum(msg.y, -LIMITS.pos, LIMITS.pos); if (y != null) e.y = y;
  const w = clampNum(msg.w, 8, LIMITS.w); if (w != null) e.w = w;
  const h = clampNum(msg.h, 8, LIMITS.h); if (h != null) e.h = h;
  const r = clampNum(msg.r, 1, LIMITS.r); if (r != null) e.r = r;
}

function applyDelete(b, msg) {
  const cid = clampText(msg.id, 64);
  b.del.add(cid);
  audioMem.delete(cid); // frees the cached audio
  if (b.content.n[cid] || b.content.c[cid] || b.content.h[cid]) {
    delete b.content.n[cid]; delete b.content.c[cid]; delete b.content.h[cid]; delete b.mt[cid];
  }
}

// Presence: the server (host) + clients that have announced a name.
function broadcastPresence(b) {
  const users = [{ uid: 'server', name: 'Server', host: true, peerId: null, voice: false }];
  for (const c of b.conns) if (c._uid) users.push({ uid: c._uid, name: c._name || '', host: false, peerId: c._peerId || null, voice: !!c._voice });
  const payload = { type: 'presence', users };
  for (const c of b.conns) if (c.open) { try { c.send(payload); } catch (e) { /* */ } }
}

function broadcastLock(b) {
  const payload = { type: 'lock', readOnly: b.readOnly };
  for (const c of b.conns) if (c.open) { try { c.send(payload); } catch (e) { /* */ } }
}

// Basic per-connection rate limit: a sliding count reset every second,
// tracked directly on the connection object (like _lastSeen already is).
// Previously there was no cap at all on message rate, so one misbehaving or
// malicious client could burn arbitrary CPU/bandwidth on this process (and
// on every other client in the same board, since most message types are
// relayed). Deliberately simple -- no burst allowance, no per-message-type
// weighting -- just enough to make a flood cheap to reject instead of free
// to send.
const RATE_LIMIT_PER_SEC = 50;
function rateLimited(conn) {
  const t = Math.floor(now() / 1000);
  if (conn._rateWindow !== t) { conn._rateWindow = t; conn._rateCount = 0; }
  conn._rateCount = (conn._rateCount || 0) + 1;
  return conn._rateCount > RATE_LIMIT_PER_SEC;
}

// Per-IP rate limit for the standalone /ics proxy (see the server block
// below). 30 requests/minute is plenty for a calendar poll and leaves a
// wide margin over any legit use. The entry stays in the map (and keeps
// rejecting) until its 60s window expires -- never delete it on overflow,
// or the very next request would restart a fresh window.
const PROXY_RATE_MAX = 30;
const PROXY_RATE_WINDOW = 60000;
const proxyRates = new Map(); // ip -> { windowStart, count }
function proxyRateOk(ip) {
  const t = now();
  const r = proxyRates.get(ip);
  if (!r || t - r.windowStart > PROXY_RATE_WINDOW) {
    proxyRates.set(ip, { windowStart: t, count: 1 });
    return true;
  }
  r.count += 1;
  return r.count <= PROXY_RATE_MAX;
}
function pruneProxyRates() {
  const cutoff = now() - PROXY_RATE_WINDOW;
  for (const [ip, r] of proxyRates) if (r.windowStart < cutoff) proxyRates.delete(ip);
}

function handleData(id, b, msg, origin) {
  if (!msg) return;
  if (rateLimited(origin)) return; // silently drop -- no need to close the connection over a transient burst
  // Read-only board: content from a non-owner connection is ignored outright
  // (never merged, never relayed) -- mirrors the browser-hosted guard in
  // js/sync.js, but keyed on the owner token (resolveOwner) since every
  // connection here is symmetric, there's no single "host process" to trust.
  if (b.readOnly && !origin._owner && (msg.type === 'sync' || msg.type === 'move' || msg.type === 'delete')) {
    return;
  }
  if (msg.type === 'lock') {
    if (origin._owner) { b.readOnly = !!msg.readOnly; scheduleSave(id, b); broadcastLock(b); }
    return;
  }
  if (msg.type === 'setpass') {
    // Sets/clears the board's required passphrase hash -- owner-only, same
    // guard as 'lock' above. Deliberately NOT first-claim like ownerToken:
    // only a connection already recognized as owner (via resolveOwner) may
    // do this, otherwise anyone could "claim" the passphrase requirement
    // just by connecting first, defeating the whole point. Already-connected
    // guests are left alone (same choice as js/sync.js's browser-hosted
    // equivalent) -- this only affects future connection attempts.
    if (origin._owner) { b.passHash = msg.hash || null; scheduleSave(id, b); }
    return;
  }
  if (msg.type === 'sync') {
    if (merge(id, b, msg)) scheduleSave(id, b);
    // Actively pull any brand-new voice memo's audio directly from whoever
    // just announced it, instead of passively waiting for their proactive
    // push (shareAudio) to arrive cleanly. Whoever sent this delta is the
    // only one who could know about a fresh id, so they must be the recorder.
    for (const nid in msg.n || {}) {
      if (msg.n[nid].vc && !audioMem.has(nid)) {
        try { if (origin.open) origin.send({ type: 'audioReq', id: nid }); } catch (e) { /* */ }
      }
    }
  }
  else if (msg.type === 'move') { applyMove(b, msg); scheduleSave(id, b); }
  else if (msg.type === 'delete') { applyDelete(b, msg); scheduleSave(id, b); }
  else if (msg.type === 'audioReq') {
    // Voice memo requested: answers from the cache, otherwise relays to others.
    const cached = audioMem.get(msg.id);
    if (cached) { try { if (origin.open) origin.send(cached); } catch (e) { /* */ } }
    else for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } }
    return;
  } else if (msg.type === 'audioRes') {
    if (msg.buf) cacheAudio(msg.id, msg); // cache + resend as-is
    for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } }
    return;
  } else if (msg.type === 'imgReq') {
    // Image requested by hash: re-serves from cache, otherwise relays to others.
    const cached = imgMem.get(msg.hash);
    if (cached) { try { if (origin.open) origin.send(cached); } catch (e) { /* */ } }
    else for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } }
    return;
  } else if (msg.type === 'imgRes') {
    if (msg.buf) cacheImg(msg.hash, msg); // bounded cache + resend as-is
    for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } }
    return;
  } else if (msg.type === 'icsReq') {
    // Unlike a browser peer, Node has no CORS restriction at all -- the
    // headless host can just fetch the calendar itself (like the standalone
    // /ics proxy below, but over the data channel instead of HTTP), which is
    // more reliable than relaying to some other browser client that might
    // hit the exact same CORS wall a web requester does. Same .ics/size
    // guard as the proxy: this isn't meant to be a general-purpose fetch relay.
    fetchIcsForPeer(msg.url).then((text) => {
      try { if (origin.open) origin.send({ type: 'icsRes', url: msg.url, text }); } catch (e) { /* */ }
    }).catch((e) => {
      try { if (origin.open) origin.send({ type: 'icsRes', url: msg.url, error: e.message }); } catch (e2) { /* */ }
    });
    return;
  } else if (msg.type === 'icsRes') {
    for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } }
    return;
  } else if (msg.type === 'hello') {
    origin._uid = msg.uid; origin._name = msg.name; origin._peerId = msg.peerId; origin._voice = msg.voice;
    // Redundant with the connection-metadata resolution (belt-and-suspenders,
    // in case metadata didn't come through on some client): idempotent either way.
    resolveOwner(id, b, origin, msg.ownerToken);
    broadcastPresence(b);
    return;
  } else if (msg.type === 'cursor') {
    for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } } // relays cursors
    return;
  }
  if (msg.type === 'move' || msg.type === 'delete') {
    for (const c of b.conns) if (c !== origin && c.open) { try { c.send(msg); } catch (e) { /* */ } }
  }
}

// Per-entry signatures (n/c/h) to only broadcast what changed (delta).
function entrySigs(b) {
  const m = {};
  for (const id in b.content.n) m['n' + id] = JSON.stringify(b.content.n[id]);
  for (const id in b.content.c) m['c' + id] = JSON.stringify(b.content.c[id]);
  for (const id in b.content.h) m['h' + id] = JSON.stringify(b.content.h[id]);
  return m;
}

// Periodic broadcast IN DELTA: only the changed entries + deletions.
function tick() {
  for (const [id, b] of boards) {
    if (!b.conns.length) continue;
    const sigs = entrySigs(b);
    const prev = b.prevSigs || {};
    const nn = {}, cc = {}, hh = {}, mt = {};
    let changed = false;
    for (const k in sigs) {
      if (prev[k] === sigs[k]) continue;
      changed = true;
      const t = k[0], rid = k.slice(1);
      if (t === 'n') nn[rid] = b.content.n[rid];
      else if (t === 'c') cc[rid] = b.content.c[rid];
      else hh[rid] = b.content.h[rid];
      mt[rid] = b.mt[rid] || now();
    }
    const delSig = b.del.size;
    const delChanged = b._lastDelSig !== delSig;
    const nameChanged = b._sentName !== b.name;
    if (!changed && !delChanged && !nameChanged) { b.prevSigs = sigs; continue; }
    b.prevSigs = sigs; b._lastDelSig = delSig; b._sentName = b.name;
    const payload = { type: 'sync', from: 'host', n: nn, c: cc, h: hh, mt, del: [...b.del], readOnly: b.readOnly, bn: realName(id, b) };
    for (const c of b.conns) if (c.open) { try { c.send(payload); } catch (e) { /* */ } }
  }
}

// --- Safety net: never crash on an unhandled error ---
// (e.g. "WebSocket was closed before the connection was established" from ws/peerjs).
process.on('uncaughtException', (e) => {
  console.error('[bete] uncaughtException ignored:', (e && e.message) || e);
  if (peer) { try { peer.destroy(); } catch (er) { /* */ } peer = null; scheduleRestart(); }
});
process.on('unhandledRejection', (e) => { console.error('[bete] unhandledRejection:', (e && e.message) || e); });

// --- Peer ---
loadBoards();

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

let peer = null;
let restartTimer = null;
function scheduleRestart() {
  if (restartTimer) return;
  restartTimer = setTimeout(() => { restartTimer = null; start(); }, 5000);
}

function start() {
  const p = new Peer(PEER_ID, {
    host: '0.peerjs.com', port: 443, path: '/', secure: true, key: 'peerjs',
    config: { iceServers: ICE },
  });
  peer = p;

  p.on('open', (rid) => {
    console.log('\n[bete] HOST ONLINE (multi-board)');
    console.log('  id    : ' + rid);
    if (APP_URL) console.log('  link  : ' + APP_URL + '?peer=' + encodeURIComponent(rid));
    else console.log('  link  : <your-instance-url>/?peer=' + encodeURIComponent(rid) + '  (set BETE_APP_URL to show it in full)');
    console.log('  (add &id=name for a specific board)\n');
  });
  p.on('connection', (conn) => {
    if (p !== peer) return;
    const id = sanitizeBoard(conn.metadata && conn.metadata.board);
    const b = getBoard(id);
    if (!b) { try { conn.close(); } catch (e) { /* */ } return; }
    conn._lastSeen = now();
    resolveOwner(id, b, conn, conn.metadata && conn.metadata.ownerToken);
    // Optional passphrase (see 'setpass' above): checked for EVERY connection,
    // owner included -- the owner's own device holds the correct hash locally
    // too (set at the same moment it set the requirement, see js/sync.js:
    // setBoardPassphrase), so this never locks the real owner out in
    // practice, and staying symmetric (no owner bypass) means a leaked/stolen
    // owner token alone still can't get past a passphrase requirement.
    if (b.passHash && (!conn.metadata || conn.metadata.passHash !== b.passHash)) {
      conn.on('open', () => {
        try { conn.send({ type: 'authFail' }); } catch (e) { /* */ }
        setTimeout(() => { try { conn.close(); } catch (e) { /* */ } }, 300);
      });
      return;
    }
    b.conns.push(conn);
    console.log(`[bete] client connected on "${id}" (${b.conns.length})${conn._owner ? ' [owner]' : ''}`);
    conn.on('open', () => { try { conn.send(buildPayload(id, b, conn)); } catch (e) { /* */ } });
    conn.on('data', (msg) => { conn._lastSeen = now(); handleData(id, b, msg, conn); });
    const drop = () => { const i = b.conns.indexOf(conn); if (i >= 0) b.conns.splice(i, 1); broadcastPresence(b); console.log(`[bete] client disconnected from "${id}" (${b.conns.length})`); };
    conn.on('close', drop);
    conn.on('error', drop);
  });
  p.on('disconnected', () => {
    if (p !== peer) return;
    // NB: p.reconnect() on this stack (wrtc/ws) can emit an unhandled WS error
    // and crash the process. We prefer to destroy + restart cleanly.
    console.warn('[bete] disconnected from the broker, restarting cleanly…');
    try { p.destroy(); } catch (e) { /* */ }
    peer = null;
    scheduleRestart();
  });
  p.on('error', (err) => {
    if (p !== peer) return;
    const t = err && err.type ? err.type : String(err);
    console.error('[bete] peer error:', t);
    if (t === 'unavailable-id') console.error('  -> id taken (another host running?). Retrying in 5s.');
    if (t === 'unavailable-id' || t === 'network' || t === 'server-error' || t === 'socket-error') {
      try { p.destroy(); } catch (e) { /* */ }
      peer = null;
      scheduleRestart();
    }
  });
}

// --- ICS calendar fetch (CORS relay for the app's calendar blocks) ---
// Most calendar hosts (Google, iCloud...) don't send CORS headers, so a web
// client can't fetch a .ics feed directly (js/ics.js). Node has no such
// restriction, so this host can just fetch it and hand back the text --
// either over the data channel (icsReq/icsRes, used automatically by any
// connected client, browser or desktop) or over the standalone HTTP proxy
// below (GET /ics?url=..., for a client that isn't/can't be connected as a
// liaison). Same validation either way: only http(s) urls that look like an
// ICS feed, size-capped -- this is not a general-purpose fetch relay.
const ICS_MAX_BYTES = 2 * 1024 * 1024;
// Loopback + link-local (cloud metadata lives on 169.254.169.254) + IPv6
// link-local: the one class of internal host a calendar URL must never be
// allowed to reach. Private RFC1918 ranges and mDNS (.local) stay allowed --
// LAN calendars are a first-class feature (see PRIVATE_HOST_RE in
// js/connector.js).
function blockedIcsHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('169.254.')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return +m[1] === 127 || +m[1] === 0 || (+m[1] === 169 && +m[2] === 254);
  return false;
}
async function fetchIcsForPeer(urlStr) {
  let target;
  try { target = new URL(urlStr); } catch (e) { throw new Error('bad url'); }
  // Every hop is gated, not just the first URL: with redirect:'follow' a
  // single 302 could jump to an internal host (cloud metadata, router, LAN
  // service) and hand its body back to the requester. Follow manually and
  // re-apply the scheme + pathname + host checks to each hop.
  let cur = target;
  for (let hops = 0; hops < 5; hops++) {
    if (!/^https?:$/.test(cur.protocol) || !cur.pathname.toLowerCase().endsWith('.ics') || blockedIcsHost(cur.hostname)) {
      throw new Error('not an ics url');
    }
    const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('redirect without location');
      cur = new URL(loc, cur);
      continue;
    }
    if (!r.ok) throw new Error('upstream ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > ICS_MAX_BYTES) throw new Error('too large');
    return buf.toString('utf8');
  }
  throw new Error('too many redirects');
}

// Optional standalone proxy (BETE_ICS_PORT=0 disables it): configure its URL
// in the app under Settings > ICS proxy. Kept for a client that has no
// liaison to relay the icsReq/icsRes above through.
const ICS_PORT = parseInt(process.env.BETE_ICS_PORT || '9741', 10);
if (ICS_PORT) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    // Chrome Private Network Access: an HTTPS page fetching a LAN address
    // sends a preflight that requires this opt-in from the local server.
    'Access-Control-Allow-Private-Network': 'true',
  };
  const icsSrv = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    // Per-IP rate limit (sliding window, same shape as the per-connection
    // one above): the proxy is unauthenticated by design (it only relays
    // .ics-shaped URLs, and CORS locks it to GET), but a LAN scanner must
    // not be able to turn this Pi into a free fetch farm at full speed.
    if (!proxyRateOk(req.socket.remoteAddress)) { res.writeHead(429, CORS); res.end('rate limited'); return; }
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400, CORS); res.end('bad request'); return; }
    if (req.method !== 'GET' || u.pathname !== '/ics') { res.writeHead(404, CORS); res.end('not found'); return; }
    fetchIcsForPeer(u.searchParams.get('url') || '').then((text) => {
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(text);
    }).catch((e) => {
      const code = e.message === 'not an ics url' || e.message === 'bad url' ? 400 : e.message === 'too large' ? 413 : 502;
      res.writeHead(code, CORS); res.end(e.message);
    });
  });
  icsSrv.on('error', (e) => console.error('[bete] ics proxy error:', e.message));
  icsSrv.listen(ICS_PORT, () => console.log(`[bete] ICS proxy listening on :${ICS_PORT} (GET /ics?url=...)`));
}

setInterval(tick, 800);
// Regular heartbeat: proves to clients that the server is alive (otherwise
// they would trigger a re-election during periods of inactivity).
setInterval(() => {
  for (const [, b] of boards) for (const c of b.conns) if (c.open) { try { c.send({ type: 'ping' }); } catch (e) { /* */ } }
}, 3000);
// Cleans up silent clients (tab closed without a signal): > 9s with no message.
setInterval(() => {
  pruneProxyRates();
  const cutoff = Date.now() - 9000;
  for (const [, b] of boards) {
    const before = b.conns.length;
    b.conns = b.conns.filter((c) => { const alive = !c._lastSeen || c._lastSeen > cutoff; if (!alive) { try { c.close(); } catch (e) { /* */ } } return alive; });
    if (b.conns.length !== before) broadcastPresence(b);
  }
}, 3000);
start();
