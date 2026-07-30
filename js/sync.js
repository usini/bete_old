// Bidirectional P2P synchronization via PeerJS (WebRTC).
// We only synchronize the CONTENT (text, image, color, description, links,
// creation/deletion): neither the camera nor the positions/sizes. Each screen
// therefore keeps its own view. Merge by id, conflicts resolved with LWW; on a
// tied timestamp, the tie-break prefers the peer running the newer app build
// (falls back to host priority if both sides are on the same build) -- an
// out-of-date host (stale tab, permanent Pi host not yet redeployed) must not
// keep clobbering a freshly-updated peer's edits forever.
import { state, removeById, scheduleSave, getBoardId, getBoardName, setBoardName } from './state.js?v=ms7d04ny';
import { reset } from './physics.js?v=ms7d04ny';
import { explodeElementCascade } from './fx.js?v=ms7d04ny';
import { putAudio, getAudio, delAudio, putImage, getImage } from './audio.js?v=ms7d04ny';
import { onImageArrived } from './images.js?v=ms7d04ny';
import { getUserId, displayName } from './users.js?v=ms7d04ny';
import { shareOrigin } from './platform.js?v=ms7d04ny';
import { recordBoard, rewriteLinksForBoard, parseBoardUrl, buildBoardUrl } from './boards.js?v=ms7d04ny';
import { getOwnerToken, recordLiaison } from './liaisons.js?v=ms7d04ny';
import { pollConnector, stopPolling, toggleSwitch } from './connector.js?v=ms7d04ny';
import { fetchIcsLocal, resolveIcsPeerResponse, retryFailedIcs } from './ics.js?v=ms7d04ny';
import { refreshBoardNameUI } from './main.js?v=ms7d04ny';

let clientRoster = []; // client side: list of users received from the host
let lastHostMsg = 0;   // client side: timestamp of the last message received from the host
let hostHb = null;     // host side: heartbeat timer
let cursors = {};      // uid -> { name, x, y, t }: other users' cursors
let localVoice = false; // is our mic active (voice chat)?
let incomingCb = null;  // callback for incoming media calls (voicechat)
let iAmOwner = false;   // client side: has a headless host (Pi) confirmed our owner token?

// Current local PeerJS peer (host or client) — used for audio calls.
export function getPeer() { return mode === 'host' ? hostPeer : clientPeer; }
export function setLocalVoice(v) { localVoice = !!v; announceName(); }
export function onIncomingCall(cb) { incomingCb = cb; }
function attachCallHandler(peer) { if (peer) peer.on('call', (c) => { if (incomingCb) incomingCb(c); }); }
function helloMsg() { return { type: 'hello', uid: getUserId(), name: displayName(), peerId: (clientPeer && clientPeer.id) || null, voice: localVoice, ownerToken: getOwnerToken(getBoardId()), ver: MY_VERSION }; }

