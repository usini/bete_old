// JSON export / import.
import { serialize, load, getBoardId, scheduleSave } from './state.js?v=ms8kvlur';
import { reset } from './physics.js?v=ms8kvlur';
import { state } from './state.js?v=ms8kvlur';
import { inlineImages, migrateImages, hasImageLocally } from './images.js?v=ms8kvlur';
import { inlineAudio, restoreAudio, hasAudioLocally } from './voice.js?v=ms8kvlur';
import { requestImage, requestAudio, liaisonStatus } from './sync.js?v=ms8kvlur';
import { listBoards, recordBoard } from './boards.js?v=ms8kvlur';
import { t } from './i18n.js?v=ms8kvlur';
import { saveTextFile, writeExportFile } from './platform.js?v=ms8kvlur';
import { toast } from './main.js?v=ms8kvlur';

function downloadJSON(obj, filename) {
  saveTextFile(JSON.stringify(obj), filename, 'json');
}

// yyyy-mm-dd in local time, for export filenames (see exportJSON/exportAllBoards).
function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Scans nodes for image/audio references not yet cached in THIS browser's
// IndexedDB (see images.js/voice.js: hasImageLocally/hasAudioLocally) --
// exporting one as-is would bake in a dangling reference that can't resolve
// on another profile.
async function findMissingMedia(nodes) {
  const images = [], audio = [];
  for (const n of nodes || []) {
    if (n.image && n.image.indexOf('idb:') === 0 && !(await hasImageLocally(n.image))) images.push(n.image.slice(4));
    if (n.kind === 'voice' && !(await hasAudioLocally(n.id))) audio.push(n.id);
  }
  return { images, audio };
}

// Before exporting the CURRENTLY OPEN (live) board: if a live liaison is
// connected, actively ask for whatever's missing and give peers a few
// seconds to answer; otherwise (or if still missing after that) just warn
// how many blocks will be exported incomplete. Export proceeds either way --
// this is a heads-up, not a hard block.
async function ensureMediaCached(nodes) {
  let missing = await findMissingMedia(nodes);
  let total = missing.images.length + missing.audio.length;
  if (!total) return;
  if (liaisonStatus().role === null) { toast(t('toast.mediaMissing', { n: total }), 4000); return; }
  toast(t('toast.fetchingMedia', { n: total }), 4000);
  missing.images.forEach((h) => requestImage(h));
  missing.audio.forEach((id) => requestAudio(id));
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    missing = await findMissingMedia(nodes);
    total = missing.images.length + missing.audio.length;
    if (!total) return;
  }
  toast(t('toast.mediaMissing', { n: total }), 4000);
}

export async function exportJSON() {
  toast(t('toast.checkingMedia'), 1500);
  await ensureMediaCached(state.nodes); // live nodes: a liaison (if any) can only fetch for THIS board
  const snap = serialize();          // fresh objects (safe to mutate)
  await inlineImages(snap.nodes);    // re-inline IndexedDB images -> self-contained file
  await inlineAudio(snap.nodes);     // same for voice memos (see voice.js: inlineAudio)
  downloadJSON(snap, 'bete-' + getBoardId() + '-' + dateStamp() + '.json');
}

// Builds the "every board this browser knows about" bundle (see boards.js),
// each with its images/audio re-inlined so the file is self-contained (no
// IndexedDB refs -- see images.js: inlineImages, voice.js: inlineAudio).
// Passive check only (no active peer fetch): a board not currently open has
// no live connection to ask. Shared by exportAllBoards() (interactive, Save
// As dialog) and the desktop exit-export (main.js, writes silently to a
// remembered folder instead) -- factored out so the latter doesn't have to
// go through a file-picker dialog just to get the same bytes.
async function buildAllBoardsBundle() {
  const bundle = { version: 1, boards: {} };
  let missingTotal = 0;
  for (const b of listBoards()) {
    let raw;
    try { raw = localStorage.getItem('bete:' + b.id); } catch (e) { raw = null; }
    if (!raw) continue; // e.g. 'tutorial': built-in, never saved to localStorage
    let data;
    try { data = JSON.parse(raw); } catch (e) { continue; }
    if (data.nodes) {
      const missing = await findMissingMedia(data.nodes);
      missingTotal += missing.images.length + missing.audio.length;
      await inlineImages(data.nodes); await inlineAudio(data.nodes);
    }
    bundle.boards[b.id] = { name: b.name, peer: b.peer, ts: b.ts, data };
  }
  return { bundle, missingTotal };
}

export async function exportAllBoards() {
  const { bundle, missingTotal } = await buildAllBoardsBundle();
  if (missingTotal) toast(t('toast.mediaMissing', { n: missingTotal }), 4000);
  downloadJSON(bundle, 'bete-all-boards-' + dateStamp() + '.json');
}

// Desktop only: writes the same bundle straight into `dir` (a folder chosen
// once via Settings > Data or the exit-export prompt, see main.js), no Save
// As dialog. Returns true on success.
export async function exportAllBoardsToPath(dir) {
  const { bundle } = await buildAllBoardsBundle();
  return writeExportFile(dir, 'bete-all-boards-' + dateStamp() + '.json', JSON.stringify(bundle));
}

export function importJSON(onDone) {
  const input = document.getElementById('fileInput');
  input.value = '';
  const handler = () => {
    const file = input.files && input.files[0];
    input.removeEventListener('change', handler);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (load(obj)) {
          // Resets physics for the imported elements.
          state.nodes.forEach(reset);
          // Re-offloads inline images (data URL) to IndexedDB (ref 'idb:<hash>').
          migrateImages(state.nodes, scheduleSave).catch(() => {});
          // Same for a voice memo's inlined audio (see voice.js: restoreAudio).
          restoreAudio(state.nodes).catch(() => {});
          if (onDone) onDone();
        }
      } catch (e) {
        alert(t('alert.jsonInvalid'));
      }
    };
    reader.readAsText(file);
  };
  input.addEventListener('change', handler);
  input.click();
}

// Bulk restore: writes every board from the file straight to localStorage
// and records it in the board list. Images stay inline (data URL) until each
// board is actually opened -- migrateImages() then offloads them to IndexedDB
// in the background, same as a legacy single-board import.
export function importAllBoards(onDone) {
  const input = document.getElementById('fileInput');
  input.value = '';
  const handler = () => {
    const file = input.files && input.files[0];
    input.removeEventListener('change', handler);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bundle = JSON.parse(reader.result);
        if (!bundle || typeof bundle.boards !== 'object') throw new Error('bad format');
        for (const id in bundle.boards) {
          const entry = bundle.boards[id];
          try { localStorage.setItem('bete:' + id, JSON.stringify(entry.data)); } catch (e) { /* quota */ }
          recordBoard(id, entry.name, entry.peer || null);
        }
        if (onDone) onDone();
      } catch (e) {
        alert(t('alert.jsonInvalid'));
      }
    };
    reader.readAsText(file);
  };
  input.addEventListener('change', handler);
  input.click();
}
