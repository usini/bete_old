# Bete

Pixel-art mindmap. 100% static site, zero dependencies, zero build step.

## Run locally

ES modules don't work over `file://`, so you need a small server:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push the repo to GitHub.
2. `Settings → Pages → Build and deployment → Source: Deploy from a branch`.
3. Branch `main`, folder `/ (root)`. The site is served as-is.

For a custom domain: `Settings → Pages → Custom domain`, and a `CNAME` file
(containing your domain) appears at the repo root — replace it or delete it
if you fork the project to host it under a different domain.

## Language

The app is available in French and English. It guesses the language from
the browser on first visit; your choice in Settings → Language is then
remembered and always takes priority. Adding a new language is a small,
self-contained change in `js/i18n.js` (one dictionary object + one list
entry) — see the comments there.

## Usage

- **Right-click**: radial menu (create rectangle/sign/circle/hexagon/liaison, color, text, delete, export/import).
- **Sign**: a larger rectangle with a wood texture, for titles/panels.
- **Deleting** an object makes it **explode into pieces** (animation, synced with clients).
- **Wheel**: zoom · **drag the background**: pan the view.
- **Drag a rectangle**: elastic movement.
- **Drag a circle/hexagon's edge**: resize · **drag its inside**: move it.
- **Double-click**: edit the text (Escape to confirm). On an **image rectangle**: opens the image full-size.
- **Drag-and-drop an image** (or **Ctrl-V** an image from the clipboard): onto a rectangle to put it inside, onto empty space to create an image rectangle ("Remove image" to take it out). The image is always shown **in full**; the rectangle keeps a roughly constant size.
- **Link** (radial menu on a rectangle): attaches a URL; an ↗ badge appears and a **click** opens the link in a new tab.
- **Delete**: erases the selected element.
- **Ctrl-C / Ctrl-V**: copy-paste the selected element (pasted at the mouse position).
- A rectangle whose center is inside a circle/hexagon takes its color.

### Hexagons & links

A **hexagon** (e.g. "Today") aggregates **links** to rectangles stored elsewhere.
Drag a rectangle (from a circle) into a hexagon: a **link** (dashed border) is
created, the original goes back to its place. The link keeps the **source
circle's color** and mirrors its text/image; renaming or deleting the source
updates (or removes) the link. Links can be freely placed inside the hexagon.

### Sync across devices (P2P)

To copy your board from one device to another (e.g. desktop → phone):

1. On the **source** device (HOST): radial menu → **"+ Liaison"**. A QR code block appears.
2. On the other device (CLIENT): **scan the QR** (or open the link — clicking the block copies it).
3. Once connected, the client's board is replaced by the host's, then both stay **synced live, in both directions**, as long as the host's window stays open.

**Synced**: the content (text, image, color, description, links, creations/deletions) and the **objects' positions** — but the latter only **on drop** (not during the drag), and the other screen **animates** it. **The camera stays independent**: each screen keeps its own zoom/framing (e.g. one screen zoomed out, another zoomed into a circle). If the same element is edited simultaneously, **the host wins**.

**Encrypted P2P connection** (WebRTC via PeerJS); only connection identifiers go through the signaling broker, the content travels directly between the two browsers. The PeerJS / QR libs are loaded on demand (CDN), the app stays dependency-free at rest. Images and voice memos are stored locally (IndexedDB) and only transit once per peer, never through the broker.

**Permanent host (optional)**: to keep sync available even with all browsers closed, you can run a small Node server on a Raspberry Pi that acts as a permanent host — see [`server/`](server/README.md). The app doesn't need any modification: devices connect to it via `?peer=<pi-id>`.

The liaison id is **stable** (remembered): refreshing the host's page and recreating the liaison gives back **the same link/QR**. On a network drop, the host automatically reconnects to the broker (same id) and clients retry the connection — no need to rescan. If the link leaks, **"New link"** (liaison block menu) regenerates an id: the old URL becomes invalid, the board is preserved.

Privacy-wise: content travels over encrypted WebRTC (DTLS), directly between peers in the normal case; if a direct connection isn't possible, it's relayed (encrypted) by PeerJS's TURN servers. The broker only ever sees connection identifiers.

### Mobile / touch

- **Interaction locked by default** (so a block isn't accidentally moved): only panning (1 finger) and zooming (pinch) work. **Long-press** then only offers **"Enable"**. Once enabled, the standard radial menu comes back (with **"Lock"** to re-lock it).
- **1 finger**: drags the background (pan) or, once enabled, moves an element.
- **2 fingers**: pinch to zoom.
- **Long-press**: radial menu · **double-tap**: edit / view the image (interaction enabled).

Automatic save in the browser (localStorage). JSON export/import via the radial menu.

## Open a board from a URL

Adding `?file=<url>` to the address loads that JSON instead of localStorage, without overwriting your personal board:

```
https://your-instance.example/?file=https://example.com/board.json
```

The file must be accessible over CORS (same origin, raw.githubusercontent.com, gist…). A relative path also works: `?file=boards/demo.json`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT-licensed, see [LICENSE](LICENSE).

Other URL parameters:

- `?theme=pixel|classic|classic-dark|winxp` forces the theme for that view only
  (your saved choice in Settings is untouched).

A board's own name and a liaison's display name are never carried in the URL:
they arrive automatically as part of the P2P sync itself the first time you
connect (unless you already renamed it locally, which always wins).

## Calendar blocks (.ics)

Give a rectangle a link to a `.ics` file (or `webcal://`, or just paste the
url as the block's text): it renders as a week agenda (Mon-Sun, one line per
event, refreshed every 15 min). Most calendar hosts block direct browser
fetches (CORS); in that case use the desktop app (which fetches natively),
or set Settings > ICS proxy to a relay such as the one the Raspberry Pi host
exposes (see server/README.md). If neither works and you're connected to a
liaison, the board asks other connected peers (e.g. a desktop build, or one
with a working proxy) to fetch it on your behalf. The last successfully
fetched calendar is also cached locally, so it still shows something while
offline or waiting on a peer.
