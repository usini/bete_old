// ICS calendar blocks: a rectangle whose link points to a .ics file renders
// as a week agenda (see render.js: drawIcsWeek). This module handles the
// fetch (with its CORS workarounds), a minimal ICS parser, a best-effort
// RRULE expansion, and the caches so render can poll synchronously per frame.
//
// CORS reality check: most calendar hosts (Google, iCloud...) don't send
// Access-Control-Allow-Origin, so a direct browser fetch usually fails.
// Escape hatches (see fetchIcsText for the exact order, which differs by
// platform since a direct web fetch is a near-guaranteed CORS failure while
// desktop's own fetch isn't):
//  - desktop: the fetch_ics Tauri command (Rust ureq, not subject to CORS);
//  - P2P relay (requestIcsFromPeers, see sync.js): ask other connected peers
//    (a desktop build, or one with a working proxy) to fetch it for us;
//  - web: an optional proxy (Settings > ICS proxy), e.g. the endpoint served
//    by server/bete-host.js on a Raspberry Pi (see server/README.md).
import { isDesktop } from './platform.js?v=ms7d04ny';
import { connectorFetch } from './connector.js?v=ms7d04ny';
import { requestIcsFromPeers } from './sync.js?v=ms7d04ny';

const PROXY_KEY = 'bete:icsproxy';
export function getIcsProxy() {
  try { return localStorage.getItem(PROXY_KEY) || ''; } catch (e) { return ''; }
}
export function setIcsProxy(url) {
  try { if (url) localStorage.setItem(PROXY_KEY, url); else localStorage.removeItem(PROXY_KEY); } catch (e) { /* */ }
}

// A link is "an ICS calendar" when its path ends in .ics (query/hash allowed)
// or uses the webcal:// scheme (Apple convention, an alias for HTTP).
export function isIcsUrl(url) {
  if (!url) return false;
  const u = String(url).trim();
  return /^webcal:\/\//i.test(u) || /\.ics([?#]|$)/i.test(u);
}

function normalizeIcsUrl(url) {
  return String(url).trim().replace(/^webcal:\/\//i, 'https://');
}

// Local-only fetch attempt (no peer relay): native on desktop, direct fetch
// or configured proxy on the web. Also what we run when a PEER asks us to
// fetch on their behalf (see resolveIcsPeerResponse/requestIcsFromPeers
// below) -- that request must never itself cascade into asking other peers.
export async function fetchIcsLocal(url) {
  const u = normalizeIcsUrl(url);
  if (isDesktop) {
    return await window.__TAURI__.core.invoke('fetch_ics', { url: u });
  }
  try {
    const res = await connectorFetch(u);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } catch (e) {
    const proxy = getIcsProxy();
    if (!proxy) throw e;
    const res = await connectorFetch(proxy.replace(/\/+$/, '') + '/ics?url=' + encodeURIComponent(u));
    if (!res.ok) throw new Error('proxy HTTP ' + res.status);
    return await res.text();
  }
}

// ---- P2P relay: ask other connected peers to fetch this url for us ----
// Keyed by url so a reply from ANY peer (broadcast back through the host,
// same star-topology relay as imgRes/audioRes) resolves whoever is waiting.
const peerWaiters = new Map(); // url -> [{ resolve, reject }]
const PEER_TIMEOUT_MS = 12000;

// Called from sync.js when an icsRes arrives (text set on success, error on failure).
export function resolveIcsPeerResponse(url, text, error) {
  const waiters = peerWaiters.get(url);
  if (!waiters) return;
  peerWaiters.delete(url);
  for (const w of waiters) (text != null ? w.resolve(text) : w.reject(new Error(error || 'peer fetch failed')));
}

function fetchIcsViaPeers(url) {
  return new Promise((resolve, reject) => {
    const isFirst = !peerWaiters.has(url);
    if (isFirst) peerWaiters.set(url, []);
    const entry = { resolve, reject };
    peerWaiters.get(url).push(entry);
    // No liaison at all: no point waiting out the timeout.
    if (isFirst && !requestIcsFromPeers(url)) { peerWaiters.delete(url); reject(new Error('no peer connected')); return; }
    setTimeout(() => {
      const list = peerWaiters.get(url);
      const i = list ? list.indexOf(entry) : -1;
      if (i < 0) return; // already resolved
      list.splice(i, 1);
      if (!list.length) peerWaiters.delete(url);
      reject(new Error('no peer answered'));
    }, PEER_TIMEOUT_MS);
  });
}

async function fetchIcsText(url) {
  if (isDesktop) {
    // Desktop's own fetch_ics is native (no CORS) and doesn't need a proxy,
    // so it's reliable enough to just try first -- asking peers would only
    // add a pointless round trip on the common case.
    try { return await fetchIcsLocal(url); } catch (e) { return await fetchIcsViaPeers(url); }
  }
  // Web: most calendar hosts (Google, iCloud...) block a direct browser
  // fetch outright (CORS), so trying it ourselves first is almost always a
  // guaranteed failure -- ask connected peers (a desktop peer, or one with a
  // working proxy) before falling back to our own attempt (which still
  // succeeds if a proxy is configured locally, or occasionally when the host
  // does allow CORS).
  try { return await fetchIcsViaPeers(url); } catch (e) { return await fetchIcsLocal(url); }
}

// ---- Last-known-good cache (localStorage): survives a reload/offline start ----
const CACHE_PREFIX = 'bete:icscache:';
function cacheKey(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  return CACHE_PREFIX + (h >>> 0).toString(36);
}
function loadCachedIcs(url) {
  try {
    const raw = localStorage.getItem(cacheKey(url));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && obj.url === url ? obj.text : null;
  } catch (e) { return null; }
}
function saveCachedIcs(url, text) {
  try { localStorage.setItem(cacheKey(url), JSON.stringify({ url, text })); } catch (e) { /* quota: keep serving from memory */ }
}

// ---- Minimal ICS parsing (VEVENT only, best-effort) ----

// Unfold RFC 5545 continuation lines (CRLF + leading space/tab).
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(s) {
  return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

// 20260708 / 20260708T183000 / 20260708T163000Z. A TZID or floating time is
// treated as local time -- wrong across timezones, but right for the common
// case (your own calendar, your own machine) and keeps this parser tiny.
function parseIcsDate(v) {
  const m = String(v).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, z] = m;
  if (H === undefined) return new Date(+Y, +Mo - 1, +D);
  if (z) return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0)));
  return new Date(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0));
}

