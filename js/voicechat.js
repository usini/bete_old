// Live voice chat in a P2P mesh via PeerJS MediaConnection.
// Listening by default: as long as we're in a liaison, we answer calls (we hear
// everyone). The mic button only controls OUR emission (talking).
// Audio does NOT go through the Pi: browser <-> browser (low latency).
import { getPeer, getPresence, setLocalVoice, onIncomingCall } from './sync.js?v=ms7chxev';
import { t } from './i18n.js?v=ms7chxev';

let micOn = false;
let listenOn = true; // listening enabled by default
let micStream = null;
let silentStream = null;
let _ac = null;
let wakeLock = null;
const calls = {}; // remotePeerId -> { conn, audio }

// "Always On" (mobile): on phones, the screen locking often suspends the
// mic/connection. This mode requests a Wake Lock (screen kept on while the
// mic is talking) and automatically reacquires the stream if the OS cuts it
// (incoming call, focus loss, etc.), to keep the mic active continuously.
let alwaysOn = false;
try { alwaysOn = localStorage.getItem('bete:micalwayson') === '1'; } catch (e) { /* */ }
export function isAlwaysOn() { return alwaysOn; }
export function setAlwaysOn(v) {
  alwaysOn = !!v;
  try { localStorage.setItem('bete:micalwayson', alwaysOn ? '1' : '0'); } catch (e) { /* */ }
  if (alwaysOn && micOn) acquireWakeLock(); else releaseWakeLock();
}

// Preferred input microphone (deviceId), if the phone/PC has several.
let preferredMicId = '';
try { preferredMicId = localStorage.getItem('bete:micdevice') || ''; } catch (e) { /* */ }
export function getPreferredMic() { return preferredMicId; }
export function setPreferredMic(id) {
  preferredMicId = id || '';
  try { localStorage.setItem('bete:micdevice', preferredMicId); } catch (e) { /* */ }
  if (micOn) restartMic(); // applies right away if already talking
}
// Pseudo-device: captures the computer's system/desktop audio (via the
// browser's screen/tab-share picker) instead of a physical microphone --
// lets someone play music/video and have others in the liaison hear it.
export const SYSTEM_AUDIO_ID = 'system-audio';

// List of available mics (needs a mic permission already granted to have labels).
export async function listMics() {
  let mics = [];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    mics = devs.filter((d) => d.kind === 'audioinput');
  } catch (e) { /* */ }
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    mics = [{ deviceId: SYSTEM_AUDIO_ID, label: t('settings.micSystemAudio') }, ...mics];
  }
  return mics;
}

function micConstraints() {
  return { audio: preferredMicId ? { deviceId: { exact: preferredMicId } } : true };
}

// Resolves the input stream: either a physical mic (getUserMedia) or the
// system-audio pseudo-device (getDisplayMedia, audio only -- the video track
// is stopped immediately, we only wanted the share-audio checkbox). Exported
// so voice.js (memo recording) can honor the same mic choice, including
// "computer sound", instead of always requesting a plain default mic.
export async function acquireStream() {
  if (preferredMicId === SYSTEM_AUDIO_ID) {
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    disp.getVideoTracks().forEach((tr) => tr.stop());
    const tracks = disp.getAudioTracks();
    if (!tracks.length) throw new Error('no system audio track (share-audio checkbox not ticked?)');
    return new MediaStream(tracks);
  }
  return navigator.mediaDevices.getUserMedia(micConstraints());
}

async function acquireWakeLock() {
  if (!alwaysOn || !navigator.wakeLock || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { wakeLock = null; } // refused (hidden tab, etc.): not blocking
}
function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch (e) { /* */ } wakeLock = null; } }
// The Wake Lock is released by the browser when the tab goes to the background:
// we request it again when coming back to the foreground if the mic is still active.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && micOn) acquireWakeLock(); });

export function isMicOn() { return micOn; }
export function isListenOn() { return listenOn; }

// Mute / unmute listening (incoming audio). Enabled by default.
export function toggleListen() {
  listenOn = !listenOn;
  Object.values(calls).forEach((c) => { if (c.audio) c.audio.muted = !listenOn; });
  reconcile();
  return listenOn;
}

// Silent audio track (to join/listen without requesting the mic).
function silent() {
  if (silentStream) return silentStream;
  try {
    _ac = new (window.AudioContext || window.webkitAudioContext)();
    const dst = _ac.createMediaStreamDestination();
    const g = _ac.createGain(); g.gain.value = 0;
    const o = _ac.createOscillator(); o.connect(g).connect(dst); o.start();
    silentStream = dst.stream;
  } catch (e) { silentStream = new MediaStream(); }
  return silentStream;
}
function outStream() { return (micOn && micStream) ? micStream : silent(); }

