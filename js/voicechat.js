// Live voice AND video chat in a P2P mesh via PeerJS MediaConnection.
// Listening by default: as long as we're in a liaison, we answer calls (we hear
// everyone). The mic/camera buttons only control OUR OWN emission (talking/showing).
// Neither goes through the Pi: browser <-> browser (low latency).
//
// Video piggybacks on the SAME mesh connection as audio (one RTCPeerConnection
// per pair, not two) -- every call always carries both an audio track (real
// mic or a silent one) and a video track (real camera or a blank one, see
// blankVideo()) from the very start, so toggling the mic or camera later is
// just replaceTrack() on an already-negotiated sender, never a renegotiation.
// Whether a peer's video is actually worth DISPLAYING (as opposed to just a
// blank feed we're ignoring) is driven entirely by presence (`camera: true`),
// not by inspecting track content -- see syncCameraBlocks().
import { getPeer, getPresence, setLocalVoice, setLocalCamera, onIncomingCall } from './sync.js?v=msa37vkx';
import { state, addCameraNode, removeById } from './state.js?v=msa37vkx';
import { reset } from './physics.js?v=msa37vkx';
import { worldToScreen } from './camera.js?v=msa37vkx';
import { t } from './i18n.js?v=msa37vkx';

let micOn = false;
let listenOn = true; // listening enabled by default
let micStream = null;
let silentStream = null;
let _ac = null;
let wakeLock = null;
const calls = {}; // remotePeerId -> { conn, audio, stream }

// ---- Camera (video chat) ----
const MAX_CAMERAS = 4; // total participants showing video at once, including self
let cameraOn = false;
let cameraStream = null;
let blankVideoStream = null;
let localCameraNodeId = null;
const localVideoEl = document.createElement('video'); // our own preview, muted (avoid echo)
localVideoEl.autoplay = true; localVideoEl.playsInline = true; localVideoEl.muted = true;
const remoteVideo = {}; // remotePeerId -> { nodeId, el: <video> }
const dismissedCamera = new Set(); // remotePeerId whose block was manually closed -- see dismissRemoteCamera

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

// Preferred camera (deviceId), same pattern as the mic above.
let preferredCameraId = '';
try { preferredCameraId = localStorage.getItem('bete:cameradevice') || ''; } catch (e) { /* */ }
export function getPreferredCamera() { return preferredCameraId; }
export function setPreferredCamera(id) {
  preferredCameraId = id || '';
  try { localStorage.setItem('bete:cameradevice', preferredCameraId); } catch (e) { /* */ }
  if (cameraOn) restartCamera(); // applies right away if already showing
}

// Pseudo-device: shares a screen/window/tab (via the browser's own share
// picker) instead of a physical camera -- same idea as SYSTEM_AUDIO_ID above,
// and fully independent of it (e.g. mic -> "computer sound" + camera ->
// "share screen" can be combined, or used separately).
export const SCREEN_SHARE_ID = 'screen-share';

// List of available cameras (needs a camera permission already granted to have labels).
export async function listCameras() {
  let cams = [];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    cams = devs.filter((d) => d.kind === 'videoinput');
  } catch (e) { /* */ }
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    cams = [{ deviceId: SCREEN_SHARE_ID, label: t('settings.cameraScreenShare') }, ...cams];
  }
  return cams;
}

function cameraConstraints() {
  return { video: preferredCameraId ? { deviceId: { exact: preferredCameraId } } : true };
}

// Resolves the video stream: either a physical camera (getUserMedia) or a
// screen/window share (getDisplayMedia, video only -- any audio track the
// picker also grants is stopped immediately, that's the mic's own "computer
// sound" option's job, not this one's, so we don't silently double-capture it).
async function acquireCameraStream() {
  if (preferredCameraId === SCREEN_SHARE_ID) {
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    return disp;
  }
  return navigator.mediaDevices.getUserMedia(cameraConstraints());
}

// Screen/window shares end when the user clicks the browser's own "Stop
// sharing" bar (unlike a physical camera, which just keeps running) -- watch
// for that and turn the camera off cleanly instead of leaving a dead block.
function attachCameraEndedWatch(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.onended = () => { if (cameraOn && stream === cameraStream) toggleCamera(); };
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
// Blank video track (a static black frame) to fill the video slot when the
// camera is off -- same idea as silent() for audio: every call always sends
// both an audio AND a video track from the start, so later turning the mic
// or camera on/off is just replaceTrack(), never a renegotiation.
function blankVideo() {
  if (blankVideoStream) return blankVideoStream;
  try {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2);
    blankVideoStream = c.captureStream(1); // 1 fps: it never changes, no need for more
  } catch (e) { blankVideoStream = new MediaStream(); }
  return blankVideoStream;
}

// The combined audio+video stream we currently send to every peer: real mic
// or silence, real camera or a blank frame.
function outStream() {
  const audio = (micOn && micStream) ? micStream.getAudioTracks()[0] : silent().getAudioTracks()[0];
  const video = (cameraOn && cameraStream) ? cameraStream.getVideoTracks()[0] : blankVideo().getVideoTracks()[0];
  const tracks = [audio, video].filter(Boolean);
  return new MediaStream(tracks);
}

