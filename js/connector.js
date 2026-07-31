// IoT/HTTP connector block: parses a small YAML program (schema inspired by
// Home Assistant's `switch.rest` integration -- resource/method/body_on/
// body_off/state_path) and polls/actuates a local device (e.g. a Shelly
// smart plug). See CLAUDE.md for the read-only vs. host distinction that
// also applies here (a locked guest may watch a switch's state but not
// flip it -- enforced in input.js, not in this module).
import { scheduleSave } from './state.js?v=ms8r0wxz';
import { getUserId } from './users.js?v=ms8r0wxz';

// Vendored locally (js/vendor/js-yaml.min.js) so the app keeps working
// offline -- no CDN fetch at runtime, unlike the PeerJS/QR script loads in
// sync.js. Loaded lazily (only once a connector block actually exists).
const YAML_SRC = 'js/vendor/js-yaml.min.js';
let _yamlLoad = null;
function loadYaml() {
  if (_yamlLoad) return _yamlLoad;
  _yamlLoad = new Promise((res, rej) => {
    if (window.jsyaml) { res(window.jsyaml); return; }
    const s = document.createElement('script');
    s.src = YAML_SRC;
    s.onload = () => res(window.jsyaml);
    s.onerror = () => rej(new Error('load ' + YAML_SRC));
    document.head.appendChild(s);
  });
  return _yamlLoad;
}

export async function parseYaml(text) {
  const yaml = await loadYaml();
  return yaml.load(text || '') || {};
}

// Accepts a plain dot-path ("output", "params.tC") or the Home Assistant
// template shape ("{{ value_json.output }}"), extracted via regex -- no
// real Jinja2 engine, just enough to reuse a single-variable HA snippet.
export function extractPath(json, pathOrTemplate) {
  if (!pathOrTemplate) return undefined;
  const m = /^\{\{\s*value_json\.([\w.]+)\s*\}\}$/.exec(pathOrTemplate.trim());
  const path = m ? m[1] : pathOrTemplate.trim();
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), json);
}

// Chrome's Local Network Access API: opt-in so a request to a private IP
// isn't blocked as mixed content on an HTTPS page. Harmless no-op on
// browsers that don't know this fetch option yet.
const PRIVATE_HOST_RE = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|[a-z0-9-]+\.local)/i;
export function connectorFetch(url, opts) {
  const init = { ...opts };
  try {
    const host = new URL(url).hostname;
    if (PRIVATE_HOST_RE.test(host)) init.targetAddressSpace = 'local';
  } catch (e) { /* invalid URL: let fetch() report the real error */ }
  return fetch(url, init);
}

async function requestJson(resource, method, headers, body) {
  const res = await connectorFetch(resource, { method: method || 'GET', headers, body });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const txt = await res.text();
  try { return JSON.parse(txt); } catch (e) { return txt; }
}

// Refreshes a connector's displayed value/status from its state_resource
// (or resource, if no separate one is configured).
export async function refreshConnector(node) {
  let cfg;
  try { cfg = await parseYaml(node.yaml); } catch (e) { node._status = 'error'; node._error = 'YAML: ' + e.message; return; }
  if (!cfg.resource && !cfg.state_resource) { node._status = 'idle'; return; }
  node._status = 'loading';
  try {
    const json = await requestJson(cfg.state_resource || cfg.resource, 'GET', cfg.headers);
    node._value = cfg.state_path ? extractPath(json, cfg.state_path) : json;
    node._status = 'ok';
    node._lastFetch = Date.now();
    node._error = '';
  } catch (e) {
    node._status = 'error';
    node._error = e.message;
  }
}

// Sends the on/off command (toggling from the current known value), then
// re-reads the state to reflect what the device actually did.
//
// Two shapes, picked automatically from what's in the YAML:
// - Gen2-style (resource + body_on/body_off): same URL, POST with a
//   different JSON body depending on the target state.
// - Gen1-style (resource_on/resource_off): a different URL per state, no
//   body needed -- e.g. classic Shelly Bulb/Duo `?turn=on`/`?turn=off`.
export async function toggleSwitch(node) {
  let cfg;
  try { cfg = await parseYaml(node.yaml); } catch (e) { node._status = 'error'; node._error = 'YAML: ' + e.message; return; }
  const turningOn = !node._value;
  let url, method, body;
  if (cfg.resource_on || cfg.resource_off) {
    url = turningOn ? cfg.resource_on : cfg.resource_off;
    method = cfg.method || 'GET';
    body = undefined;
  } else if (cfg.resource) {
    url = cfg.resource;
    method = cfg.method || 'POST';
    body = turningOn ? cfg.body_on : cfg.body_off;
  } else {
    node._status = 'error'; node._error = 'no resource configured'; return;
  }
  if (!url) { node._status = 'error'; node._error = 'no resource_on/resource_off for this state'; return; }
  node._status = 'loading';
  try {
    await requestJson(url, method, cfg.headers, body);
    await refreshConnector(node);
  } catch (e) {
    node._status = 'error';
    node._error = e.message;
  }
}

// ---- Per-node polling ----
const timers = {}; // node id -> setInterval handle

export function stopPolling(id) {
  if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
}

export async function pollConnector(node) {
  stopPolling(node.id);
  node._polling = false;
  node._nextPollAt = 0;
  // Clock display: a local time readout, no network/yaml involved at all.
  if (node.display === 'clock') { node._status = 'idle'; return; }
  // Bridge mode: only the creator's own device has the real yaml (network
  // bridge -- see sync.js) and can actually reach the device. Everyone else
  // never polls locally; they see state pushed via switchRes instead.
  if (node.bridge && node.creatorUid !== getUserId()) { node._status = 'idle'; return; }
  let cfg;
  try { cfg = await parseYaml(node.yaml); } catch (e) { node._status = 'error'; node._error = 'YAML: ' + e.message; return; }
  await refreshConnector(node);
  // poll_interval: 0 -- manual-only mode: no background timer, the block is
  // refreshed by double-clicking it instead (see input.js/handleDouble).
  if (Number(cfg.poll_interval) === 0) return;
  const seconds = Math.max(5, Number(cfg.poll_interval) || 30);
  node._nextPollAt = Date.now() + seconds * 1000; // readout draws the countdown to this
  timers[node.id] = setInterval(() => { node._nextPollAt = Date.now() + seconds * 1000; refreshConnector(node); }, seconds * 1000);
  node._polling = true; // drives the small corner indicator in render.js
}

// Re-parses + restarts polling after the YAML program changed in the editor.
export async function applyConnectorProgram(node, yamlText) {
  await parseYaml(yamlText); // throws on invalid YAML -- caller keeps the editor open on failure
  node.yaml = yamlText;
  scheduleSave();
  await pollConnector(node);
}

// ---- Stopwatch / countdown (clock display only, no yaml/network involved) ----
// Elapsed time is `stopwatchElapsed` (folded in on every pause) plus, while
// running, `Date.now() - stopwatchStart` -- computed on demand at render
// time (render.js: clockContent), so nothing needs to tick while paused/idle.
export function toggleStopwatch(node) {
  if (node.stopwatchStart) {
    node.stopwatchElapsed = (node.stopwatchElapsed || 0) + (Date.now() - node.stopwatchStart);
    node.stopwatchStart = null;
  } else {
    node.stopwatchStart = Date.now();
  }
  scheduleSave();
}

export function resetStopwatch(node) {
  node.stopwatchStart = null;
  node.stopwatchElapsed = 0;
  scheduleSave();
}

export function setCountdownTarget(node, epochMs) {
  node.countdownTarget = epochMs || null;
  scheduleSave();
}
