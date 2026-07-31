// Inline YouTube player: an iframe overlaid on the block, following the camera.
// Only one player active at a time (clicking a video block = play).
import { state } from './state.js?v=ms954yha';
import { worldToScreen } from './camera.js?v=ms954yha';
import { youTubeId, ytEmbed } from './yt.js?v=ms954yha';
import { t } from './i18n.js?v=ms954yha';

let activeId = null;   // id of the node currently playing
let wrap = null;       // DOM container (iframe + close button)

export function setActiveVideo(node) {
  const txt = node && (node.ref ? null : node.text);
  const vid = youTubeId(node && node.text);
  if (!vid) return;
  clearActiveVideo();
  activeId = node.id;
  wrap = document.createElement('div');
  wrap.id = 'videoplayer';
  wrap.innerHTML = '<iframe allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen frameborder="0"></iframe>'
    + '<button class="vp-x" title="' + t('video.close') + '">✕</button>';
  wrap.querySelector('iframe').src = ytEmbed(vid);
  wrap.querySelector('.vp-x').addEventListener('click', (e) => { e.stopPropagation(); clearActiveVideo(); });
  wrap.addEventListener('mousedown', (e) => e.stopPropagation());
  wrap.addEventListener('touchstart', (e) => e.stopPropagation());
  document.body.appendChild(wrap);
  positionVideoOverlay();
}

export function clearActiveVideo() {
  if (wrap) { wrap.remove(); wrap = null; }
  activeId = null;
}

export function isVideoActive(id) { return activeId === id; }

// Called every frame: realigns the iframe on the block (or closes it if no longer valid).
export function positionVideoOverlay() {
  if (!activeId || !wrap) return;
  const n = state.nodes.find((x) => x.id === activeId);
  if (!n || n.ref || !youTubeId(n.text)) { clearActiveVideo(); return; }
  const z = state.camera.zoom;
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const p = worldToScreen(rx, ry);
  const w = n.w * z, h = n.h * z;
  if (p.x + w < -20 || p.y + h < -20 || p.x > window.innerWidth + 20 || p.y > window.innerHeight + 20) {
    wrap.style.display = 'none';
  } else {
    wrap.style.display = 'block';
    wrap.style.left = p.x + 'px';
    wrap.style.top = p.y + 'px';
    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';
  }
}