// Enable / mute OUR mic (emission). Listening always stays active.
export async function toggleMic() {
  if (micOn) {
    micOn = false; setLocalVoice(false);
    releaseWakeLock();
    stopMicStream();
    replaceOutgoingTrack('audio', silent().getAudioTracks()[0]);
    return false;
  }
  try { micStream = await acquireStream(); }
  catch (e) { alert(t('alert.micUnavailable')); return false; }
  attachEndedWatch(micStream);
  micOn = true; setLocalVoice(true);
  acquireWakeLock();
  replaceOutgoingTrack('audio', micStream.getAudioTracks()[0]);
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
  track.onended = () => { if (micOn && stream === micStream) { if (alwaysOn) restartMic(); else { micOn = false; setLocalVoice(false); replaceOutgoingTrack('audio', silent().getAudioTracks()[0]); } } };
}

// Restarts the mic stream without cutting it in the UI (used by Always On + device change).
async function restartMic() {
  stopMicStream();
  try { micStream = await acquireStream(); }
  catch (e) { micStream = null; return; } // will retry on the next trigger (visibilitychange, etc.)
  attachEndedWatch(micStream);
  replaceOutgoingTrack('audio', micStream.getAudioTracks()[0]);
}
// Retries if the resume failed at the moment of 'ended' (e.g. mic momentarily
// unavailable during a phone call) and we come back to the foreground.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && micOn && alwaysOn && !micStream) restartMic(); });

// Replaces the outgoing audio or video track on all active connections
// (without reopening/renegotiating -- see outStream()'s comment on why every
// sender already has both kinds of track from the start).
function replaceOutgoingTrack(kind, track) {
  Object.values(calls).forEach((c) => {
    try {
      const pc = c.conn && c.conn.peerConnection;
      const s = pc && pc.getSenders().find((x) => x.track && x.track.kind === kind);
      if (s && track) s.replaceTrack(track);
    } catch (e) { /* */ }
  });
}

// Connects based on who's talking/showing video: calls a peer if WE are
// talking or showing our camera, or if THEY are (or if we're listening and
// they're talking -- watching someone's camera, unlike listening, has no
// separate opt-out toggle, we always want to see it once someone's showing).
// (Total silence/stillness => no connection.)
function reconcile() {
  const peer = getPeer();
  const myId = peer && peer.id;
  if (!myId) { Object.keys(calls).forEach(dropCall); return; }
  const want = {};
  getPresence().forEach((u) => {
    if (u.me || !u.peerId) return;
    if (!micOn && !cameraOn && !(listenOn && u.voice) && !u.camera) return;
    want[u.peerId] = 1;
    if (calls[u.peerId]) return;
    if (myId < u.peerId) { // the smallest id initiates (anti-duplicate)
      try { const c = peer.call(u.peerId, outStream()); if (c) attachCall(u.peerId, c); } catch (e) { /* */ }
    }
  });
  Object.keys(calls).forEach((id) => { if (!want[id]) dropCall(id); });
  syncCameraBlocks();
}
setInterval(reconcile, 1500);

// Incoming call: we answer as long as we want SOMETHING from this mesh
// (talking, showing our camera, or listening) -- refusing only cuts the
// rare case where every one of those is off.
onIncomingCall((conn) => {
  if (calls[conn.peer]) { try { conn.close(); } catch (e) { /* */ } return; } // glare
  if (!micOn && !cameraOn && !listenOn) { try { conn.close(); } catch (e) { /* */ } return; }
  try { conn.answer(outStream()); } catch (e) { /* */ }
  attachCall(conn.peer, conn);
});

function attachCall(remoteId, conn) {
  calls[remoteId] = { conn, audio: null, stream: null };
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
  // Kept separately from c.audio (which stays responsible for playback/mute)
  // -- syncCameraBlocks() feeds this same stream into a <video> element too,
  // muted, purely for the picture, whenever this peer's camera block exists.
  c.stream = stream;
}

function dropCall(remoteId) {
  const c = calls[remoteId];
  if (!c) return;
  try { c.conn && c.conn.close(); } catch (e) { /* */ }
  if (c.audio) c.audio.srcObject = null;
  delete calls[remoteId];
  removeRemoteCameraBlock(remoteId);
}

// ---- Camera (video chat) ----
export function isCameraOn() { return cameraOn; }

