# CLAUDE.md

Guide for any Claude Code instance working on this repo.

## The project

**Bete**: pixel-art mindmap, 100% static. Vanilla JS (ES modules),
Canvas 2D, **no npm dependency, no build step**. Deployed as-is on GitHub Pages.

- Active repo: `github.com/usini/bete`
- Site: https://bete.usini.eu/ (custom domain, see `CNAME` — served via GitHub Pages)
- User doc (features, mouse/touch controls): [README.md](README.md)

**`github.com/remisarrailh/pensebete` no longer exists** (old project name,
TODOMAPPA / pense-bête). It was archived then deleted by the owner. `origin` of
this local repo points to `usini/bete`. If you see that other URL anywhere
(config, external doc, memory from a previous session), it's a stale trace to
fix, not a valid destination — don't try to push there, it will fail.

## Language: code in English, app in French + English

- **Code comments, console/log messages, docs (`README.md`, `server/README.md`,
  `CLAUDE.md`) are in English by default.** A full pass translated the entire
  codebase to English (July 2026) — keep writing new comments in English,
  don't reintroduce French ones.
- **The app's UI is bilingual** (French + English) via a small i18n system —
  see the dedicated section below. This is the one place where French text is
  expected and correct (in the `fr` dictionary of `js/i18n.js`, and in
  `TUTORIAL_FR` in `js/tutorial.js`).
- `js/tutorial.js` intentionally contains French strings (in `TUTORIAL_FR`) —
  that's demo board content, not a stray untranslated comment.

## Branding convention — no mention of the old name

The project is called **Bete**, period. Don't (re)introduce the old names
(TODOMAPPA, pense-bête, pensebete) anywhere: not in code, not in identifiers
(localStorage keys, IndexedDB database names, env vars, service names), not in
docs. A rename happened (see "History" below) specifically to eliminate these
mentions — don't let them reappear by copy-pasting old code.

## Convention — avoid hardcoded links/URLs

The project must stay easy to redeploy elsewhere (different domain, different fork).
As a result:

- **In client code** (`js/*`), never hardcode the production domain. Board/liaison
  links already use `location.origin`/`location.pathname`
  (`boards.js: buildBoardUrl/parseBoardUrl`) — keep following that pattern for
  any new internal link feature.
- **In `server/bete-host.js`**, `APP_URL` has **no hardcoded default** (empty by
  default): it's configured via the `BETE_APP_URL` env var. Never put a default
  domain back in there.
- **In `server/install-pi.sh`**, the only place where a domain/repo has a
  reasonable default is `REPO` (`BETE_REPO`, pointing to `usini/bete`) — but it
  stays overridable via an env var for anyone forking the project.
- Docs (`README.md`, `server/README.md`) can mention the real production URL
  (`bete.usini.eu`) as human-facing info — that's not the same thing as a
  hardcoded link in executed code.

## No data backward-compatibility (explicit decision)

