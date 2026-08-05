// IndexedDB is used to store binary blobs (voice memos AND images) AND the
// daily board-history snapshots (see history.js) because localStorage isn't
// suitable for large or fast-growing data. Audio is indexed by block ID;
// images are indexed by their content hash (so an identical image is stored
// once and referenced by 'idb:<hash>'); history is indexed by board id.
// The state/board only stores a small reference, never the bytes.
const DB_NAME = 'bete';
const STORE = 'audio';
const IMG_STORE = 'images';
const HISTORY_STORE = 'history';
let _db = null;

// Open the IndexedDB database (or return the existing connection). Version 2
// added the 'images' store, version 3 the 'history' store (both created on
// upgrade for existing users on an older version).
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      if (!d.objectStoreNames.contains(IMG_STORE)) d.createObjectStore(IMG_STORE);
      if (!d.objectStoreNames.contains(HISTORY_STORE)) d.createObjectStore(HISTORY_STORE);
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

// Store an audio blob in IndexedDB under the given ID.
export async function putAudio(id, blob) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Retrieve an audio blob from IndexedDB by its ID.
export async function getAudio(id) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(id);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}

// Delete an audio blob from IndexedDB by its ID.
export async function delAudio(id) {
  const d = await db();
  return new Promise((res) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

// ---- Images (indexed by content hash) ----
export async function putImage(hash, blob) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).put(blob, hash);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function getImage(hash) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(IMG_STORE, 'readonly');
    const rq = tx.objectStore(IMG_STORE).get(hash);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}

// Keys of every stored image blob (for the garbage collector in images.js).
export async function getAllImageHashes() {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(IMG_STORE, 'readonly');
    const rq = tx.objectStore(IMG_STORE).getAllKeys();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
}

export async function delImage(hash) {
  const d = await db();
  return new Promise((res) => {
    const tx = d.transaction(IMG_STORE, 'readwrite');
    tx.objectStore(IMG_STORE).delete(hash);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

// ---- Board history (one record per board id, value = array of daily snapshots) ----
export async function getHistory(boardId) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(HISTORY_STORE, 'readonly');
    const rq = tx.objectStore(HISTORY_STORE).get(boardId);
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
}

// Every history record (for the image garbage collector in images.js).
export async function getAllHistory() {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(HISTORY_STORE, 'readonly');
    const rq = tx.objectStore(HISTORY_STORE).getAll();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
}

export async function putHistory(boardId, entries) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).put(entries, boardId);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