// Our own build's cache-bust stamp (Date.now().toString(36) at the last
// `node cachebust.mjs` run -- see cachebust.mjs), read straight off the
// entry script's own src. Base36 timestamps of equal length compare
// correctly as plain strings, and web/desktop both go through the same
// cachebust step, so this doubles as a cross-build "who's newer" signal
// without introducing a second, incompatible versioning scheme.
function readBuildVersion() {
  try {
    const s = document.querySelector('script[type="module"][src*="main.js"]');
    const m = s && s.src.match(/[?&]v=([^&"']+)/);
    return (m && m[1]) || null;
  } catch (e) { return null; }
}
const MY_VERSION = readBuildVersion();

// True if we may toggle read-only: we ARE the host (browser-hosted liaison),
// or a headless host (Pi) has confirmed our owner token belongs to this board.
export function isOwner() { return mode === 'host' || iAmOwner; }

const PEERJS_SRC = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

const _loaded = {};
function loadScript(src) {
  if (_loaded[src]) return _loaded[src];
  _loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
  return _loaded[src];
}
export const loadQR = () => loadScript(QR_SRC);
const loadPeer = () => loadScript(PEERJS_SRC);

// No name param anymore -- the receiver's liaison list picks up a friendly
// name once the sync payload arrives (see merge(): a synced `bn` also names
// the liaison it came from, unless already renamed locally).
export function buildUrl(id) {
  let u = shareOrigin() + '?peer=' + encodeURIComponent(id);
  const b = getBoardId();
  if (b) u += '&id=' + encodeURIComponent(b); // the QR opens the SAME board as the host
  return u;
}

// ---- Sync state ----
let mode = null;          // 'host' | 'client'
let conns = [];           // open data connections
let tickTimer = null;
let tombstones = new Set(); // deleted ids (to propagate deletions)
let mtimes = {};            // id -> timestamp of the last content change
let prevSigs = {};          // id -> content signature at the previous tick
let prevLocalIds = null;
let clientFirstSync = false;
let forceFull = false;   // true = next send is the full board (delta otherwise)
let lastDelSig = '';     // signature of the tombstone count (detects deletions)
let reelectTries = 0;    // reconnect attempts before trying a host election
let reconnectTimes = []; // timestamps of recent disconnect/reconnect cycles (loop detection)
let loopWarned = false;  // 'loop' status already reported for this liaison (until it heals)
const LOOP_WINDOW = 60000; // sliding window for counting reconnect cycles
const LOOP_THRESHOLD = 10; // cycles within LOOP_WINDOW = stuck in a reconnect loop

// True if we're connected as a client (opened via ?peer=).
export function isClient() { return mode === 'client'; }

// Host-only: locks/unlocks the board for connected guests. Persists locally
// right away, and (if hosting) tells connected guests immediately -- the
// regular tick() only sends when node/circle/hexagon content changed, so an
// isolated readOnly toggle would otherwise never reach anyone already connected.
export function setBoardReadOnly(v) {
  state.readOnly = !!v;
  scheduleSave();
  if (mode === 'host') conns.forEach((c) => sendTo(c, { type: 'lock', readOnly: state.readOnly }));
  // Headless host (Pi): we're technically a 'client' there too, even as the
  // owner -- ask the Pi to apply + persist + rebroadcast to everyone else.
  else if (mode === 'client' && iAmOwner && conns[0]) sendTo(conns[0], { type: 'lock', readOnly: state.readOnly });
}
// Host id (the one we're connected to as a client, or ours if we're hosting).
export function hostId() { return mode === 'client' ? clientPeerId : (hostPeer && hostPeer.id) || null; }

// Liaison state for the indicator: { role:'client'|'host'|null, peer }.
export function liaisonStatus() {
  if (mode === 'client') return { role: 'client', peer: clientPeerId };
  if (mode === 'host' && hostPeer && hostPeer.id) return { role: 'host', peer: hostPeer.id };
  return { role: null, peer: null };
}

// ---- Presence (list of connected users) ----
export function getPresence() {
  if (mode === 'host') {
    const list = [{ uid: getUserId(), name: displayName(), host: true, me: true, peerId: (hostPeer && hostPeer.id) || null, voice: localVoice }];
    conns.forEach((c) => { if (c._uid) list.push({ uid: c._uid, name: c._name || '', host: false, me: false, peerId: c._peerId || null, voice: !!c._voice }); });
    return list;
  }
  if (mode === 'client') return clientRoster.map((u) => ({ ...u, me: u.uid === getUserId() }));
  return [];
}
export function getUserCount() { return getPresence().length; }

function broadcastPresence() {
  if (mode !== 'host') return;
  const payload = { type: 'presence', users: getPresence().map((u) => ({ uid: u.uid, name: u.name, host: u.host, peerId: u.peerId, voice: u.voice })) };
  conns.forEach((c) => { try { if (c.open) c.send(payload); } catch (e) { /* */ } });
}

// ---- Live cursors (world position, throttled + sent on stop) ----
let _curT = 0, _curTrail = null;
function sendCursor(wx, wy) {
  if (!conns.length) return;
  const msg = { type: 'cursor', uid: getUserId(), name: displayName(), x: wx, y: wy };
  if (mode === 'client') sendTo(conns[0], msg);
  else if (mode === 'host') conns.forEach((c) => sendTo(c, msg));
}
export function reportCursor(wx, wy) {
  if (!conns.length) return;
  const t = now(), dt = t - _curT;
  if (dt >= 150) { _curT = t; if (_curTrail) { clearTimeout(_curTrail); _curTrail = null; } sendCursor(wx, wy); }
  else { if (_curTrail) clearTimeout(_curTrail); _curTrail = setTimeout(() => { _curT = now(); _curTrail = null; sendCursor(wx, wy); }, 150 - dt); } // final send on stop
}
// Other users' active cursors (expire after 6s with no update).
export function getCursors() {
  const out = [], cutoff = now() - 6000, me = getUserId();
  for (const uid in cursors) { const c = cursors[uid]; if (uid !== me && c.t > cutoff) out.push({ uid, name: c.name, x: c.x, y: c.y }); }
  return out;
}

// Re-announces the name (after a change in Settings).
export function announceName() {
  if (mode === 'client') { try { conns[0] && conns[0].open && conns[0].send(helloMsg()); } catch (e) { /* */ } }
  else if (mode === 'host') broadcastPresence();
}

// Disconnects the liaison: as a client, reloads the board locally (without ?peer=);
// as a host, stops hosting.
export function disconnect() {
  if (mode === 'client') { location.href = location.pathname + '?id=' + encodeURIComponent(getBoardId()); }
  else if (mode === 'host') { stopHost(); }
}

// ---- Liaison type detection (direct P2P vs TURN relay) ----
let netMode = null; // null=not connected, 'p2p', 'relay', '?'
export function getNetMode() { return netMode; }

async function modeFromStats(pc) {
  const stats = await pc.getStats();
  let pairId = null, pair = null;
  stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
  stats.forEach((r) => {
    if (r.type !== 'candidate-pair') return;
    if (pairId ? r.id === pairId : (r.nominated && r.state === 'succeeded')) pair = r;
  });
  if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded') pair = pair || r; });
  if (!pair) return '?';
  let lt, rt;
  stats.forEach((r) => {
    if (r.id === pair.localCandidateId) lt = r.candidateType;
    if (r.id === pair.remoteCandidateId) rt = r.candidateType;
  });
  if (lt === 'relay' || rt === 'relay') return 'relay';
  return (lt || rt) ? 'p2p' : '?';
}

async function refreshNetMode() {
  if (!conns.length) { netMode = null; return; }
  let relay = false, p2p = false, any = false;
  for (const c of conns) {
    const pc = c && c.peerConnection;
    if (!pc || !pc.getStats) continue;
    try { const m = await modeFromStats(pc); any = true; if (m === 'relay') relay = true; else if (m === 'p2p') p2p = true; } catch (e) { /* */ }
  }
  netMode = relay ? 'relay' : (p2p ? 'p2p' : (any ? '?' : null));
}
setInterval(refreshNetMode, 4000);

const now = () => Date.now();

// ---- Host heartbeat + client watchdog (reliable detection of host loss) ----
function startHostHeartbeat() {
  stopHostHeartbeat();
  hostHb = setInterval(() => { conns.forEach((c) => { try { if (c.open) c.send({ type: 'ping' }); } catch (e) { /* */ } }); }, 3000);
}
function stopHostHeartbeat() { if (hostHb) { clearInterval(hostHb); hostHb = null; } }

// If we're a client and haven't received anything from the host in 8s -> re-election.
// The client also sends its own heartbeat so the host knows it's alive.
setInterval(() => {
  if (mode === 'client' && conns[0] && conns[0].open) {
    try { conns[0].send({ type: 'ping' }); } catch (e) { /* */ }
    if (lastHostMsg && (now() - lastHostMsg > 8000) && !clientRetry) scheduleClientRetry();
  }
  // Host: removes clients silent for > 9s (tab closed without a signal).
  if (mode === 'host' && conns.length) {
    const cutoff = now() - 9000;
    const before = conns.length;
    conns = conns.filter((c) => {
      const alive = !c._lastSeen || c._lastSeen > cutoff;
      if (!alive) { try { c.close(); } catch (e) { /* */ } }
      return alive;
    });
    if (conns.length !== before) broadcastPresence();
  }
}, 2000);

function resetSyncState() {
  conns = [];
  tombstones = new Set();
  mtimes = {};
  prevSigs = {};
  prevLocalIds = null;
  forceFull = false;
  lastDelSig = '';
}

// ---- Content construction (no camera; positions = spawn hint) ----
function localIds() {
  const ids = new Set();
  state.nodes.forEach(n => { if (n.kind !== 'liaison') ids.add(n.id); });
  state.circles.forEach(c => ids.add(c.id));
  state.hexagons.forEach(h => ids.add(h.id));
  return ids;
}
function nodeEntry(n) {
  if (n.ref !== undefined) return { ref: n.ref, x: n.x, y: n.y, w: n.w, h: n.h };
  const e = { t: n.text || '', img: n.image || null, x: n.x, y: n.y, w: n.w, h: n.h };
  if (n.kind === 'pancarte') e.k = 'pancarte';
  if (n.link) e.lk = n.link;
  if (n.color) e.col = n.color;
  return e;
}
// For the image: the 'idb:<hash>' ref is short and changes with the content -> we
// use it as-is; a legacy data URL (long) is reduced to its length (size proxy).
function imgSig(img) { return img ? (img.length < 128 ? img : img.length) : 0; }
function sigNode(e) { return e.vc ? 'V' + e.dur : e.cn ? 'C' + e.yml + '|' + e.disp + '|' + e.br + '|' + e.cf + '|' + e.sws + '|' + e.swe + '|' + e.ct + '|' + (e.col || '') : (e.ref !== undefined ? 'R' + e.ref : 'T' + e.t + '|' + imgSig(e.img) + '|' + (e.lk || '') + '|' + (e.col || '')); }
function sigZone(e) { return 'Z' + e.col + '' + e.d; }

function buildContent() {
  const n = {}, c = {}, h = {};
  for (const node of state.nodes) {
    if (node.kind === 'liaison') continue;
    if (node.kind === 'voice') { n[node.id] = { vc: 1, dur: node.dur || 0, x: node.x, y: node.y, w: node.w, h: node.h }; continue; }
    if (node.kind === 'connector') {
      // In bridge mode the yaml (device address/credentials) is never sent
      // to peers -- only the creator's own device keeps it, everyone else
      // must go through switchReq/switchRes (see handleData) to actuate it.
      n[node.id] = {
        cn: 1, disp: node.display || 'triangle', cf: node.clockFormat || 'HH:MM:SS', creator: node.creatorUid || null, br: !!node.bridge,
        yml: node.bridge ? '' : (node.yaml || ''), col: node.color || undefined,
        // Clock display, stopwatch/countdown modes only:
        sws: node.stopwatchStart || 0, swe: node.stopwatchElapsed || 0, ct: node.countdownTarget || 0,
        x: node.x, y: node.y, w: node.w, h: node.h,
      };
      continue;
    }
    n[node.id] = nodeEntry(node);
  }
  for (const z of state.circles) c[z.id] = { col: z.color, d: z.description || '', x: z.x, y: z.y, r: z.r };
  for (const z of state.hexagons) h[z.id] = { col: z.color, d: z.description || '', x: z.x, y: z.y, r: z.r };
  return { n, c, h };
}
function sigMap(content) {
  const m = {};
  for (const id in content.n) m[id] = sigNode(content.n[id]);
  for (const id in content.c) m[id] = sigZone(content.c[id]);
  for (const id in content.h) m[id] = sigZone(content.h[id]);
  return m;
}

// ---- Tick: detects content changes and broadcasts in DELTA ----
// seed = true -> the first send is the full board (new host or board to seed).
function startTick(seed) {
  stopTick();
  prevLocalIds = localIds();
  prevSigs = sigMap(buildContent());
  for (const id in prevSigs) if (!mtimes[id]) mtimes[id] = now();
  forceFull = !!seed;
  lastDelSig = '';
  tickTimer = setInterval(tick, 800);
}
function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

function tick() {
  // Detects local deletions (id present at the previous tick, absent now).
  const ids = localIds();
  if (prevLocalIds) {
    for (const id of prevLocalIds) {
      if (!ids.has(id)) { tombstones.add(id); delete mtimes[id]; delete prevSigs[id]; }
    }
  }
  prevLocalIds = ids;

  const content = buildContent();
  const sigs = sigMap(content);
  const changed = [];
  for (const id in sigs) { if (prevSigs[id] !== sigs[id]) { mtimes[id] = now(); changed.push(id); } }
  prevSigs = sigs;

  const delSig = String(tombstones.size);
  const delChanged = delSig !== lastDelSig;
  if (!forceFull && !changed.length && !delChanged) return; // nothing new (positions ignored)

  let outN, outC, outH, mtOut;
  if (forceFull) {
    outN = content.n; outC = content.c; outH = content.h; mtOut = { ...mtimes };
    forceFull = false;
  } else {
    outN = {}; outC = {}; outH = {}; mtOut = {};
    for (const id of changed) {
      if (content.n[id]) outN[id] = content.n[id];
      else if (content.c[id]) outC[id] = content.c[id];
      else if (content.h[id]) outH[id] = content.h[id];
      mtOut[id] = mtimes[id];
    }
  }
  lastDelSig = delSig;
  const payload = { type: 'sync', from: mode, ver: MY_VERSION, n: outN, c: outC, h: outH, mt: mtOut, del: [...tombstones], readOnly: state.readOnly, bn: getBoardName() || undefined };
  conns.forEach(c => { try { if (c.open) c.send(payload); } catch (e) { /* */ } });
}

// ---- Merging a remote payload ----
function findLocal(id) {
  return state.nodes.find(n => n.id === id) || state.circles.find(c => c.id === id) || state.hexagons.find(h => h.id === id);
}

// A board-link block's `link` must NEVER be an absolute URL -- see boards.js:
// buildBoardUrl. A peer on an older build (or the desktop app, which used to
// bake in its own http://127.0.0.1:<port> address) could still send one over
// the wire; this re-derives the origin-less form on arrival, same as the
// migration state.js:load() already does for a freshly loaded/imported board.
function normalizeLink(lk) {
  if (!lk) return lk;
  const bu = parseBoardUrl(lk);
  return bu ? buildBoardUrl(bu.id, bu.peer) : lk;
}

function merge(remote) {
  let changed = false;
  const applied = new Set();

  // Board name: adopted once from the first sync that carries one, as long
  // as we don't already have one locally (never overwrites a name we
  // already know, whether it came from our own earlier edit or an earlier
  // sync) -- replaces the old ?name=/?peer_name= URL params, which were
  // just an awkward, easy-to-desync way of carrying the exact same info.
  // Also names the liaison it arrived from (recordLiaison keeps any local
  // rename regardless). remote.bn === the board id is the sender's own
  // "nothing chosen yet" fallback (never persisted as a real name locally,
  // see main.js: resolveBoardName -- but a headless host on an old build,
  // or any other implementation, might still send it) -- not a real name,
  // ignored so a genuine one can still land later.
  if (remote.bn && remote.bn !== getBoardId() && !getBoardName()) {
    setBoardName(remote.bn);
    recordBoard(getBoardId(), remote.bn, mode === 'client' ? hostId() : null);
    if (mode === 'client') recordLiaison(hostId(), remote.bn);
    changed = true;
    refreshBoardNameUI();
  }

  for (const id of remote.del || []) {
    tombstones.add(id);
    const el = findLocal(id);
    if (el) { if (el.kind === 'voice') delAudio(id); if (el.kind === 'connector') stopPolling(id); explodeElementCascade(el); removeById(id); delete mtimes[id]; applied.add(id); changed = true; }
  }

  const win = (id) => {
    const rm = (remote.mt && remote.mt[id]) || 0;
    const lm = mtimes[id] || 0;
    if (rm !== lm) return rm > lm;
    // Tied timestamp: prefer whoever runs the newer app build (e.g. a stale
    // host tab or an outdated Pi shouldn't keep overwriting a peer that's
    // already redeployed); falls back to host priority when versions match
    // or either side's version is unknown.
    if (remote.ver && MY_VERSION && remote.ver !== MY_VERSION) return remote.ver > MY_VERSION;
    return remote.from === 'host';
  };

  for (const id in remote.n || {}) {
    if (tombstones.has(id)) continue;
    const rd = remote.n[id];
    const ex = state.nodes.find(x => x.id === id);
    if (!ex) {
      let node;
      if (rd.vc) node = { id, x: rd.x, y: rd.y, w: rd.w, h: rd.h, kind: 'voice', dur: rd.dur || 0 };
      else if (rd.cn) node = { id, x: rd.x, y: rd.y, w: rd.w, h: rd.h, kind: 'connector', yaml: rd.yml || '', display: rd.disp || 'triangle', clockFormat: rd.cf || 'HH:MM:SS', creatorUid: rd.creator || null, bridge: !!rd.br, color: rd.col || undefined, stopwatchStart: rd.sws || null, stopwatchElapsed: rd.swe || 0, countdownTarget: rd.ct || null };
      else node = rd.ref !== undefined
        ? { id, x: rd.x, y: rd.y, w: rd.w, h: rd.h, ref: rd.ref }
        : { id, x: rd.x, y: rd.y, w: rd.w, h: rd.h, text: rd.t || '', image: rd.img || undefined, color: rd.col || undefined };
      if (rd.k) node.kind = rd.k;
      if (rd.lk) node.link = normalizeLink(rd.lk);
      state.nodes.push(node); reset(node);
      if (rd.vc) ensureAudio(node); // fetches the audio from peers
      if (rd.cn) pollConnector(node).catch(() => {}); // this device polls the device independently too
      if (node.image) ensureImage(node.image); // fetches the image from peers
      mtimes[id] = (remote.mt && remote.mt[id]) || now();
      applied.add(id); changed = true;
    } else if (win(id)) {
      if (rd.vc) {
        // Existing block converted into a voice memo on the remote side (that's
        // how memos are created: the radial menu converts a rectangle). Without
        // this branch the receiver kept a plain rectangle until a full reload.
        if (ex.kind !== 'voice') {
          ex.kind = 'voice'; ex.dur = rd.dur || 0;
          delete ex.text; delete ex.image; delete ex.link;
          ensureAudio(ex);
          changed = true;
        } else if ((ex.dur || 0) !== (rd.dur || 0)) { ex.dur = rd.dur || 0; changed = true; }
      } else if (rd.cn) {
        if (ex.kind !== 'connector') { ex.kind = 'connector'; delete ex.text; delete ex.image; delete ex.link; changed = true; }
        if (!ex.creatorUid && rd.creator) { ex.creatorUid = rd.creator; changed = true; } // stamped once, never overwritten after
        if (!!ex.bridge !== !!rd.br) { ex.bridge = !!rd.br; changed = true; }
        if ((ex.yaml || '') !== (rd.yml || '')) { ex.yaml = rd.yml || ''; changed = true; pollConnector(ex).catch(() => {}); }
        if ((ex.color || '') !== (rd.col || '')) { ex.color = rd.col || undefined; changed = true; }
        if ((ex.display || 'triangle') !== (rd.disp || 'triangle')) { ex.display = rd.disp || 'triangle'; changed = true; pollConnector(ex).catch(() => {}); }
        if ((ex.clockFormat || 'HH:MM:SS') !== (rd.cf || 'HH:MM:SS')) { ex.clockFormat = rd.cf || 'HH:MM:SS'; changed = true; }
        if ((ex.stopwatchStart || 0) !== (rd.sws || 0)) { ex.stopwatchStart = rd.sws || null; changed = true; }
        if ((ex.stopwatchElapsed || 0) !== (rd.swe || 0)) { ex.stopwatchElapsed = rd.swe || 0; changed = true; }
        if ((ex.countdownTarget || 0) !== (rd.ct || 0)) { ex.countdownTarget = rd.ct || null; changed = true; }
      } else if (rd.ref !== undefined) { if (ex.ref !== rd.ref) { ex.ref = rd.ref; changed = true; } }
      else {
        if (ex.kind === 'voice') { delete ex.kind; delete ex.dur; changed = true; } // reverse conversion
        if (ex.kind === 'connector') { delete ex.kind; delete ex.yaml; delete ex.display; stopPolling(ex.id); changed = true; } // reverse conversion
        if ((ex.text || '') !== (rd.t || '')) { ex.text = rd.t || ''; changed = true; }
        const img = rd.img || undefined;
        if ((ex.image || undefined) !== img) { if (img) { ex.image = img; ensureImage(img); } else delete ex.image; changed = true; }
        const lk = normalizeLink(rd.lk) || undefined;
        if ((ex.link || undefined) !== lk) { if (lk) ex.link = lk; else delete ex.link; changed = true; }
        const col = rd.col || undefined;
        if ((ex.color || undefined) !== col) { if (col) ex.color = col; else delete ex.color; changed = true; }
      }
      mtimes[id] = remote.mt[id];
      applied.add(id);
    }
  }

  changed = mergeZones(state.circles, remote.c, remote, win, applied) || changed;
  changed = mergeZones(state.hexagons, remote.h, remote, win, applied) || changed;

  if (changed) {
    // Updates prevSigs ONLY for the ids touched by the merge, so we don't
    // swallow a local change that hasn't been sent yet.
    const sm = sigMap(buildContent());
    applied.forEach(id => { if (sm[id] != null) prevSigs[id] = sm[id]; else delete prevSigs[id]; });
    scheduleSave();
  }
}

function mergeZones(arr, rem, remote, win, applied) {
  if (!rem) return false;
  let changed = false;
  for (const id in rem) {
    if (tombstones.has(id)) continue;
    const rd = rem[id];
    const ex = arr.find(x => x.id === id);
    if (!ex) {
      arr.push({ id, x: rd.x, y: rd.y, r: rd.r, color: rd.col, description: rd.d });
      mtimes[id] = (remote.mt && remote.mt[id]) || now();
      applied.add(id); changed = true;
    } else if (win(id)) {
      if (ex.color !== rd.col) { ex.color = rd.col; changed = true; }
      if ((ex.description || '') !== rd.d) { ex.description = rd.d; changed = true; }
      mtimes[id] = remote.mt[id];
      applied.add(id);
    }
  }
  return changed;
}

function handleData(msg, origin) {
  if (!msg) return;
  // Read-only board: content coming from a guest is ignored outright (never
  // merged, never relayed) -- 'origin' is only ever set for messages actually
  // received from a peer connection (see the 3 conn.on('data', ...) call
  // sites), so this can never fire for our own local edits.
  if (mode === 'host' && state.readOnly && origin &&
      (msg.type === 'sync' || msg.type === 'move' || msg.type === 'delete')) {
    return;
  }
  if (msg.type === 'lock') {
    if (mode === 'client') state.readOnly = !!msg.readOnly; // the host is the only source of truth for this flag
    return;
  }
  if (msg.type === 'sync') {
    if (mode === 'client' && msg.readOnly !== undefined) state.readOnly = !!msg.readOnly;
    // Headless host (Pi) only: tells each connection individually whether its
    // owner token was recognized (see server/bete-host.js). A browser-hosted
    // liaison never sends this field, so iAmOwner just stays false there --
    // isOwner() already covers that case via mode === 'host' instead.
    if (mode === 'client' && msg.owner !== undefined) iAmOwner = !!msg.owner;
    let justFirst = false, remoteEmpty = false;
    if (mode === 'client' && clientFirstSync) {
      clientFirstSync = false;
      justFirst = true;
      reelectTries = 0; // sync received: the liaison is healthy
      reconnectTimes = []; loopWarned = false; // healthy again: forget past reconnect cycles
      // We only overwrite the local board IF the remote board has content.
      // If it's empty (fresh server board), we keep the local one: it will seed the server.
      remoteEmpty = !(msg.n && Object.keys(msg.n).length)
        && !(msg.c && Object.keys(msg.c).length)
        && !(msg.h && Object.keys(msg.h).length);
      if (!remoteEmpty) {
        state.nodes.length = 0;
        state.circles.length = 0;
        state.hexagons.length = 0;
        tombstones = new Set(); mtimes = {}; prevSigs = {}; prevLocalIds = null;
      }
    }
    merge(msg);
    // The client emits after the 1st sync. seed = remote board empty -> we send
    // our full board to seed it; otherwise we're already up to date -> deltas only.
    if (justFirst) startTick(remoteEmpty);
    // Host (browser-hosted liaison, no Pi): same active pull as the Pi host --
    // ask the sender directly for any brand-new voice memo's audio instead of
    // passively waiting for their proactive push to land.
    if (mode === 'host' && origin) {
      for (const nid in msg.n || {}) {
        if (msg.n[nid].vc) {
          getAudio(nid).then((blob) => { if (!blob) sendTo(origin, { type: 'audioReq', id: nid }); }).catch(() => {});
        }
      }
    }
  } else if (msg.type === 'move') {
    applyMove(msg);
  } else if (msg.type === 'delete') {
    applyDelete(msg);
  } else if (msg.type === 'audioReq') {
    // Do we have the audio? We answer. Otherwise, the host relays the request to others.
    getAudio(msg.id).then((blob) => {
      if (blob) blob.arrayBuffer().then((buf) => sendTo(origin, { type: 'audioRes', id: msg.id, mime: blob.type, buf }));
      else if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); });
    }).catch(() => {});
    return;
  } else if (msg.type === 'audioRes') {
    if (msg.buf) {
      const blob = new Blob([msg.buf], { type: msg.mime || 'audio/webm' });
      putAudio(msg.id, blob).then(() => { const el = findLocal(msg.id); if (el) { el._missing = false; el._loading = false; } }).catch(() => {});
    }
    if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); }); // relay to other clients
    return;
  } else if (msg.type === 'imgReq') {
    // Image requested by its hash: we answer if we have it, otherwise the host relays it.
    getImage(msg.hash).then((blob) => {
      if (blob) blob.arrayBuffer().then((buf) => sendTo(origin, { type: 'imgRes', hash: msg.hash, mime: blob.type, buf }));
      else if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); });
    }).catch(() => {});
    return;
  } else if (msg.type === 'imgRes') {
    if (msg.buf) {
      const blob = new Blob([msg.buf], { type: msg.mime || 'image/png' });
      putImage(msg.hash, blob).then(() => onImageArrived(msg.hash, blob)).catch(() => {});
    }
    if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); }); // relay to other clients
    return;
  } else if (msg.type === 'hello') {
    if (origin) { origin._uid = msg.uid; origin._name = msg.name; origin._peerId = msg.peerId; origin._voice = msg.voice; }
    broadcastPresence(); // host: updates the list for everyone
    return;
  } else if (msg.type === 'presence') {
    clientRoster = Array.isArray(msg.users) ? msg.users : [];
    return;
  } else if (msg.type === 'ping') {
    return; // host heartbeat: just a proof of life (see lastHostMsg)
  } else if (msg.type === 'cursor') {
    if (msg.uid !== getUserId()) cursors[msg.uid] = { name: msg.name, x: msg.x, y: msg.y, t: now() };
    if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); }); // relay to others
    return;
  } else if (msg.type === 'switchReq') {
    // Network-bridge connector: only the creator's device has the real yaml
    // and can reach the device -- everyone else's toggle click ends up here,
    // relayed (star topology: guests only ever talk to the host) until it
    // reaches that one device.
    const node = findLocal(msg.id);
    if (!node || node.kind !== 'connector') return;
    if (node.creatorUid === getUserId()) {
      toggleSwitch(node).then(() => broadcastSwitchState(node));
    } else if (mode === 'host') {
      const target = conns.find((c) => c._uid === node.creatorUid);
      if (target && target !== origin) sendTo(target, msg);
    }
    return;
  } else if (msg.type === 'switchRes') {
    const node = findLocal(msg.id);
    if (node) { node._value = msg.value; node._status = msg.status; }
    if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); });
    return;
  } else if (msg.type === 'icsReq') {
    // A peer can't reach this calendar itself (CORS/offline): we try on
    // their behalf (desktop's native fetch, or our own configured proxy).
    // If WE can't either, the host relays the request further out (star
    // topology: a plain client only ever talks to the host).
    fetchIcsLocal(msg.url).then((text) => sendTo(origin, { type: 'icsRes', url: msg.url, text }))
      .catch(() => { if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); }); });
    return;
  } else if (msg.type === 'icsRes') {
    resolveIcsPeerResponse(msg.url, msg.text, msg.error);
    if (mode === 'host') conns.forEach((c) => { if (c !== origin) sendTo(c, msg); }); // relay back toward whoever actually asked
    return;
  }
  // The host relays one-off events to the other clients.
  if (mode === 'host' && (msg.type === 'move' || msg.type === 'delete')) {
    conns.forEach((c) => { if (c !== origin) { try { if (c.open) c.send(msg); } catch (e) { /* */ } } });
  }
}