Unlike older migrations that used to exist (legacy single-file board, legacy
localStorage keys prefixed `todomappa:`), it was explicitly decided **not to
migrate** data from the old branding to the new one: fresh start. Don't
reintroduce `todomappa* -> bete*` migration code unless explicitly asked —
this choice was made knowingly (accepted loss of boards/memos/images stored
under the old naming in users' browsers).

## Architecture

```
index.html               entry point: canvas + HTML overlays (menus, popups, buttons)
css/style.css             pixel palette, CRT scanlines, neon glow, themes
js/main.js                bootstrap, RAF loop, wiring of global buttons
js/state.js               data model, serialize()/load(), localStorage autosave
js/camera.js              world<->screen transform, zoom/pan
js/physics.js             elastic inertia spring + wobble (deformation) per node
js/render.js              drawing (grid, circles, hexagons, rectangles, cursors)
js/input.js               mouse/touch, drag, radial menu, text editing, image D&D
js/minimap.js             minimap + click to recenter
js/io.js                  JSON export/import
js/sync.js                P2P sync (PeerJS/WebRTC): host/client, delta, merge, presence
js/audio.js               IndexedDB: audio blobs (voice memos) + images + board history
js/images.js              image offload -> IndexedDB (ref 'idb:<hash>'), migration, export
js/voice.js               voice memos: recording, playback, P2P sharing
js/history.js             daily board-history snapshots (revert), IndexedDB-backed
js/voicechat.js           live voice chat (WebRTC mesh), Always On, mic choice
js/settings.js            Settings panel (theme, language, liaisons, voice, data...)
js/i18n.js                i18n engine: FR/EN dictionaries, t(), language detection/persistence
js/boards.js, liaisons.js multi-board management + named liaisons
js/theme.js               themes (pixel/classic/classic-dark/winxp), text size
js/users.js               local identity (uid, displayed name)
js/yt.js, video.js         YouTube inline thumbnail/player integration
js/ics.js                 ICS calendar blocks: fetch (CORS workarounds), parser, RRULE, cache
js/fx.js                  particle explosion on deletion
js/tutorial.js             built-in demo board (read-only), FR + EN variants
cachebust.mjs             adds ?v=<version> to imports before every deploy
CNAME                     custom GitHub Pages domain (bete.usini.eu)
server/                   headless Node host (Raspberry Pi) — see server/README.md
desktop/                  Windows desktop wrapper (Tauri) — see desktop/README.md
```

No bundler: modules are imported directly (`import ... from './x.js?v=...'`).
The `?v=` is a cache-buster, not a real version — see below.

## Data model (`state.js`)

```js
{
  version, camera: { x, y, zoom },
  nodes:    [ { id, x, y, w, h, text, image?, link?, kind?, ref?, dur? } ],
  circles:  [ { id, x, y, r, color, description } ],
  hexagons: [ { id, x, y, r, color, description } ],
}
```

- `nodes` = rectangles / signs / voice memo blocks (`kind:'voice'`) / links (`ref` = the
  source's id, inherits text/image/link).
- A rectangle's effective color = the last circle/hexagon (z-order) containing its
  center, never stored (recomputed on render).
- `image`: either a legacy data URL, or `'idb:<hash>'` (IndexedDB reference, see below).

## Local storage — current prefixes

All localStorage keys are prefixed `bete:` (e.g. `bete:boards`, `bete:liaisons`,
`bete:theme`, `bete:<boardId>`, `bete:lang`), except `bete:peer` (local peer id)
and `bete:uid`/`bete:username` (identity). The IndexedDB database is called
`bete` (stores `audio` and `images`). The console debug handle is exposed on
`window.bete`.

## i18n system (`js/i18n.js`)

Deliberately minimal, no build step, no external files — two plain JS
dictionary objects (`STRINGS.fr`, `STRINGS.en`) plus a lookup function.

- `t(key, vars?)`: looks up the current language, falls back to English, then
  to the raw key (never throws, never shows "undefined"). Supports `{name}`
  placeholder interpolation via `vars`.
- `getLang()` / `setLang(code)`: current language + explicit switch, persisted
  to `bete:lang`. Changing language calls `applyStaticI18n()` to refresh static
  HTML chrome immediately.
- Language detection: guesses from `navigator.language` on first visit; an
  explicit choice in Settings → Language is saved and always takes priority
  afterwards.
- `LANGS`: the list shown in the Settings language picker.
- `applyStaticI18n(root?)`: scans `data-i18n` / `data-i18n-html` /
  `data-i18n-title` / `data-i18n-aria` / `data-i18n-placeholder` attributes in
  the DOM and fills them in — used for the static chrome in `index.html`.
  Dynamic UI (settings panel, radial menu, toasts, alerts) calls `t()` directly
  wherever it builds text, since those are rebuilt on every open/frame anyway.
- **Adding a language**: add one more dictionary object with the same keys as
  `en` (missing keys fall back to English automatically) + one entry in
  `LANGS`. That's the whole cost — no other file needs to change.
- `js/tutorial.js` exports `TUTORIAL_FR` and `TUTORIAL_EN` (translated via
  `scripts/translate-tutorial.mjs`, keeping ids/positions/images identical, only
  translating `text`/`description` fields). `main.js` picks the variant based
  on the current language at boot.

## P2P sync (`sync.js`) — key points

- **Content only** is synced (text, image, color, description, links,
  creations/deletions, positions **on drop only**). The camera stays local to
  each screen.
- **Board name + liaison name** ride along in every sync payload as `bn`
  (`merge()` adopts it only if `getBoardName()` is still empty — never
  clobbers a name we already have, whether from our own edit or an earlier
  sync — and also names the liaison it arrived from via `recordLiaison`,
  which itself no-ops over a local rename). This replaced the old
  `?name=`/`?peer_name=` URL params, which were an easy-to-desync duplicate
  of the exact same information already carried by the sync itself. The
  headless Pi host mirrors this (`server/bete-host.js`: `b.name`, learned
  once from whichever client's sync first carries a `bn` and persisted).
  A name equal to the board's own id (or a peer's own id, for liaisons) is
  never treated as real — it's just the "nothing chosen yet" display
  fallback (`js/main.js`: `resolveBoardName`/`applyBoardNameUI` show the id
  but deliberately don't `setBoardName()` it, so it's never persisted,
  exported, or sent as `bn`; `js/liaisons.js`: `recordLiaison`'s `renamed`
  check treats a name equal to the peer id the same way). Without this, a
  headless host — whose own name always starts unset — could pick up some
  client's still-unset fallback and hand it to every future client as if it
  were genuine, and a real rename from anyone else would then never stick
  (`bete-host.js`: `realName()`/`merge()` guard against this defensively too).
- **Rotating a compromised peer id**: a browser-hosted liaison has a one-click
  revoke (`sync.js`: `refreshHostId`, the liaison block's "New link" — kills
  the old id immediately, connected guests are dropped). The headless Pi host
  has no in-app equivalent: rotate it server-side (delete `server/data/peer-id`
  or set `BETE_ID`, then restart the service). Either way, every local
  reference to the OLD id (the liaison bookmark, the "boards" directory
  grouping, every board-link block across every saved board) is stuck
  pointing at a now-dead id until told otherwise — Settings → Liaisons has a
  "🆔" button (`settings.js`, using `liaisons.js`: `changeLiaisonPeer` +
  `boards.js`: `renameBoardsPeer`/`rewriteLinksPeer`) that rewrites all of
  that in one go, in this browser. It only edits local bookkeeping, never the
  actual peer/host — each device still needs to run this once (or get a
  fresh link) after the real rotation.
- **A liaison you HOST is bookmarked too**, not just one you join as a
  client: `recordLiaison`/`recordBoard` used to only ever run client-side
  (joining via `?peer=`), so creating a liaison and just navigating away
  lost it entirely — no way back short of re-sharing the link. `sync.js`'s
  `openHostPeer` now calls both, the moment the host peer id is actually
  confirmed open (`peer.on('open', ...)`, not on `startHost()` — the id
  isn't real yet at that point): the liaison is named after the current
  board, and that board's own "boards" directory entry is pointed at the
  new peer, so it shows up grouped under its liaison there too instead of
  staying "unlinked".
- Host/client election (`joinOrHost`): the first to claim the peer id becomes
  the host, subsequent ones become clients. Host heartbeat (3s) + client
  watchdog (8s) to detect connection loss. **Cautious** reconnection: the
  client first retries as a client (3 attempts) before attempting a host
  election, to avoid stealing the id from a permanent host (Pi) that's restarting.
- **DELTA sync**: only the content entries that changed + deletions are
  rebroadcast on each tick (800ms), not the whole board. The very first send
  after connecting stays full (seed). This has some history — see below.
- Merge by id, conflicts resolved with **LWW + host priority** (on tied timestamp).
- Audio and images NEVER transit as base64 in the sync payload: they're sent
  as binary on demand (`audioReq`/`audioRes`, `imgReq`/`imgRes` protocols) and
  cached locally (IndexedDB) + host-side (memory, bounded for images).
- **Read-only boards** (`state.readOnly`, toggled via `setBoardReadOnly()`):
  since the topology is a star (every client talks only to the host, never to
  each other), the host can simply refuse to merge/relay `sync`/`move`/`delete`
  content coming from a guest connection (`handleData`'s `origin` param is only
  ever set for messages actually received over the wire — never for the
  host's own local edits) — a real guarantee, not just a disabled UI. The
  headless Pi host (`server/bete-host.js`) has no such built-in "host process"
  to trust (every connection is symmetric there), so it uses a separate
  **owner token** mechanism instead: the first client ever to connect to a
  fresh board is auto-adopted as its owner (token generated client-side in
  `js/liaisons.js`, `getOwnerToken()`); see `server/README.md`.

## Images: IndexedDB offload (`images.js`, `audio.js`)

Images are **no longer** stored as inline base64 in `node.image`: they're
stored in IndexedDB, indexed by the **SHA-256 hash of their content**, and the
node only keeps a `'idb:<hash>'` ref. Why: on a board with lots of images,
rebroadcasting base64 on every sync tick would saturate the P2P connection
(to the point of crashing the Pi host).

- `storeImage(dataUrl)` → writes to IndexedDB, returns the ref.
- `getImageEl(ref)` (used by render.js via `getImg`) → resolves the ref to an
  `<img>`, requests the bytes from peers if missing locally (`requestImage`/`imgReq`).
- `migrateImages()`: converts legacy images (data URL) to IndexedDB refs as a
  background task — called on boot (`main.js`) and after a JSON import.
- `inlineImages()`: re-inlines refs to data URLs for a **self-contained JSON
  export** (the file must stay openable without the original peers/IndexedDB).
- Any new feature touching `node.image` must go through this module, never
  write a raw data URL to `node.image` without offloading it.
- A voice memo's audio (`audio.js`: `putAudio`/`getAudio`, keyed by the
  node's own id, unlike images which are keyed by content hash) follows the
  same inline-for-export / restore-on-import pattern, in `voice.js`:
  `inlineAudio()`/`restoreAudio()`. This was missing entirely until it was
  added (a memo exported/imported into another browser used to keep an empty
  `kind:'voice'` shell — duration only, no sound — since only the IndexedDB
  ref existed, never the bytes). `io.js`'s 4 export/import paths all call
  both the image and audio version; `main.js` also calls `restoreAudio()` at
  boot (mirroring `migrateImages()`) since a bulk restore
  (`importAllBoards`) writes each board's raw JSON straight to localStorage
  without loading it, so inlined audio only gets pulled back into IndexedDB
  once that specific board is actually opened.
- Caveat shared by both: `inlineImages`/`inlineAudio` can only re-inline what
  this browser already has locally cached — a block whose bytes were never
  actually downloaded from a peer (still just an unresolved `idb:` ref) is
  exported as a dangling reference and won't resolve on another profile.
  `io.js`'s `exportJSON()` now checks for this automatically before
  exporting the currently open board (`ensureMediaCached()`, using
  `images.js`/`voice.js`: `hasImageLocally`/`hasAudioLocally`): if a live
  liaison is connected it actively asks peers for whatever's missing and
  waits a few seconds, then a toast reports how many blocks (if any)
  couldn't be fetched and will export incomplete — never a hard block,
  export always proceeds. `exportAllBoards()` only does the passive count
  (no active fetch: a board that isn't the one currently open has no live
  connection to ask).

## Daily board history (`history.js`) — revert to an earlier day

One snapshot per **calendar day** a board was actually opened (local time),
kept for the last 7 days (`HISTORY_MAX` in `history.js`, easy to bump) —
stored in IndexedDB (`bete` DB, `history` store, one record per board id
holding its whole array of `{ date, ts, data }` entries; `data` is a full
`serialize()` snapshot). Deliberately local to this browser only, never
synced to peers — same trust boundary as the undo stack.

- `ensureTodaySnapshot(boardId)`: called once at boot (`main.js`, right after
  the board is loaded/restored, before `migrateImages`/`restoreAudio`) — if
  today doesn't already have a slot, mirrors the CURRENT state into one. This
  captures how the board looked at the start of today, before either today's
  edits OR an incoming peer sync can touch it — the whole point being able to
  recover from "someone/something clobbered the board today." A no-op on
  every later open the same day. Skipped for `tutorial` (read-only) and
  `boards` (regenerated, never persisted).
- Settings → Data → History lists every kept day (oldest hidden at the
  bottom, `⏪` button per row, two-tap confirm like the "clear board"
  button). Reverting to a day OTHER than today first calls
  `updateTodaySnapshot()` to overwrite today's own slot with the CURRENT
  state — the moment right before switching away is never lost, so
  reverting a revert is always possible (revert to "today" afterwards to
  undo it). Reverting to today's own slot is a harmless no-op.
- Same caveat as JSON export/import: a snapshot's `idb:` image/audio refs are
  only as good as whatever's still in this browser's IndexedDB when you
  revert — content deleted since the snapshot was taken won't resolve.

## Deployment workflow (on every JS/HTML change)

```bash
node cachebust.mjs          # 1. bump ?v= on all imports + index.html
git add -A && git commit -m "..."   # 2. commit (message WITHOUT quotes, see conventions)
git push                    # 3. push -> triggers the GitHub Pages deployment
```

Then **wait for the deployment** (poll `https://bete.usini.eu/index.html` in
prod until you see the new `?v=`) before considering the work done — GitHub
Pages takes 30s to a few minutes to propagate.

**If the change touches `server/bete-host.js`**, the permanent host (Raspberry
Pi, systemd service `bete`) also needs updating:

```bash
ssh maison 'cd ~/pensebete && git pull --ff-only && sudo -n systemctl restart bete'
```

(Passwordless SSH configured to the `maison` host; `sudo -n` works without a
password for this service. The folder cloned on the Pi is still called
`~/pensebete` — that's just a local directory name, no consequence; not worth
renaming unless asked.) Then check the logs: `sudo -n journalctl -u bete -n 20`.

## Conventions for this repo

- **No build dependency**: don't introduce a bundler, TypeScript, or npm on
  the client side. `server/` (Node on the Pi) is the only place with a `package.json`.
- **No quotes in commit messages** (constraint of the user's shell
  environment); end with `Co-Authored-By: Claude ... <noreply@anthropic.com>`.
- Never commit the Pi's private peer id (`server/data/peer-id`) or any secrets.
- The `home` board is **sanctuarized**: never connected over P2P (protects
  against accidental overwrite).
- Reserved board ids (`home`, `tutorial`, `boards`) always display a
  translated name (`js/boards.js`: `reservedBoardLabel()`) instead of
  whatever is stored — don't special-case them again elsewhere, reuse that
  helper. `boards` is a built-in, non-editable directory (`js/main.js`:
  `loadBoardsDirectory()`) regenerated from `listBoards()` on every open;
  Home always keeps a link to it (`ensureBoardsLinkOnHome()`), and any other
  board opened for the first time gets a link back to Home
  (`seedHomeLink()`). Exactly two actions are still allowed on `boards`
  itself (`js/input.js`): deleting a board block goes through a confirmation
  modal and actually erases the board's saved content (`boards.js`:
  `deleteBoardData()`), unlike a normal rectangle delete — and each known
  liaison gets its own circle (peer stored on the in-memory-only `circle.peer`,
  never serialized since this board's content is never saved); dragging a
  board block in/out of a circle re-pairs it with that liaison
  (`recordBoard(id, name, peer)`), same containment rule as
  `state.js: effectiveColor()`.
- Testing P2P sync with **two tabs of the same browser gives false negatives**
  (same `localStorage` → same uid → cursor/voice/presence collisions). Prefer
  two real devices, or at least two different browsers.
- Comments: only when the WHY isn't obvious (a hidden constraint, the reason
  for a workaround) — no comments that just describe what the code does.
- See also the two dedicated conventions above: no mention of the old name,
  avoid hardcoded links.

## Useful history (why some things are the way they are)

- **Full-board sync on every tick** was replaced with **delta** after an
  incident: on a board rich in images, the repeated traffic was crashing the
  Pi server (`WebSocket was closed before the connection was established`, an
  unhandled exception in peerjs/ws crashing the Node process). The server also
  gained `process.on('uncaughtException'/'unhandledRejection')` guards and a
  `disconnected` handler that does `destroy()` + a scheduled restart instead
  of `peer.reconnect()` (buggy on the wrtc/ws stack).
- The IndexedDB image offload followed immediately, for the same reason (delta
  alone wasn't enough: large inline images stayed huge whenever they changed).
- **Rebrand (July 2026)**: the project was called TODOMAPPA (repo
  `remisarrailh/pensebete`, GitHub Pages `remisarrailh.github.io/pensebete`).
  It was renamed **Bete**, transferred to `usini/bete`, and redeployed under
  the custom domain `bete.usini.eu`. The old repo was archived, then deleted
  by the owner once the new setup was verified working — it no longer exists.
  Deliberate decision: no data backward-compatibility between the two names
  (see above).
- **Full English translation pass (July 2026)**: all code comments,
  console/log messages, and docs were translated from French to English in
  one pass, and an i18n system (`js/i18n.js`) was added so the app's UI itself
  supports French + English with the language auto-detected or chosen in Settings.