// Enable / disable OUR camera (emission). Creates/removes our own ephemeral
// preview block (see state.js: addCameraNode) -- deleting that block by hand
// (Delete key, radial menu) has the exact same effect, see input.js:
// removeElement's 'camera' case, which calls back into this function.
export async function toggleCamera() {
  if (cameraOn) {
    cameraOn = false; setLocalCamera(false);
    stopCameraStream();
    replaceOutgoingTrack('video', blankVideo().getVideoTracks()[0]);
    if (localCameraNodeId) { removeById(localCameraNodeId); localCameraNodeId = null; }
    localVideoEl.srcObject = null;
    reconcile(); // may drop connections nobody wants anymore
    return false;
  }
  // Simple, sender-side cap: refuse to join if 4 people are already showing
  // video (counting ourselves once we're on). Each device enforces this the
  // same way, so the total across the mesh never exceeds MAX_CAMERAS.
  if (getPresence().filter((u) => u.camera).length >= MAX_CAMERAS) {
    alert(t('alert.cameraMaxReached', { n: MAX_CAMERAS }));
    return false;
  }
  try { cameraStream = await acquireCameraStream(); }
  catch (e) { alert(t('alert.cameraUnavailable')); return false; }
  attachCameraEndedWatch(cameraStream);
  cameraOn = true; setLocalCamera(true);
  const n = addCameraNode(state.camera.x - 110, state.camera.y - 82, 'local', t('liaison.you'));
  reset(n);
  localCameraNodeId = n.id;
  localVideoEl.srcObject = cameraStream;
  localVideoEl.play().catch(() => {});
  replaceOutgoingTrack('video', cameraStream.getVideoTracks()[0]);
  reconcile(); // connects to everyone so they can see us
  return true;
}

function stopCameraStream() {
  if (cameraStream) { cameraStream.getTracks().forEach((tr) => tr.stop()); cameraStream = null; }
}

// Restarts the camera stream on a device change without toggling the UI off
// (used by setPreferredCamera) -- same pattern as restartMic.
async function restartCamera() {
  stopCameraStream();
  try { cameraStream = await acquireCameraStream(); }
  catch (e) { cameraStream = null; return; }
  attachCameraEndedWatch(cameraStream);
  localVideoEl.srcObject = cameraStream;
  localVideoEl.play().catch(() => {});
  replaceOutgoingTrack('video', cameraStream.getVideoTracks()[0]);
}

// Closing a remote participant's camera block by hand doesn't affect their
// actual stream -- it just stops US from displaying it, until their camera
// cycles off then on again (tracked per remote id, cleared in
// syncCameraBlocks() the moment presence reports camera:false for them).
export function dismissRemoteCamera(remotePeerId) {
  dismissedCamera.add(remotePeerId);
  removeRemoteCameraBlock(remotePeerId);
}

function removeRemoteCameraBlock(remotePeerId) {
  const rv = remoteVideo[remotePeerId];
  if (!rv) return;
  rv.el.srcObject = null;
  removeById(rv.nodeId);
  delete remoteVideo[remotePeerId];
}

// Called from reconcile() (every 1.5s): creates/removes each remote
// participant's ephemeral camera block to match presence. Connection
// lifecycle (calls{}) is handled separately above -- this only decides
// whether an EXISTING stream's video track is worth showing.
function syncCameraBlocks() {
  const present = new Set();
  getPresence().forEach((u) => {
    if (u.me || !u.peerId) return;
    present.add(u.peerId);
    if (!u.camera) { dismissedCamera.delete(u.peerId); removeRemoteCameraBlock(u.peerId); return; }
    if (dismissedCamera.has(u.peerId)) return; // manually closed, waits for their camera to cycle
    let rv = remoteVideo[u.peerId];
    if (!rv) {
      const n = addCameraNode(state.camera.x + 110 * (Object.keys(remoteVideo).length + 1), state.camera.y - 82, u.peerId, u.name || t('liaison.guest'));
      reset(n);
      const el = document.createElement('video');
      el.autoplay = true; el.playsInline = true; el.muted = true; // audio already plays via calls[].audio
      rv = remoteVideo[u.peerId] = { nodeId: n.id, el };
    }
    const stream = calls[u.peerId] && calls[u.peerId].stream;
    if (stream && rv.el.srcObject !== stream) { rv.el.srcObject = stream; rv.el.play().catch(() => {}); }
  });
  // Cleans up anyone no longer present at all (disconnected).
  Object.keys(remoteVideo).forEach((id) => { if (!present.has(id)) { removeRemoteCameraBlock(id); dismissedCamera.delete(id); } });
}

// Positions every active <video> overlay (our own preview + each visible
// remote camera block) over its node -- called every frame from main.js's
// render loop, same technique as video.js: positionVideoOverlay (an inline
// YouTube player), just generalized to several simultaneous elements keyed
// by node id instead of a single active one.
export function updateCameraOverlays() {
  positionOverlay(localCameraNodeId, localVideoEl);
  Object.values(remoteVideo).forEach((rv) => positionOverlay(rv.nodeId, rv.el));
}

function positionOverlay(nodeId, el) {
  const n = nodeId && state.nodes.find((x) => x.id === nodeId);
  if (!n) { if (el.parentNode) el.remove(); return; }
  if (!el.parentNode) document.body.appendChild(el);
  // Mirror only our own preview, and only when it's an actual physical
  // camera -- mirroring a screen/window share would look plain broken.
  const mirror = el === localVideoEl && preferredCameraId !== SCREEN_SHARE_ID;
  el.className = 'camera-overlay' + (mirror ? ' camera-mirror' : '');
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const z = state.camera.zoom;
  const p = worldToScreen(rx, ry);
  const w = n.w * z, h = n.h * z;
  if (p.x + w < -20 || p.y + h < -20 || p.x > window.innerWidth + 20 || p.y > window.innerHeight + 20) {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }
}