// Enable / mute OUR mic (emission). Listening always stays active.
export async function toggleMic() {
  if (micOn) {
    micOn = false; setLocalVoice(false);
    releaseWakeLock();
    stopMicStream();
    replaceOutgoing(silent().getAudioTracks()[0]);
    return false;
  }
  try { micStream = await acquireStream(); }
  catch (e) { alert(t('alert.micUnavailable')); return false; }
  attachEndedWatch(micStream);
  micOn = true; setLocalVoice(true);
  acquireWakeLock();
  replaceOutgoing(micStream.getAudioTracks()[0]);
  reconcile(); // connects to everyone so they can hear us
  return true;
}

function stopMicStream() {
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}

// Watches for the track being cut by the OS (incoming call, device unplugged...).
// In Always On mode, retries right away to keep the mic active continuously.
function attachEndedWatch(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.onended = () => { if (micOn && stream === micStream) { if (alwaysOn) restartMic(); else { micOn = false; setLocalVoice(false); replaceOutgoing(silent().getAudioTracks()[0]); } } };
}

// Restarts the mic stream without cutting it in the UI (used by Always On + device change).
async function restartMic() {
  stopMicStream();
  try { micStream = await acquireStream(); }
  catch (e) { micStream = null; return; } // will retry on the next trigger (visibilitychange, etc.)
  attachEndedWatch(micStream);
  replaceOutgoing(micStream.getAudioTracks()[0]);
}
// Retries if the resume failed at the moment of 'ended' (e.g. mic momentarily
// unavailable during a phone call) and we come back to the foreground.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && micOn && alwaysOn && !micStream) restartMic(); });

// Replaces the outgoing track on all active connections (without reopening).
function replaceOutgoing(track) {
  Object.values(calls).forEach((c) => {
    try {
      const pc = c.conn && c.conn.peerConnection;
      const s = pc && pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
      if (s && track) s.replaceTrack(track);
    } catch (e) { /* */ }
  });
}

// Connects based on who's talking: calls a peer if WE are talking or if THEY are.
// (Total silence => no connection. We hear everyone as soon as they start talking.)
function reconcile() {
  const peer = getPeer();
  const myId = peer && peer.id;
  if (!myId) { Object.keys(calls).forEach(dropCall); return; }
  const want = {};
  getPresence().forEach((u) => {
    if (u.me || !u.peerId) return;
    // We connect if WE are talking (to be heard), or if we're listening to someone talking.
    if (!micOn && !(listenOn && u.voice)) return;
    want[u.peerId] = 1;
    if (calls[u.peerId]) return;
    if (myId < u.peerId) { // the smallest id initiates (anti-duplicate)
      try { const c = peer.call(u.peerId, outStream()); if (c) attachCall(u.peerId, c); } catch (e) { /* */ }
    }
  });
  Object.keys(calls).forEach((id) => { if (!want[id]) dropCall(id); });
}
setInterval(reconcile, 1500);

// Incoming call: we ALWAYS answer (listening by default), with our current track.
onIncomingCall((conn) => {
  if (calls[conn.peer]) { try { conn.close(); } catch (e) { /* */ } return; } // glare
  if (!micOn && !listenOn) { try { conn.close(); } catch (e) { /* */ } return; } // neither talking nor listening
  try { conn.answer(outStream()); } catch (e) { /* */ }
  attachCall(conn.peer, conn);
});

function attachCall(remoteId, conn) {
  calls[remoteId] = { conn, audio: null };
  conn.on('stream', (stream) => playRemote(remoteId, stream));
  conn.on('close', () => dropCall(remoteId));
  conn.on('error', () => dropCall(remoteId));
}

function playRemote(remoteId, stream) {
  const c = calls[remoteId];
  if (!c) return;
  if (!c.audio) { const a = new Audio(); a.autoplay = true; a.playsInline = true; c.audio = a; }
  c.audio.muted = !listenOn;
  c.audio.srcObject = stream;
  c.audio.play().catch(() => {});
}

function dropCall(remoteId) {
  const c = calls[remoteId];
  if (!c) return;
  try { c.conn && c.conn.close(); } catch (e) { /* */ }
  if (c.audio) c.audio.srcObject = null;
  delete calls[remoteId];
}
