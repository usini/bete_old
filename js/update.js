// Desktop-only auto-update: checks the GitHub release feed (via the Tauri
// updater plugin) and offers to install if a newer version is published.
// A no-op on the web build. Loaded from a CDN (esm.sh) only when running in
// the desktop wrapper, same pattern as the PeerJS/QR CDN loads in sync.js --
// keeps the web bundle free of any npm dependency.
import { isDesktop } from './platform.js?v=ms7c2a3u';
import { t } from './i18n.js?v=ms7c2a3u';

const UPDATER_MOD = 'https://esm.sh/@tauri-apps/plugin-updater@2';
const PROCESS_MOD = 'https://esm.sh/@tauri-apps/plugin-process@2';

// Returns true if a newer native build was found (the install popup is
// already showing), false otherwise (up to date, offline, or an error) --
// lets a manual "check now" button (see settings.js) report back either
// way, unlike the silent boot-time call in main.js.
export async function checkForUpdate() {
  if (!isDesktop) return false;
  try {
    const { check } = await import(UPDATER_MOD);
    const update = await check();
    if (update) { showUpdatePopup(update); return true; }
    console.log('Bete: no update available (already on the latest version, or check returned null)');
    return false;
  } catch (e) {
    // Never blocks the app, but a silent catch here means an update failure
    // is otherwise invisible -- log it so `right-click > Inspect` (devtools
    // enabled in the desktop build) can actually show what went wrong.
    console.error('Bete: update check failed', e);
    return false;
  }
}

function showUpdatePopup(update) {
  const el = document.getElementById('updatepopup');
  if (!el) return;
  el.querySelector('.up-msg').textContent = t('update.available', { version: update.version });
  const installBtn = el.querySelector('.up-install');
  const laterBtn = el.querySelector('.up-later');
  const status = el.querySelector('.up-status');
  installBtn.onclick = async () => {
    installBtn.disabled = true; laterBtn.disabled = true;
    status.textContent = t('update.installing');
    try {
      await update.downloadAndInstall();
      const { relaunch } = await import(PROCESS_MOD);
      await relaunch();
    } catch (e) {
      status.textContent = t('update.failed');
      installBtn.disabled = false; laterBtn.disabled = false;
    }
  };
  laterBtn.onclick = () => el.classList.add('hidden');
  el.classList.remove('hidden');
}