function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  let depth = 0; // ignore nested components (VALARM...) inside a VEVENT
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) {
      if (depth > 0) { depth--; continue; }
      if (line === 'END:VEVENT' && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (depth > 0) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const left = line.slice(0, ci), value = line.slice(ci + 1);
    const semi = left.indexOf(';');
    const prop = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? '' : left.slice(semi + 1);
    if (prop === 'DTSTART') {
      cur.start = parseIcsDate(value);
      cur.allDay = /VALUE=DATE(;|$)/i.test(params) || /^\d{8}$/.test(value.trim());
    } else if (prop === 'DTEND') cur.end = parseIcsDate(value);
    else if (prop === 'SUMMARY') cur.summary = unescapeText(value);
    else if (prop === 'RRULE') cur.rrule = value;
    else if (prop === 'EXDATE') {
      cur.exdates = cur.exdates || [];
      for (const part of value.split(',')) { const d = parseIcsDate(part); if (d) cur.exdates.push(d); }
    }
  }
  return events;
}

// ---- RRULE expansion into a time window (best-effort) ----
// Supports FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL/UNTIL/COUNT and
// BYDAY for WEEKLY. Anything fancier shows only the first occurrence.

const DAY_MS = 86400000;
const BYDAY_IDX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function sameOccurrence(d, ex, allDay) {
  if (allDay) return d.getFullYear() === ex.getFullYear() && d.getMonth() === ex.getMonth() && d.getDate() === ex.getDate();
  return Math.abs(d - ex) < 1000;
}

function occurrences(ev, ws, we) {
  const durMs = ev.end ? Math.max(0, ev.end - ev.start) : (ev.allDay ? DAY_MS : 3600000);
  const emit = [];
  const push = (start) => {
    if (start < we && (start.getTime() + durMs) > ws.getTime()) {
      if (!(ev.exdates || []).some((ex) => sameOccurrence(start, ex, ev.allDay))) {
        emit.push({ summary: ev.summary || '', allDay: !!ev.allDay, start, end: new Date(start.getTime() + durMs) });
      }
    }
  };
  if (!ev.rrule) { push(ev.start); return emit; }

  const rule = {};
  for (const kv of ev.rrule.split(';')) { const i = kv.indexOf('='); if (i > 0) rule[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1); }
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL) : null;
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
  const stopAt = until ? Math.min(until.getTime() + DAY_MS, we.getTime()) : we.getTime();

  let made = 0;
  const MAX = 3000; // hard stop, a window is at most a few weeks anyway
  const s = ev.start;

  if (freq === 'WEEKLY' && rule.BYDAY) {
    const days = rule.BYDAY.split(',').map((d) => BYDAY_IDX[d.trim().slice(-2)]).filter((d) => d !== undefined);
    // Week 0 = the week (Sunday-based, matching BYDAY_IDX) containing DTSTART.
    const week0 = new Date(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay(), s.getHours(), s.getMinutes(), s.getSeconds());
    for (let k = 0; made < MAX; k += 1) {
      const weekStart = new Date(week0.getTime() + k * interval * 7 * DAY_MS);
      if (weekStart.getTime() > stopAt) break;
      for (const d of days.slice().sort((a, b) => a - b)) {
        const occ = new Date(weekStart.getTime() + d * DAY_MS);
        if (occ < s) continue;
        made++;
        if (count && made > count) return emit;
        if (until && occ > until) return emit;
        push(occ);
        if (made >= MAX) break;
      }
    }
    return emit;
  }

  let occ = new Date(s);
  while (made < MAX) {
    made++;
    if (count && made > count) break;
    if (until && occ > until) break;
    if (occ.getTime() > stopAt) break;
    push(occ);
    if (freq === 'DAILY') occ = new Date(occ.getTime() + interval * DAY_MS);
    else if (freq === 'WEEKLY') occ = new Date(occ.getTime() + interval * 7 * DAY_MS);
    else if (freq === 'MONTHLY') occ = new Date(occ.getFullYear(), occ.getMonth() + interval, occ.getDate(), occ.getHours(), occ.getMinutes());
    else if (freq === 'YEARLY') occ = new Date(occ.getFullYear() + interval, occ.getMonth(), occ.getDate(), occ.getHours(), occ.getMinutes());
    else break; // unsupported FREQ: only the first occurrence
  }
  return emit;
}