function sendTo(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) { /* */ } }

function broadcastSwitchState(node) {
  const msg = { type: 'switchRes', id: node.id, value: node._value, status: node._status };
  if (mode === 'host') conns.forEach((c) => sendTo(c, msg));
  else if (mode === 'client' && conns[0]) sendTo(conns[0], msg);
}

// Bridge-mode toggle from a peer who doesn't have the connector's yaml
// (see buildContent()): routes the request towards whichever device is the
// creator, through the host if we're not it ourselves.
export function requestSwitchToggle(id) {
  if (!conns.length) return;
  if (mode === 'host') handleData({ type: 'switchReq', id }, null);
  else if (mode === 'client') sendTo(conns[0], { type: 'switchReq', id });
}

// ---- Voice memo sharing (binary audio over the DataChannel) ----
// Broadcasts freshly recorded audio to all peers (host -> clients,
// client -> host which relays). Called by voice.js after recording.
export function shareAudio(id, blob) {
  if (!conns.length || !blob) return;
  blob.arrayBuffer().then((buf) => {
    conns.forEach((c) => sendTo(c, { type: 'audioRes', id, mime: blob.type, buf }));
  });
}

// Requests a memo's audio from peers (if we don't have it locally).
export function requestAudio(id) {
  if (!conns.length) return;
  conns.forEach((c) => sendTo(c, { type: 'audioReq', id }));
}

