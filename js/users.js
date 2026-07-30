// User identity (local to the browser): a stable id + a chosen name.
import { t } from './i18n.js?v=ms7d04ny';

const UID = 'bete:uid';
const UNAME = 'bete:username';

export function getUserId() {
  try {
    let i = localStorage.getItem(UID);
    if (!i) { i = 'u-' + Math.random().toString(36).slice(2, 8); localStorage.setItem(UID, i); }
    return i;
  } catch (e) { return 'u-anon'; }
}

export function getUserName() {
  try { return localStorage.getItem(UNAME) || ''; } catch (e) { return ''; }
}

export function setUserName(n) {
  try { localStorage.setItem(UNAME, (n || '').slice(0, 24)); } catch (e) { /* */ }
}

// Display name: the chosen name, otherwise "Guest xxxx".
export function displayName() {
  return getUserName() || (t('liaison.guest') + ' ' + getUserId().slice(2, 6));
}
