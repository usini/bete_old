// Voice memos: recording (MediaRecorder/Opus), IndexedDB storage,
// play/pause, P2P sharing of the audio (see sync.js shareAudio/requestAudio).
import { state, newId, scheduleSave } from './state.js?v=msa0jvj9';
import { reset } from './physics.js?v=msa0jvj9';
import { putAudio, getAudio, delAudio } from './audio.js?v=msa0jvj9';
import { shareAudio, requestAudio } from './sync.js?v=msa0jvj9';
import { t } from './i18n.js?v=msa0jvj9';
import { acquireStream } from './voicechat.js?v=msa0jvj9';
import { dataUrlToBlob, blobToDataUrl } from './images.js?v=msa0jvj9';

const players = {}; // id -> { audio, url }
const MAX_MS = 60000; // max memo duration: 1 minute

export function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  for (const m of cands) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* */ } }
  return '';
}

// Small recording window (timer + Stop / Cancel).
function buildRecModal() {
  const m = document.createElement('div');
  m.className = 'recmodal';
  m.innerHTML = '<div class="rec-card">'
    + '<div class="rec-dot"></div>'
    + '<div class="rec-timer">0:00</div>'
    + '<div class="rec-actions">'
    + '<button class="rec-stop">' + t('record.stop') + '</button>'
    + '<button class="rec-cancel">' + t('record.cancel') + '</button>'
    + '</div></div>';
  // Prevents the click from falling through to the canvas.
  m.addEventListener('mousedown', (e) => e.stopPropagation());
  m.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(m);
  return m;
}

// target (optional): converts an existing block into a voice memo; otherwise creates one.
export async function recordVoiceMemo(wx, wy, target) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    alert(t('alert.recordingUnsupported'));
    return;
  }
  let stream;
  try { stream = await acquireStream(); } // honors the mic chosen in Settings > Audio, including "computer sound"
  catch (e) { alert(t('alert.micUnavailable')); return; }

  const mime = pickMime();
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined); }
  catch (e) { stream.getTracks().forEach((t) => t.stop()); alert(t('alert.recordingFailed')); return; }

  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const modal = buildRecModal();
  const t0 = performance.now();
  const timerEl = modal.querySelector('.rec-timer');
  const tick = setInterval(() => { timerEl.textContent = fmtDur((performance.now() - t0) / 1000) + ' / 1:00'; }, 200);
  // Auto-stop at 1 minute.
  const maxTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, MAX_MS);
  let cancelled = false;

  rec.onstop = async () => {
    clearInterval(tick); clearTimeout(maxTimer);
    stream.getTracks().forEach((t) => t.stop());
    modal.remove();
    if (cancelled) return;
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    if (!blob.size) return;
    const dur = Math.min(60, (performance.now() - t0) / 1000);
    const id = target ? target.id : newId();
    try { await putAudio(id, blob); }
    catch (e) { alert(t('alert.memoStorageFailed')); return; }
    if (target) {
      // Converts an existing block into a voice memo (keeps id/position/size).
      target.kind = 'voice'; target.dur = Math.round(dur);
      delete target.text; delete target.image; delete target.link;
      reset(target); state.selected = target.id;
    } else {
      const n = { id, kind: 'voice', x: wx - 90, y: wy - 40, w: 180, h: 80, dur: Math.round(dur) };
      state.nodes.push(n); reset(n); state.selected = n.id;
    }
    scheduleSave();
    shareAudio(id, blob); // broadcasts the audio to connected peers
  };

  modal.querySelector('.rec-stop').onclick = () => { if (rec.state !== 'inactive') rec.stop(); };
  modal.querySelector('.rec-cancel').onclick = () => { cancelled = true; clearTimeout(maxTimer); if (rec.state !== 'inactive') rec.stop(); else { clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); modal.remove(); } };

  rec.start();
}

// Play / pause a memo. Updates n._playing / n._prog for rendering.
export async function toggleVoice(n) {
  const p = players[n.id];
  if (p) {
    if (p.audio.paused) p.audio.play(); else p.audio.pause();
    return;
  }
  let blob;
  try { blob = await getAudio(n.id); } catch (e) { blob = null; }
  if (!blob) { n._missing = true; n._loading = true; requestAudio(n.id); return; } // asks peers for the audio
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  players[n.id] = { audio, url };
  audio.ontimeupdate = () => { n._prog = audio.duration ? audio.currentTime / audio.duration : 0; };
  audio.onplay = () => { n._playing = true; };
  audio.onpause = () => { n._playing = false; };
  audio.onended = () => { n._playing = false; n._prog = 0; };
  audio.play();
}

// Deletes the audio (IndexedDB + current player) when the block is deleted.
export function removeVoiceAudio(id) {
  const p = players[id];
  if (p) { try { p.audio.pause(); } catch (e) { /* */ } URL.revokeObjectURL(p.url); delete players[id]; }
  delAudio(id);
}

// True if this memo's audio is already in THIS browser's IndexedDB (no peer
// request). Used before export (see io.js: ensureMediaCached) to warn about
// a memo whose bytes were never actually downloaded, only referenced.
export async function hasAudioLocally(id) {
  try { return !!(await getAudio(id)); } catch (e) { return false; }
}

// Re-inlines a voice memo's audio (IndexedDB blob -> data URL) for a
// self-contained JSON export, mirroring images.js: inlineImages -- without
// this, a memo's actual sound never left this browser's IndexedDB, so an
// exported/reimported board kept an empty 'voice' shell (duration only) on
// another profile. Mutates the given nodes (use a disposable copy, e.g.
// serialize()'s result, or a freshly-parsed bulk-export board).
export async function inlineAudio(nodes) {
  for (const node of nodes || []) {
    if (node.kind !== 'voice') continue;
    try { const blob = await getAudio(node.id); if (blob) node.audioData = await blobToDataUrl(blob); } catch (e) { /* */ }
  }
}

// Reverse of inlineAudio: pulls an imported memo's inlined audio back into
// IndexedDB (keyed by the node's own id, like a freshly recorded memo) and
// drops the transient field -- serialize() never re-emits it anyway (voice
// nodes are re-derived to {id,x,y,w,h,kind,dur}), this just avoids keeping a
// stray base64 copy around in memory once it's back in IndexedDB.
export async function restoreAudio(nodes) {
  for (const node of nodes || []) {
    if (node.kind !== 'voice' || !node.audioData) continue;
    try { await putAudio(node.id, dataUrlToBlob(node.audioData)); } catch (e) { /* */ }
    delete node.audioData;
  }
}