// ---- Cache + synchronous accessor for the render loop ----

const REFRESH_MS = 15 * 60 * 1000; // re-fetch a calendar every 15 min
const ERR_RETRY_MS = 60 * 1000;    // retry a failed fetch after 1 min

const cals = new Map();    // url -> { status: 'loading'|'ok'|'error', raw, fetchedAt, lastTry, error, fetching }
const weekCache = new Map(); // url -> { key, events }

function refreshIfDue(url) {
  let c = cals.get(url);
  if (!c) {
    c = { status: 'loading', raw: null, fetchedAt: 0, lastTry: 0, error: '', fetching: false };
    // Last-known-good from a previous session: shown immediately (marked
    // stale via fetchedAt=0, so a real refresh is still kicked off below)
    // instead of a blank "loading" state while offline or waiting on a peer.
    const cachedText = loadCachedIcs(url);
    if (cachedText) { try { c.raw = parseIcs(cachedText); c.status = 'ok'; } catch (e) { /* corrupt cache: ignore */ } }
    cals.set(url, c);
  }
  const now = Date.now();
  const due = c.status === 'error' ? (now - c.lastTry > ERR_RETRY_MS) : (now - c.fetchedAt > REFRESH_MS);
  if (c.fetching || !due) return c;
  c.fetching = true;
  c.lastTry = now;
  fetchIcsText(url)
    .then((text) => { c.raw = parseIcs(text); c.fetchedAt = Date.now(); c.status = 'ok'; c.error = ''; saveCachedIcs(url, text); })
    .catch((e) => { if (!c.raw) c.status = 'error'; c.error = e.message || String(e); })
    .finally(() => { c.fetching = false; });
  return c;
}

// Called by sync.js right when a liaison connection actually opens (host or
// client side). The render loop tries a fresh board's calendar blocks on the
// very first frame, almost always before joinOrHost's WebRTC handshake has
// finished -- that attempt loses the peer-relay race, fails locally too
// (CORS on the web build), and would otherwise sit on the up-to-1-minute
// error-retry cadence before trying the (now available) peer again.
export function retryFailedIcs() {
  for (const c of cals.values()) if (c.status === 'error') c.lastTry = 0;
}

// Monday 00:00 (local) of the current week -> next Monday.
export function weekWindow(now = new Date()) {
  const dow = (now.getDay() + 6) % 7; // 0 = Monday
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

// Called from render every frame: returns the current week's events for a
// calendar URL, kicking off/refreshing the fetch in the background. Never
// throws, never blocks.
export function calendarWeek(url) {
  const c = refreshIfDue(url);
  if (!c.raw) return { status: c.status, error: c.error, days: null };
  const { start, end } = weekWindow();
  const key = start.getTime() + ':' + c.fetchedAt;
  let wc = weekCache.get(url);
  if (!wc || wc.key !== key) {
    const evs = [];
    for (const ev of c.raw) evs.push(...occurrences(ev, start, end));
    // Bucket per day (an event spanning several days appears in each).
    const days = Array.from({ length: 7 }, () => []);
    for (const ev of evs) {
      for (let d = 0; d < 7; d++) {
        const ds = new Date(start.getTime() + d * DAY_MS), de = new Date(start.getTime() + (d + 1) * DAY_MS);
        if (ev.start < de && ev.end > ds) days[d].push(ev);
      }
    }
    for (const list of days) list.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : (a.allDay ? -1 : 1)));
    wc = { key, days };
    weekCache.set(url, wc);
  }
  return { status: 'ok', error: '', days: wc.days, weekStart: start };
}