// ---- Image sharing (binary blob over the DataChannel, like audio) ----
// Broadcasts a freshly added image to all peers (from its 'idb:<hash>' ref).
export function shareImage(ref) {
  if (!conns.length || !ref || ref.indexOf('idb:') !== 0) return;
  const hash = ref.slice(4);
  getImage(hash).then((blob) => {
    if (!blob) return;
    blob.arrayBuffer().then((buf) => {
      conns.forEach((c) => sendTo(c, { type: 'imgRes', hash, mime: blob.type, buf }));
    });
  }).catch(() => {});
}

// Requests an image from peers by its hash (called by images.js if missing locally).
export function requestImage(hash) {
  if (!conns.length || !hash) return;
  conns.forEach((c) => sendTo(c, { type: 'imgReq', hash }));
}

// Asks connected peers to fetch a .ics calendar we couldn't reach ourselves
// (called by ics.js). Returns false when there's nobody to ask (caller
// shouldn't bother waiting on a timeout in that case).
export function requestIcsFromPeers(url) {
  if (!conns.length || !url) return false;
  conns.forEach((c) => sendTo(c, { type: 'icsReq', url }));
  return true;
}

// On receiving a remote memo: fetches the audio if missing locally.
function ensureAudio(node) {
  getAudio(node.id).then((blob) => {
    if (blob) return;
    node._missing = true;
    requestAudio(node.id);
  }).catch(() => {});
}

