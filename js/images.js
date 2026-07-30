// Offloads images to IndexedDB (like voice memos): instead of storing an image
// as base64 in the synced content (huge, rebroadcast to every peer), it is
// stored in IndexedDB indexed by the HASH of its content, and the block only
// keeps a short reference 'idb:<hash>'. The bytes only transit ONCE per peer
// (via sync.js: imgReq/imgRes), and a peer that already has the image never
// re-downloads it.
import { putImage, getImage } from './audio.js?v=ms7chxev';
import { requestImage } from './sync.js?v=ms7chxev';

const els = new Map();   // ref -> HTMLImageElement (render cache, 1 per ref)
const urls = new Map();  // hash -> objectURL (decoded blob, reused)
const reqAt = new Map(); // hash -> last request to peers (throttle)
const RE_REQ = 4000;     // don't re-request the same image before 4s

function hashOf(ref) { return (ref && ref.indexOf('idb:') === 0) ? ref.slice(4) : null; }

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// data URL -> Blob (no fetch, so it works offline / on file://).
export function dataUrlToBlob(dataUrl) {
  const c = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, c), b64 = dataUrl.slice(c + 1);
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function cacheUrl(hash, blob) {
  let u = urls.get(hash);
  if (!u) { u = URL.createObjectURL(blob); urls.set(hash, u); }
  return u;
}

// Stores an image (data URL) in IndexedDB, returns its reference 'idb:<hash>'.
export async function storeImage(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const buf = await blob.arrayBuffer();
  const hash = await sha256Hex(buf);
  await putImage(hash, blob);
  cacheUrl(hash, blob);
  return 'idb:' + hash;
}

function requestOnce(hash) {
  const t = performance.now();
  if (t - (reqAt.get(hash) || 0) < RE_REQ) return;
  reqAt.set(hash, t);
  requestImage(hash);
}

async function loadFromDb(ref, hash, img) {
  try {
    const blob = await getImage(hash);
    if (blob) { img.src = cacheUrl(hash, blob); return; }
  } catch (e) { /* */ }
  requestOnce(hash); // not local -> ask peers (sync will relay it)
}

// <img> element to draw for a block reference (rendering). Handles:
//  - legacy data URL / http URL (YouTube thumbnail): direct src;
//  - 'idb:<hash>': loads the blob from IndexedDB (or requests it from peers).
export function getImageEl(ref) {
  let img = els.get(ref);
  if (img) {
    const hash = hashOf(ref);
    if (hash && !(img.complete && img.naturalWidth)) {
      if (urls.has(hash)) { if (img.src !== urls.get(hash)) img.src = urls.get(hash); }
      else requestOnce(hash);
    }
    return img;
  }
  img = new Image();
  els.set(ref, img);
  const hash = hashOf(ref);
  if (!hash) { img.src = ref; return img; } // legacy data URL or http URL
  const u = urls.get(hash);
  if (u) img.src = u; else loadFromDb(ref, hash, img);
  return img;
}

// Resolves a reference into a displayable src (for the "View image" popup).
export async function resolveSrc(ref) {
  if (!ref) return '';
  const hash = hashOf(ref);
  if (!hash) return ref;
  if (urls.has(hash)) return urls.get(hash);
  try { const blob = await getImage(hash); if (blob) return cacheUrl(hash, blob); } catch (e) { /* */ }
  requestOnce(hash);
  return '';
}

// True if a ref is already resolvable from THIS browser's IndexedDB (no peer
// request) -- a legacy data/http URL is always "local" (nothing to fetch).
// Used before export (see io.js: ensureMediaCached) to warn about a block
// whose bytes were never actually downloaded, only referenced.
export async function hasImageLocally(ref) {
  const hash = hashOf(ref);
  if (!hash) return true;
  if (urls.has(hash)) return true;
  try { return !!(await getImage(hash)); } catch (e) { return false; }
}

// Soft migration: converts legacy images (inline base64 data URL in the
// content) to a 'idb:<hash>' ref. Huge gain on old boards full of images
// (the synced content goes from several MB to a few bytes per block).
// Best-effort and idempotent: a block already in 'idb:' is skipped.
export async function migrateImages(nodes, onChange) {
  let n = 0;
  for (const node of nodes) {
    const img = node.image;
    if (!img || img.indexOf('data:') !== 0) continue; // already migrated / no image
    try { node.image = await storeImage(img); n++; } catch (e) { /* keeps the data URL */ }
  }
  if (n && onChange) onChange();
  return n;
}

export function blobToDataUrl(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res('');
    r.readAsDataURL(blob);
  });
}

// Re-inlines images ('idb:<hash>' -> data URL) for a self-contained JSON
// export (the file stays openable on another browser without peers). Mutates
// the given nodes (use a disposable copy, e.g. the result of serialize()).
export async function inlineImages(nodes) {
  for (const node of nodes || []) {
    const img = node.image;
    if (!img || img.indexOf('idb:') !== 0) continue;
    try { const blob = await getImage(img.slice(4)); if (blob) node.image = await blobToDataUrl(blob); } catch (e) { /* */ }
  }
}

// Called by sync.js when an image arrives from a peer: updates any waiting <img>.
export function onImageArrived(hash, blob) {
  const u = cacheUrl(hash, blob);
  els.forEach((img, ref) => { if (hashOf(ref) === hash) img.src = u; });
}
