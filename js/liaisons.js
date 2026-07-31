// Named liaisons (local to the browser): Server 1, Family, Temporary…
// A liaison = a peer (host) id to connect to, + a chosen name.
const KEY = 'bete:liaisons';

export function listLiaisons() {
  try { const a = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50))); } catch (e) { /* */ }
}

// Adds (or bumps) a liaison. name is optional (defaults to the id).
// A name passed here (e.g. from a share URL) never overwrites a name the
// user chose locally (renameLiaison sets the renamed flag; entries from
// before that flag existed count as renamed when their name differs from
// the raw peer id).
export function recordLiaison(peer, name) {
  if (!peer) return;
  const list = listLiaisons();
  const i = list.findIndex((x) => x.peer === peer);
  if (i >= 0) {
    const renamed = list[i].renamed || (list[i].name && list[i].name !== peer);
    if (name && !renamed) list[i].name = name;
    const [e] = list.splice(i, 1);
    list.unshift(e);
  } else {
    list.unshift({ peer, name: name || peer });
  }
  save(list);
}

export function renameLiaison(peer, name) {
  const list = listLiaisons();
  const i = list.findIndex((x) => x.peer === peer);
  if (i >= 0) { list[i].name = name || peer; list[i].renamed = true; save(list); }
}

export function removeLiaison(peer) {
  save(listLiaisons().filter((x) => x.peer !== peer));
}

// Changes a liaison's peer id in place (keeps its name/renamed flag) --
// used when the underlying peer was rotated by hand (e.g. the Raspberry Pi's
// id regenerated for security reasons) and every local reference should
// follow. Refuses if the new id is already used by another liaison entry
// (would collide). See boards.js: rewriteLinksPeer/renameBoardsPeer for the
// companion updates to actual board-link blocks -- this only renames the
// liaison bookmark itself.
export function changeLiaisonPeer(oldPeer, newPeer) {
  if (!oldPeer || !newPeer || oldPeer === newPeer) return false;
  const list = listLiaisons();
  if (list.some((x) => x.peer === newPeer)) return false;
  const i = list.findIndex((x) => x.peer === oldPeer);
  if (i < 0) return false;
  list[i] = { ...list[i], peer: newPeer };
  save(list);
  return true;
}

export function getLiaison(peer) {
  return listLiaisons().find((x) => x.peer === peer) || null;
}

// Optional board passphrase (opt-in, per-board): a second secret required
// (in addition to the link/peer id itself) for a guest to actually sync --
// see sync.js: setBoardPassphrase for the full flow. Only the SHA-256 hash
// is ever stored or transmitted, never the plaintext -- there's nothing to
// leak from localStorage even if this device is compromised, at the cost of
// the phrase itself not being recoverable/redisplayable once set (same as a
// real password: only replace or clear it, never "show current").
//
// The SAME storage key is used on both sides of a connection, just with a
// different role depending on which one this device happens to be for this
// board: on the HOST (or the Pi's owner), it's the hash a guest's own hash
// must match; on a GUEST device, it's the hash sent along on every connect
// attempt. Both read/write it through getBoardPassHash/setBoardPassHash --
// there's no ambiguity in practice since a given board id only ever plays
// one of those roles on a given device.
const PASS_KEY_PREFIX = 'bete:boardpass:';

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getBoardPassHash(boardId) {
  try { return localStorage.getItem(PASS_KEY_PREFIX + (boardId || 'home')) || null; } catch (e) { return null; }
}

// Hashes and stores a plaintext passphrase locally (empty/falsy clears the
// requirement). Returns the resulting hash (or null if cleared), so callers
// that also need to propagate it elsewhere (e.g. to a headless Pi host, see
// sync.js) don't have to re-derive it.
export async function setBoardPassHash(boardId, plaintext) {
  const key = PASS_KEY_PREFIX + (boardId || 'home');
  if (!plaintext) { try { localStorage.removeItem(key); } catch (e) { /* */ } return null; }
  const hash = await sha256Hex(plaintext);
  try { localStorage.setItem(key, hash); } catch (e) { /* */ }
  return hash;
}

// Hashes a plaintext passphrase without storing it -- used by a guest device
// to compute what to send on a connection attempt before it's known whether
// that attempt will even succeed (see sync.js: connectToHost).
export async function hashPassphrase(plaintext) {
  return plaintext ? sha256Hex(plaintext) : null;
}

// Owner token (per board): a random secret this browser presents to a
// headless host (e.g. Raspberry Pi, see server/bete-host.js) to prove it's
// the board's owner there. The server adopts whichever token shows up first
// for a fresh board (first-claim, same trust model as the peer id itself)
// and checks it on every later connection -- a browser-hosted liaison never
// needs this (the hosting tab edits state directly, no token involved), but
// sending it there too is harmless (a browser host just ignores it).
const OWNER_KEY_PREFIX = 'bete:ownerkey:';
export function getOwnerToken(boardId) {
  const key = OWNER_KEY_PREFIX + (boardId || 'home');
  try {
    let token = localStorage.getItem(key);
    if (!token) {
      token = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ('o-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem(key, token);
    }
    return token;
  } catch (e) { return null; }
}
