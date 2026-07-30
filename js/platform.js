// Desktop-only concerns (Windows wrapper via Tauri). A no-op module on the
// web build: isDesktop is false there, and every exported helper falls back
// to the normal browser behavior.
const KEY = 'bete:linkmode'; // desktop-only: 'internet' (default) | 'lan'

export const isDesktop = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

let linkMode = 'internet';
try { const m = localStorage.getItem(KEY); if (m === 'lan' || m === 'internet') linkMode = m; } catch (e) { /* */ }

export function getLinkMode() { return linkMode; }
export function setLinkMode(m) {
  if (m !== 'lan' && m !== 'internet') return;
  linkMode = m;
  try { localStorage.setItem(KEY, m); } catch (e) { /* */ }
}

// Cached "http://<lan-ip>:<port>" resolved once at boot via a Tauri command
// (a plain webview has no way to read the machine's LAN address itself).
let lanUrl = null;

export async function initDesktopLink() {
  if (!isDesktop) return;
  try { lanUrl = await window.__TAURI__.core.invoke('get_lan_url'); } catch (e) { lanUrl = null; }
}

// Displayed in Settings so a user can tell which build they're actually
// running without guessing -- useful when troubleshooting the auto-updater.
export async function getAppVersion() {
  if (!isDesktop) return null;
  try { return await window.__TAURI__.core.invoke('plugin:app|version'); } catch (e) { return null; }
}

// The origin+path to embed in links handed to OTHER people (liaison QR code,
// "link to board" blocks) — as opposed to internal navigation (switching the
// current window to a different local board), which must keep using the real
// location.origin so it still resolves inside the desktop webview.
//
// tauri://localhost (or http://tauri.localhost) isn't reachable by anyone
// else, so on desktop we substitute either the public deployment or this
// machine's LAN address, per the user's choice in Settings > Sharing.
const PUBLIC_URL = 'https://bete.usini.eu/'; // desktop-only fallback; web builds always use their own origin
export function shareOrigin() {
  if (!isDesktop) return location.origin + location.pathname;
  if (linkMode === 'lan' && lanUrl) return lanUrl;
  return PUBLIC_URL;
}

// Saves a text file to disk, on web and desktop alike.
//
// On the web build, the classic Blob + <a download> trick works fine (every
// browser shows its own "Save As" / auto-download behavior for it). Inside
// the Tauri desktop wrapper (WebView2 on Windows), that same trick silently
// does nothing -- WKWebView/WebView2 don't implement the `download`
// attribute the way a real browser tab does, so nothing gets saved and
// nothing is shown to the user either. The fix is to go through Tauri's
// dialog + fs plugins instead: a real native Save As dialog, then a plugin
// write to the path the user picked (that path is exempt from the fs
// plugin's path-scope allowlist, since it came from the dialog itself).
const DIALOG_MOD = 'https://esm.sh/@tauri-apps/plugin-dialog@2';
const FS_MOD = 'https://esm.sh/@tauri-apps/plugin-fs@2';

export async function saveTextFile(text, filename, extFilter) {
  if (!isDesktop) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  try {
    const { save } = await import(DIALOG_MOD);
    const { writeTextFile } = await import(FS_MOD);
    const path = await save({
      defaultPath: filename,
      filters: extFilter ? [{ name: extFilter.toUpperCase(), extensions: [extFilter] }] : undefined,
    });
    if (!path) return false; // user cancelled the dialog
    await writeTextFile(path, text);
    return true;
  } catch (e) {
    console.error('Bete: saveTextFile failed', e);
    return false;
  }
}

// ---- Export-on-exit: remembered default folder (desktop only) ----
// See main.js: registers a window close-requested handler that exports
// every board to this folder before actually closing (prompting for it via
// pickExportFolder the first time, since there's nothing to remember yet).
const EXPORT_DIR_KEY = 'bete:exportdir';
export function getExportFolder() {
  try { return localStorage.getItem(EXPORT_DIR_KEY) || ''; } catch (e) { return ''; }
}
export function setExportFolder(dir) {
  try { if (dir) localStorage.setItem(EXPORT_DIR_KEY, dir); else localStorage.removeItem(EXPORT_DIR_KEY); } catch (e) { /* */ }
}

// Native folder picker (desktop only). Returns the chosen absolute path, or
// null if the user cancelled.
export async function pickExportFolder() {
  if (!isDesktop) return null;
  try {
    const { open } = await import(DIALOG_MOD);
    const dir = await open({ directory: true, multiple: false });
    return dir || null;
  } catch (e) {
    console.error('Bete: pickExportFolder failed', e);
    return null;
  }
}

// Writes a file straight into an already-known folder, no dialog -- see
// write_export_file in desktop/src-tauri/src/lib.rs for why this goes
// through a Rust command instead of the fs plugin directly (its path-scope
// exemption only covers a path a dialog JUST returned, not one remembered
// from an earlier run).
export async function writeExportFile(dir, filename, contents) {
  if (!isDesktop) return false;
  try {
    const path = dir.replace(/[\\/]+$/, '') + '/' + filename;
    await window.__TAURI__.core.invoke('write_export_file', { path, contents });
    return true;
  } catch (e) {
    console.error('Bete: writeExportFile failed', e);
    return false;
  }
}

// Opens an external (http/https) link in the system's default browser.
//
// On the web build, window.open(_blank) is exactly what you want. Inside the
// Tauri desktop wrapper, window.open on an external URL doesn't reach a real
// browser at all -- it either does nothing or tries to navigate the app's
// own webview to it. The opener plugin's openUrl() hands the URL to the OS
// instead, which is what actually launches the user's default browser.
const OPENER_MOD = 'https://esm.sh/@tauri-apps/plugin-opener@2';

export async function openExternal(url) {
  if (!isDesktop) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const { openUrl } = await import(OPENER_MOD);
    await openUrl(url);
  } catch (e) {
    console.error('Bete: openExternal failed', e);
  }
}

// Hot-updates the desktop app's web assets (js/css/html) from bete.usini.eu
// without a full MSI reinstall, for the common case where a fix only touches
// this static web app and nothing in the Rust/plugin side. A no-op on the web
// build (already always on the latest deploy). See check_web_update in
// desktop/src-tauri/src/main.rs for the actual download/compare logic -- this
// is intentionally "dumb" on the JS side: invoke the command, reload if it
// says something changed, otherwise (including "offline") do nothing.
// onUpdated (optional): called just before the reload that applies the
// update, so the caller can show something ("updating...") instead of the
// app silently reloading out of nowhere -- runs off the main thread on the
// Rust side (spawn_blocking), so this await doesn't freeze the window while
// the new assets download, but a page reload with no warning still reads as
// "did this just crash?" without it.
// Returns true if an update was found (a reload is already scheduled),
// false otherwise (already up to date, offline, or an error) -- lets a
// manual "check now" button (see settings.js) report back either way,
// unlike the silent boot-time call in main.js which only cares about the
// true case.
export async function checkWebUpdate(onUpdated) {
  if (!isDesktop) return false;
  try {
    const updated = await window.__TAURI__.core.invoke('check_web_update');
    if (updated) {
      if (onUpdated) onUpdated();
      setTimeout(() => location.reload(), 600); // long enough to actually see the message above
    }
    return !!updated;
  } catch (e) {
    console.error('Bete: checkWebUpdate failed', e);
    return false;
  }
}