// Periodic retry for voice memos still flagged _missing: unlike images (which
// get a fresh request on every render frame via getImageEl), a memo's audio is
// only fetched once, when the node first arrives. If that single round trip is
// lost (e.g. the host hadn't cached it yet, a transient connection hiccup),
// nothing ever retried it before — the block stayed broken until a page reload
// forced a fresh full sync. This self-heals the same way images already do.
setInterval(() => {
  if (!conns.length) return;
  for (const n of state.nodes) if (n.kind === 'voice' && n._missing) requestAudio(n.id);
}, 4000);

// On receiving a remote image block: fetches the image if missing locally.
function ensureImage(ref) {
  if (!ref || ref.indexOf('idb:') !== 0) return; // legacy data URL: nothing to fetch
  const hash = ref.slice(4);
  getImage(hash).then((blob) => { if (!blob) requestImage(hash); }).catch(() => {});
}

// Position dropped: updates the target (the spring animates it on the node side).
function applyMove(msg) {
  const el = findLocal(msg.id);
  if (!el) return;
  if (msg.x != null) el.x = msg.x;
  if (msg.y != null) el.y = msg.y;
  if (msg.w != null) el.w = msg.w;
  if (msg.h != null) el.h = msg.h;
  if (msg.r != null) el.r = msg.r;
  scheduleSave();
}

