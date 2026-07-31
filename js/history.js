// Daily board history: keeps up to HISTORY_MAX snapshots (one per calendar
// day the board was actually opened, local time), so a board clobbered by a
// bad sync or a bad edit can still be reverted days later. Local to this
// browser only (like undo) -- never synced to peers, never touches
// node.image/audio bytes (a snapshot's idb: refs still point at whatever is
// in IndexedDB *now*; an image/memo deleted since would no longer resolve --
// same caveat as importing an old JSON export).
import { getHistory, putHistory } from './audio.js?v=ms954yha';
import { serialize } from './state.js?v=ms954yha';

const HISTORY_MAX = 7; // ~a week of daily snapshots -- bump freely, nothing else assumes this number

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Called once per board open (see main.js): if today doesn't already have a
// snapshot, mirrors the CURRENT (just-loaded, pre-sync) state into a new
// slot -- captures how the board looked at the start of today, before any
// of today's edits (or an incoming peer sync) can touch it. A no-op on every
// later open the same day.
export async function ensureTodaySnapshot(boardId) {
  try {
    const list = await getHistory(boardId);
    if (list.length && list[list.length - 1].date === todayStr()) return;
    list.push({ date: todayStr(), ts: Date.now(), data: serialize() });
    while (list.length > HISTORY_MAX) list.shift();
    await putHistory(boardId, list);
  } catch (e) { /* best-effort */ }
}

// Snapshots for a board, oldest first (for the Settings > Data history list).
export async function listBoardHistory(boardId) {
  try { return await getHistory(boardId); } catch (e) { return []; }
}

// Overwrites (or creates) TODAY's slot with the CURRENT state -- called
// right before reverting to an OLDER day, so the moment right before
// switching away is never lost (see settings.js: revert flow).
export async function updateTodaySnapshot(boardId) {
  try {
    const list = await getHistory(boardId);
    const today = todayStr();
    const i = list.findIndex((e) => e.date === today);
    const entry = { date: today, ts: Date.now(), data: serialize() };
    if (i >= 0) list[i] = entry;
    else { list.push(entry); while (list.length > HISTORY_MAX) list.shift(); }
    await putHistory(boardId, list);
  } catch (e) { /* best-effort */ }
}