function applyDelete(msg) {
  tombstones.add(msg.id);
  const el = findLocal(msg.id);
  if (el) { if (el.kind === 'voice') delAudio(el.id); explodeElementCascade(el); removeById(msg.id); delete mtimes[msg.id]; delete prevSigs[msg.id]; scheduleSave(); }
}

// Called on releasing an object (drop): broadcasts its final position.
export function pushMove(el) {
  if (!conns.length || !el) return;
  const msg = el.r !== undefined
    ? { type: 'move', id: el.id, x: el.x, y: el.y, r: el.r }
    : { type: 'move', id: el.id, x: el.x, y: el.y, w: el.w, h: el.h };
  conns.forEach((c) => { try { if (c.open) c.send(msg); } catch (e) { /* */ } });
}

// Called on deletion: triggers the explosion on peers.
export function pushDelete(id) {
  if (!conns.length) return;
  conns.forEach((c) => { try { if (c.open) c.send({ type: 'delete', id }); } catch (e) { /* */ } });
}

// Stable, persisted peer id: refreshing the host keeps the same link/QR.
// Long & random (128 bits): it's the room key on the shared PeerJS network,
// so this avoids collisions and guessability.
function makeId() {
  try {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return 'tm-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return 'tm-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
}
function getStableId() {
  try {
    let id = localStorage.getItem('bete:peer');
    if (!id) { id = makeId(); localStorage.setItem('bete:peer', id); }
    return id;
  } catch (e) { return makeId(); }
}
function rotateStableId() {
  const id = makeId();
  try { localStorage.setItem('bete:peer', id); } catch (e) { /* */ }
  return id;
}

// ---- HOST ----
let hostPeer = null;
let hostNode = null;
let idRetries = 0;

export async function startHost(node) {
  stopHost();
  mode = 'host';
  hostNode = node;
  node.status = 'init';
  try {
    await Promise.all([loadPeer(), loadQR()]);
  } catch (e) {
    node.status = 'error';
    console.warn('Bete: failed to load PeerJS/QR', e);
    return;
  }
  idRetries = 0;
  openHostPeer(getStableId());
}

function openHostPeer(id) {
  const peer = new Peer(id);
  hostPeer = peer;
  attachCallHandler(peer);

  peer.on('open', (realId) => {
    idRetries = 0;
    hostNode.peerId = realId; hostNode.code = realId; hostNode.url = buildUrl(realId); hostNode.status = 'online';
    // A liaison you HOST never went through recordLiaison() before (that only
    // ever ran on the client side, when joining via ?peer=) -- so creating one
    // and then just navigating away used to lose it entirely, with no way
    // back short of re-sharing the link. Bookmark it here too, named after
    // this board, and point this board's own "boards" directory entry at it
    // (see boards.js: recordBoard) so it shows up grouped under its liaison
    // there too, instead of staying "unlinked" forever. Also propagates to
    // every OTHER saved board's own link blocks pointing at this one (e.g.
    // Home's link to it, made back when this board had no liaison yet) --
    // without this they'd stay peer-less forever, so clicking them would
    // never actually connect (see boards.js: rewriteLinksForBoard).
    recordLiaison(realId, getBoardName() || undefined);
    recordBoard(getBoardId(), null, realId);
    rewriteLinksForBoard(getBoardId(), realId, getBoardId());
    startTick(true);
    startHostHeartbeat();
  });
  peer.on('disconnected', () => {
    // Lost the connection to the broker: keep the same id and retry.
    if (hostNode) hostNode.status = 'reconnecting';
    try { if (hostPeer && !hostPeer.destroyed) hostPeer.reconnect(); } catch (e) { /* */ }
  });
  peer.on('error', (err) => {
    if (err && err.type === 'unavailable-id') {
      // Id still taken (refreshed too fast / another tab): retry the same
      // one a few times, then fall back to a new id as a last resort.
      try { peer.destroy(); } catch (e) { /* */ }
      const next = idRetries < 3 ? (idRetries++, id) : rotateStableId();
      setTimeout(() => { if (mode === 'host') openHostPeer(next); }, idRetries ? 1500 : 300);
      return;
    }
    if (hostNode) hostNode.status = 'error';
    console.warn('Bete: peer error (host)', err);
  });
  peer.on('connection', (conn) => {
    conn._lastSeen = now();
    conns.push(conn);
    if (hostNode) hostNode.status = 'connected';
    conn.on('open', () => {
      const content = buildContent(); // current state sent immediately to the newcomer
      try { conn.send({ type: 'sync', from: 'host', ver: MY_VERSION, n: content.n, c: content.c, h: content.h, mt: { ...mtimes }, del: [...tombstones], readOnly: state.readOnly, bn: getBoardName() || undefined }); } catch (e) { /* */ }
      retryFailedIcs(); // a calendar block whose first attempt lost the connection race can use this new peer now
    });
    conn.on('data', (msg) => { conn._lastSeen = now(); handleData(msg, conn); });
    conn.on('close', () => { conns = conns.filter(c => c !== conn); broadcastPresence(); });
    conn.on('error', () => { conns = conns.filter(c => c !== conn); broadcastPresence(); });
  });
}

export function stopHost() {
  stopTick();
  stopHostHeartbeat();
  resetSyncState();
  mode = null;
  hostNode = null;
  idRetries = 0;
  if (hostPeer) { try { hostPeer.destroy(); } catch (e) { /* */ } hostPeer = null; }
}

// Reuses the already-open host peer (liaison block deleted then recreated)
// instead of creating a new one: avoids id churn on the broker (which used
// to cause a long "reconnecting" state + an unwanted rotation of the stable
// id). Returns false if there's no live host peer to adopt (-> startHost is needed).
export function adoptHost(node) {
  if (mode !== 'host' || !hostPeer || hostPeer.destroyed) return false;
  hostNode = node;
  if (hostPeer.open && hostPeer.id) {
    node.peerId = hostPeer.id; node.code = hostPeer.id; node.url = buildUrl(hostPeer.id); node.status = 'online';
  } else {
    node.status = 'init'; // still opening: the 'open' event will fill in the node
  }
  return true;
}

// Detaches the liaison block without stopping the hosting (peer + sync stay
// alive for the session), so a recreation is instant.
export function detachHost() { hostNode = null; }

// Regenerates a new id (the old link/QR becomes invalid) without losing the board.
// Useful if the URL leaked. Clients already connected on the old id are dropped.
export function refreshHostId(node) {
  if (mode !== 'host' || !node) return;
  hostNode = node;
  node.status = 'init';
  node.peerId = undefined;
  node.url = undefined;
  node.code = undefined;
  stopTick();
  conns = [];
  if (hostPeer) { try { hostPeer.destroy(); } catch (e) { /* */ } hostPeer = null; }
  idRetries = 0;
  openHostPeer(rotateStableId());
}

// Releases the id at the broker when closing/refreshing (to reclaim it afterwards).
window.addEventListener('beforeunload', () => { if (hostPeer) { try { hostPeer.destroy(); } catch (e) { /* */ } } });

// ---- CLIENT ----
let clientPeer = null;
let clientPeerId = null;
let clientStatus = null;
let clientRetry = null;

export async function joinHost(peerId, onStatus) {
  clientPeerId = peerId;
  clientStatus = onStatus;
  try { await loadPeer(); } catch (e) { onStatus && onStatus('error'); return; }
  mode = 'client';
  clientFirstSync = true;
  onStatus && onStatus('connecting');
  const peer = new Peer();
  clientPeer = peer;
  attachCallHandler(peer);

  peer.on('open', () => connectToHost());
  peer.on('disconnected', () => { try { if (clientPeer && !clientPeer.destroyed) clientPeer.reconnect(); } catch (e) { /* */ } });
  peer.on('error', (err) => { console.warn('Bete: peer error (client)', err); scheduleClientRetry(); });
}

function connectToHost() {
  if (!clientPeer || clientPeer.destroyed) return;
  const conn = clientPeer.connect(clientPeerId, { reliable: true, metadata: { board: getBoardId(), ownerToken: getOwnerToken(getBoardId()) } });
  conns = [conn];
  clientRoster = [];
  lastHostMsg = now();
  // The tick (emission) only starts after the 1st sync is received (see handleData).
  conn.on('open', () => {
    lastHostMsg = now(); clientStatus && clientStatus('connected');
    try { conn.send(helloMsg()); } catch (e) { /* */ }
    retryFailedIcs(); // a calendar block whose first attempt lost the connection race can use this new peer now
  });
  conn.on('data', (msg) => {
    lastHostMsg = now(); // any message (including ping) proves the host is alive
    const wasFirst = clientFirstSync && msg && msg.type === 'sync';
    handleData(msg, conn); // origin = our single host connection (needed to answer audioReq/imgReq)
    if (wasFirst) clientStatus && clientStatus('synced');
  });
  conn.on('close', () => { clientStatus && clientStatus('closed'); scheduleClientRetry(); });
  conn.on('error', () => scheduleClientRetry());
}

// Host election: when opening a ?peer=, we first try to BECOME the host by
// claiming that id. If the id is already taken (a host exists), we switch to client.
// => the first one to arrive on a hostless liaison takes the role.
export async function joinOrHost(peerId, onStatus) {
  clientPeerId = peerId;
  clientStatus = onStatus;
  try { await loadPeer(); } catch (e) { onStatus && onStatus('error'); return; }
  onStatus && onStatus('connecting');
  const probe = new Peer(peerId);
  attachCallHandler(probe);
  let settled = false;
  probe.on('open', () => {
    if (settled) return; settled = true;
    mode = 'host';
    hostPeer = probe;
    hostNode = null;
    wireHostPeer(probe);
    startTick(true); // broadcasts our full board (becomes the liaison's reference)
    startHostHeartbeat();
    reelectTries = 0;
    onStatus && onStatus('host');
  });
  probe.on('error', (err) => {
    const t = err && err.type;
    if (settled) return;
    if (t === 'unavailable-id') { // a host already holds the id -> we join as a client
      settled = true;
      try { probe.destroy(); } catch (e) { /* */ }
      joinHost(peerId, onStatus);
    } else {
      console.warn('Bete: host election error', err);
    }
  });
  probe.on('disconnected', () => { try { if (probe === hostPeer && !probe.destroyed) probe.reconnect(); } catch (e) { /* */ } });
}

// Wires incoming connections onto a host peer (without rotating the id).
function wireHostPeer(peer) {
  peer.on('connection', (conn) => {
    conn._lastSeen = now();
    conns.push(conn);
    conn.on('open', () => {
      const c = buildContent();
      try { conn.send({ type: 'sync', from: 'host', ver: MY_VERSION, n: c.n, c: c.c, h: c.h, mt: { ...mtimes }, del: [...tombstones], readOnly: state.readOnly, bn: getBoardName() || undefined }); } catch (e) { /* */ }
      retryFailedIcs(); // same fix as the other host-connection wiring above -- was missing here
    });
    conn.on('data', (msg) => { conn._lastSeen = now(); handleData(msg, conn); });
    conn.on('close', () => { conns = conns.filter((x) => x !== conn); broadcastPresence(); });
    conn.on('error', () => { conns = conns.filter((x) => x !== conn); broadcastPresence(); });
  });
}

// Tracks disconnect/reconnect cycles in a sliding window. If the liaison is
// stuck flapping (e.g. a broken network path that "succeeds" just long enough
// to drop again), reconnecting forever never fixes it -- only a full page
// reload (fresh WebRTC/ICE state) reliably does. Report it once so the UI can
// suggest that, instead of silently retrying forever.
function noteReconnectCycle() {
  const t = now();
  reconnectTimes.push(t);
  reconnectTimes = reconnectTimes.filter((x) => t - x < LOOP_WINDOW);
  if (!loopWarned && reconnectTimes.length >= LOOP_THRESHOLD) {
    loopWarned = true;
    clientStatus && clientStatus('loop');
  }
}

// Automatic client reconnection if the host goes down (network error / refresh).
function scheduleClientRetry() {
  if (mode !== 'client' || clientRetry) return;
  noteReconnectCycle();
  clientStatus && clientStatus('reconnecting');
  clientRetry = setTimeout(() => {
    clientRetry = null;
    clientFirstSync = true; // will re-adopt the new host's state
    stopTick();
    clientRoster = [];
    try { if (clientPeer && !clientPeer.destroyed) clientPeer.destroy(); } catch (e) { /* */ }
    clientPeer = null;
    // We prefer a simple client RECONNECT (the host might just be restarting);
    // we only attempt a host ELECTION after several failures (avoids stealing the Pi's id).
    reelectTries++;
    if (reelectTries <= 3) joinHost(clientPeerId, clientStatus);
    else joinOrHost(clientPeerId, clientStatus);
  }, 3000);
}
