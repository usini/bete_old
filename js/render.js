// Board rendering: pixel grid, circles, hexagons, rectangles, neon glow, selection.
import { state, effectiveColor, sourceOf, displayLink, DEFAULT_GREEN } from './state.js?v=ms944ifx';
import { parseBoardUrl } from './boards.js?v=ms944ifx';
import { view, worldToScreen } from './camera.js?v=ms944ifx';
import { stretch } from './physics.js?v=ms944ifx';
import { hexCorners, triCorners } from './geom.js?v=ms944ifx';
import { theme, themeId_, getTextScale, nodeStyle, toneColor } from './theme.js?v=ms944ifx';
import { fmtDur } from './voice.js?v=ms944ifx';
import { getCursors, getPresence } from './sync.js?v=ms944ifx';
import { youTubeId, ytThumb } from './yt.js?v=ms944ifx';
import { getImageEl } from './images.js?v=ms944ifx';
import { t, getLang } from './i18n.js?v=ms944ifx';
import { isIcsUrl, calendarWeek } from './ics.js?v=ms944ifx';

const FONT = () => theme().font;
const GLOW = () => theme().glow;

// <img> element for a render source. Delegates to images.js which handles
// legacy data URLs, http URLs (YouTube thumbnails) and 'idb:<hash>' refs (IndexedDB + peers).
function getImg(src) { return getImageEl(src); }

// Desktop wallpaper (e.g. winxp theme): fixed in screen space, covers the viewport.
const wallpaperCache = {};
function getWallpaper(src) {
  let img = wallpaperCache[src];
  if (!img) { img = new Image(); img.src = src; wallpaperCache[src] = img; }
  return img;
}

export function render(ctx) {
  const { zoom } = state.camera;
  const wp = theme().wallpaper ? getWallpaper(theme().wallpaper) : null;
  if (wp && wp.complete && wp.naturalWidth) {
    const sc = Math.max(view.w / wp.naturalWidth, view.h / wp.naturalHeight);
    const dw = wp.naturalWidth * sc, dh = wp.naturalHeight * sc;
    ctx.drawImage(wp, (view.w - dw) / 2, (view.h - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = theme().bg;
    ctx.fillRect(0, 0, view.w, view.h);
  }

  drawGrid(ctx);

  // Zones (below the rectangles): circles then hexagons.
  for (const c of state.circles) drawCircle(ctx, c, isSel(c.id));
  for (const h of state.hexagons) drawHexagon(ctx, h, isSel(h.id));

  // Rectangles, signs & liaison blocks (on top).
  for (const n of state.nodes) {
    if (n.kind === 'liaison') drawLiaison(ctx, n, isSel(n.id), zoom);
    else if (n.kind === 'pancarte') drawPancarte(ctx, n, isSel(n.id), zoom);
    else if (n.kind === 'voice') drawVoice(ctx, n, isSel(n.id), zoom);
    else if (n.kind === 'connector') drawConnector(ctx, n, isSel(n.id), zoom);
    else drawRect(ctx, n, effectiveColor(n), isSel(n.id), zoom);
  }

  drawCursors(ctx); // other users' cursors (above everything)
}

// Stable color derived from the user id.
function uidColor(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) % 360;
  return `hsl(${h}, 80%, 55%)`;
}

const cursorRender = {}; // uid -> { rx, ry } smoothed position (A->B animation)

function drawCursors(ctx) {
  const list = getCursors();
  const speaking = {};
  getPresence().forEach((u) => { if (u.voice) speaking[u.uid] = 1; });
  const seen = {};
  for (const c of list) {
    seen[c.uid] = 1;
    // Smoothing: the rendered position eases towards the last received position.
    let cr = cursorRender[c.uid];
    if (!cr) cr = cursorRender[c.uid] = { rx: c.x, ry: c.y };
    cr.rx += (c.x - cr.rx) * 0.25;
    cr.ry += (c.y - cr.ry) * 0.25;
    if (Math.abs(c.x - cr.rx) < 0.5) cr.rx = c.x;
    if (Math.abs(c.y - cr.ry) < 0.5) cr.ry = c.y;
    const p = worldToScreen(cr.rx, cr.ry);
    if (p.x < -40 || p.y < -40 || p.x > view.w + 40 || p.y > view.h + 40) continue;
    const col = uidColor(c.uid);
    // Cursor arrow.
    ctx.save();
    ctx.fillStyle = col;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y + 17);
    ctx.lineTo(p.x + 4.5, p.y + 13);
    ctx.lineTo(p.x + 11, p.y + 13);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Name label (prefixed with 🎤 if the person is talking).
    const name = (speaking[c.uid] ? '🎤 ' : '') + (c.name || t('liaison.guest'));
    ctx.font = '11px ' + (theme().pixel ? "'Press Start 2P', monospace" : "'Segoe UI', sans-serif");
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(name).width;
    const lx = p.x + 12, ly = p.y + 16;
    ctx.fillStyle = col;
    ctx.fillRect(lx, ly, tw + 10, 18);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 2;
    ctx.fillText(name, lx + 5, ly + 4);
    ctx.restore();
  }
  for (const uid in cursorRender) if (!seen[uid]) delete cursorRender[uid]; // purge those who left
}

// Selection: current id OR membership in the multi-selection.
function isSel(id) {
  return id === state.selected || (state.selectedIds && state.selectedIds.indexOf(id) !== -1);
}

// Sign: a larger rectangle with a wood texture and engraved text.
function drawPancarte(ctx, n, selected, zoom) {
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const p = worldToScreen(rx + n.w / 2, ry + n.h / 2);
  const w = n.w * zoom, h = n.h * zoom;
  const st = stretch(n);

  ctx.save();
  ctx.translate(p.x, p.y);
  if (st.sx !== 1 || st.sy !== 1) {
    ctx.rotate(st.angle);
    ctx.scale(st.sx, st.sy);
    ctx.rotate(-st.angle);
  }

  // Classic themes: sign = yellow post-it (instead of wood).
  if (!theme().pixel) {
    drawPostit(ctx, n, selected, zoom, w, h);
    ctx.restore();
    return;
  }

  // Wood planks (clipped to the rectangle).
  ctx.shadowColor = '#000';
  ctx.shadowBlur = selected ? 20 : 8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.clip();
  const shades = ['#6b4a2b', '#5c3f24', '#74522f'];
  const planks = 3;
  const ph = h / planks;
  for (let i = 0; i < planks; i++) {
    const top = -h / 2 + i * ph;
    ctx.fillStyle = shades[i % shades.length];
    ctx.fillRect(-w / 2, top, w, ph);
    ctx.fillStyle = '#3d2917'; // plank seam
    ctx.fillRect(-w / 2, top, w, Math.max(1, 2 * zoom));
    ctx.strokeStyle = 'rgba(40,25,12,0.4)'; // wood grain
    ctx.lineWidth = Math.max(1, zoom);
    for (let g = 0; g < 2; g++) {
      const gy = top + ph * (0.35 + g * 0.35);
      ctx.beginPath();
      ctx.moveTo(-w / 2, gy);
      ctx.lineTo(w / 2, gy + (g ? -3 : 3) * zoom);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Frame + nails + selection outline.
  ctx.shadowBlur = 0;
  ctx.lineWidth = selected ? 5 : 3;
  ctx.strokeStyle = '#3d2917';
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  if (selected) {
    ctx.strokeStyle = theme().accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);
  }
  ctx.fillStyle = '#2a1a0e';
  const nail = Math.max(2, 3 * zoom), off = 9 * zoom;
  [[-w / 2 + off, -h / 2 + off], [w / 2 - off, -h / 2 + off], [-w / 2 + off, h / 2 - off], [w / 2 - off, h / 2 - off]]
    .forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, nail, 0, Math.PI * 2); ctx.fill(); });

  // Engraved text (light with a dark shadow).
  if (n.text) {
    const baseFs = 13 * zoom * getTextScale();
    ctx.fillStyle = '#f3e3c0';
    ctx.shadowColor = '#2a1a0e';
    ctx.shadowOffsetX = 1.5 * zoom;
    ctx.shadowOffsetY = 1.5 * zoom;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawFitted(ctx, n.text, w - 22 * zoom, h - 22 * zoom, baseFs);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.restore();
}

// Post-it style sign (classic themes): yellow background, folded corner, dark text.
function drawPostit(ctx, n, selected, zoom, w, h) {
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = selected ? 16 : 8;
  ctx.shadowOffsetX = 2 * zoom; ctx.shadowOffsetY = 3 * zoom;
  ctx.fillStyle = '#ffe066'; // post-it yellow
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

  // Slightly darker top band (stuck-on effect).
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(-w / 2, -h / 2, w, Math.max(4, h * 0.16));
  // Folded bottom-right corner.
  const fold = Math.min(w, h) * 0.18;
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.moveTo(w / 2 - fold, h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(w / 2, h / 2 - fold);
  ctx.closePath(); ctx.fill();

  if (selected) {
    ctx.strokeStyle = theme().accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);
  }

  if (n.text) {
    const baseFs = 13 * zoom * getTextScale();
    ctx.fillStyle = '#3a2f00'; // dark ink
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawFitted(ctx, n.text, w - 22 * zoom, h - 22 * zoom, baseFs);
  }
}

// P2P liaison block: QR code + status. Click = copies the link.
function ensureQR(n) {
  if (!n.url || !window.qrcode || n._qrUrl === n.url) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(n.url);
    qr.make();
    const cnt = qr.getModuleCount();
    const mods = [];
    for (let r = 0; r < cnt; r++) {
      const row = [];
      for (let c = 0; c < cnt; c++) row.push(qr.isDark(r, c));
      mods.push(row);
    }
    n._qrMods = mods;
    n._qrUrl = n.url;
  } catch (e) { /* lib not ready yet */ }
}

function drawLiaison(ctx, n, selected, zoom) {
  const accent = theme().accent;
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const p = worldToScreen(rx + n.w / 2, ry + n.h / 2);
  const w = n.w * zoom, h = n.h * zoom;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.shadowColor = accent;
  ctx.shadowBlur = (selected ? 22 : 12) * GLOW();
  ctx.fillStyle = theme().nodeBg;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = selected ? 5 : 3;
  ctx.strokeStyle = accent;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.shadowBlur = 0;

  ensureQR(n);
  const pad = w * 0.1;
  const qrSide = w - pad * 2;
  const qrX = -qrSide / 2, qrY = -h / 2 + pad;

  if (n._qrMods) {
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(qrX - 3, qrY - 3, qrSide + 6, qrSide + 6);
    const cnt = n._qrMods.length;
    const ms = qrSide / cnt;
    ctx.fillStyle = '#0d0f12';
    for (let r = 0; r < cnt; r++) {
      for (let c = 0; c < cnt; c++) {
        if (n._qrMods[r][c]) {
          ctx.fillRect(Math.floor(qrX + c * ms), Math.floor(qrY + r * ms), Math.ceil(ms), Math.ceil(ms));
        }
      }
    }
  } else {
    ctx.fillStyle = '#1a1f26';
    ctx.fillRect(qrX, qrY, qrSide, qrSide);
    ctx.fillStyle = accent;
    ctx.font = `${clamp(10 * zoom, 7, 16)}px ${FONT()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('...', 0, qrY + qrSide / 2);
  }

  const now = performance.now();
  let label;
  if (n._copiedUntil && now < n._copiedUntil) label = t('liaisonBlock.copied');
  else if (n.status === 'connected') label = t('liaisonBlock.connected');
  else if (n.status === 'online') label = t('liaisonBlock.online');
  else if (n.status === 'error') label = t('liaisonBlock.error');
  else label = t('liaisonBlock.connecting');

  const fs = clamp(8 * zoom, 6, 13);
  ctx.fillStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6 * GLOW();
  ctx.font = `${fs}px ${FONT()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, (qrY + qrSide + h / 2) / 2);
  ctx.restore();
}

// Voice memo block: play/pause button + duration + progress bar.
function drawVoice(ctx, n, selected, zoom) {
  const color = effectiveColor(n);
  const stl = nodeStyle(color);
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const p = worldToScreen(rx + n.w / 2, ry + n.h / 2);
  const w = n.w * zoom, h = n.h * zoom;
  const st = stretch(n);

  ctx.save();
  ctx.translate(p.x, p.y);
  if (st.sx !== 1 || st.sy !== 1) { ctx.rotate(st.angle); ctx.scale(st.sx, st.sy); ctx.rotate(-st.angle); }

  ctx.shadowColor = color;
  ctx.shadowBlur = (selected ? 22 : 10) * GLOW();
  ctx.fillStyle = stl.fill;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = selected ? 5 : 3;
  ctx.strokeStyle = stl.border;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.shadowBlur = 0;

  // Play / pause button (circle on the left).
  const r = Math.min(w, h) * 0.28;
  const bx = -w / 2 + r + 10 * zoom, by = 0;
  ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fillStyle = stl.text; ctx.fill();
  ctx.fillStyle = stl.fill;
  if (n._playing) { // two bars = pause
    const bw = r * 0.26, bh = r * 0.9;
    ctx.fillRect(bx - bw * 1.4, by - bh / 2, bw, bh);
    ctx.fillRect(bx + bw * 0.4, by - bh / 2, bw, bh);
  } else { // triangle = play
    ctx.beginPath();
    ctx.moveTo(bx - r * 0.35, by - r * 0.5);
    ctx.lineTo(bx + r * 0.55, by);
    ctx.lineTo(bx - r * 0.35, by + r * 0.5);
    ctx.closePath(); ctx.fill();
  }

  // Text (duration or warning) + progress bar.
  const tx = bx + r + 10 * zoom;
  const fs = clamp(11 * zoom * getTextScale(), 7, 22);
  ctx.font = `${fs}px ${FONT()}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = stl.text;
  ctx.shadowColor = color; ctx.shadowBlur = 4 * GLOW();
  ctx.fillText(n._loading ? t('voiceBlock.loading') : (n._missing ? t('voiceBlock.missing') : ('♪ ' + fmtDur(n.dur || 0))), tx, -h * 0.16);
  ctx.shadowBlur = 0;

  const barX = tx, barW = w / 2 - 10 * zoom - barX, barY = h * 0.18, barH = Math.max(3, 5 * zoom);
  if (barW > 4) {
    ctx.fillStyle = hexToRgba(stl.text, 0.25);
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = stl.text;
    ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, n._prog || 0)), barH);
  }
  ctx.restore();
}

// IoT/HTTP connector block: 'triangle' (generic, status dot + last value) or
// 'switch' (on/off toggle, see js/connector.js for the actual networking).
const CONNECTOR_STATUS_COLOR = { idle: '#8a8a8a', loading: '#ffd400', ok: '#39ff14', error: '#fe4365' };

// Click feedback: a short 0->1->0 pulse over ~220ms, set as n._pressT by
// input.js on the toggling click (never serialized/synced, transient only).
function pressAnim(n) {
  if (!n._pressT) return 0;
  const t = (performance.now() - n._pressT) / 220;
  if (t >= 1) { delete n._pressT; return 0; }
  return Math.sin(t * Math.PI);
}

// Darkens a hex color towards black by `amt` (0..1) -- used to derive an
// "off" shade from a chosen button color without a second stored value.
function darkenHex(hex, amt) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  const f = 1 - amt;
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}
// Pixel theme: a household wall light switch (beveled plastic plate, screws,
// a rocker paddle that flips up when on, glowing the chosen button color --
// or green by default, see BUTTON_COLORS/effectiveColor).
function drawSwitchPixel(ctx, w, h, on, selected, zoom, press, color) {
  ctx.fillStyle = '#3a3f47';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  const bevel = Math.max(2, 3 * zoom);
  ctx.fillStyle = '#5a616b';
  ctx.fillRect(-w / 2, -h / 2, w, bevel);
  ctx.fillRect(-w / 2, -h / 2, bevel, h);
  ctx.fillStyle = '#1c2024';
  ctx.fillRect(-w / 2, h / 2 - bevel, w, bevel);
  ctx.fillRect(w / 2 - bevel, -h / 2, bevel, h);
  if (selected) { ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 2; ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6); }

  ctx.fillStyle = '#20242a';
  const screwR = Math.max(1.5, 2 * zoom);
  ctx.beginPath(); ctx.arc(0, -h / 2 + 10 * zoom, screwR, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0, h / 2 - 10 * zoom, screwR, 0, Math.PI * 2); ctx.fill();

  const slotW = w * 0.32, slotH = h * 0.62;
  ctx.fillStyle = '#15171a';
  ctx.fillRect(-slotW / 2, -slotH / 2, slotW, slotH);

  const paddleH = slotH * 0.48;
  const paddleY = (on ? -slotH / 2 : slotH / 2 - paddleH) + paddleH / 2;
  ctx.save();
  ctx.translate(0, paddleY);
  ctx.scale(1, 1 - press * 0.18); // squash on click
  ctx.shadowColor = on ? color : 'transparent';
  ctx.shadowBlur = on ? 12 * zoom : 0;
  ctx.fillStyle = on ? color : '#6b7178';
  ctx.fillRect(-slotW / 2 + 2 * zoom, -paddleH / 2, slotW - 4 * zoom, paddleH);
  ctx.restore();
}

// Classic themes (light + dark): a flat vector pill toggle, tinted with the
// chosen button color (darkened for "off"); default (no color chosen, no
// containing circle) keeps the original dark-green/gray look.
function drawSwitchVector(ctx, w, h, on, selected, zoom, press, color) {
  const custom = color !== DEFAULT_GREEN;
  const onFill = custom ? color : '#1f6b28';
  const offFill = custom ? darkenHex(color, 0.6) : '#3a3e46';
  const trackW = w * 0.7, trackH = h * 0.34, r = trackH / 2;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-trackW / 2, -trackH / 2, trackW, trackH, r);
  else ctx.rect(-trackW / 2, -trackH / 2, trackW, trackH); // older engines: square fallback
  ctx.fillStyle = on ? onFill : offFill;
  ctx.fill();
  if (selected) { ctx.strokeStyle = on ? '#39ff14' : '#8a8f99'; ctx.lineWidth = 2; ctx.stroke(); }

  const knobR = trackH * 0.42 * (1 + press * 0.18);
  const travel = trackW / 2 - r;
  const knobX = on ? travel : -travel;
  ctx.beginPath();
  ctx.arc(knobX, 0, knobR, 0, Math.PI * 2);
  ctx.fillStyle = '#f2f2f2';
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4 * zoom;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();

  // The on/off word sits BELOW the pill, on the page background -- not on
  // the colored fill itself -- so it always uses the theme's own ink color
  // (already contrast-safe against that background) regardless of the
  // chosen button color.
  const fs = clamp(10 * zoom * getTextScale(), 7, 16);
  ctx.font = `${fs}px ${FONT()}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = theme().ink;
  ctx.fillText(on ? t('connector.on') : t('connector.off'), 0, trackH / 2 + fs);
}

// Windows XP theme: a beveled silver button with a small power-style LED,
// pressing down (gradient inverts, shifts 2px) like a classic XP button.
// The plate itself stays silver (text is always black-on-white -- no
// contrast issue), only the LED picks up the chosen button color.
function drawSwitchWinXP(ctx, w, h, on, selected, zoom, press, color) {
  ctx.save();
  ctx.translate(0, press * 2 * zoom);
  const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  if (press > 0.3) { grad.addColorStop(0, '#c8c8c8'); grad.addColorStop(1, '#f0f0f0'); }
  else { grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#ece9d8'); }
  ctx.fillStyle = grad;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = '#0a246a';
  ctx.lineWidth = selected ? 3 : 1.5;
  ctx.strokeRect(-w / 2, -h / 2, w, h);

  const ledR = Math.max(4, 6 * zoom);
  ctx.beginPath();
  ctx.arc(0, -h * 0.18, ledR, 0, Math.PI * 2);
  ctx.fillStyle = on ? color : '#661111';
  ctx.shadowColor = on ? color : 'transparent';
  ctx.shadowBlur = on ? 8 * zoom : 0;
  ctx.fill();
  ctx.shadowBlur = 0;

  const fs = clamp(11 * zoom * getTextScale(), 7, 18);
  ctx.font = `bold ${fs}px Tahoma, sans-serif`;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(on ? t('connector.on') : t('connector.off'), 0, h * 0.22);
  ctx.restore();
}

function drawConnector(ctx, n, selected, zoom) {
  const color = effectiveColor(n);
  const stl = nodeStyle(color);
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const p = worldToScreen(rx + n.w / 2, ry + n.h / 2);
  const w = n.w * zoom, h = n.h * zoom;
  const st = stretch(n);
  const statusColor = CONNECTOR_STATUS_COLOR[n._status] || CONNECTOR_STATUS_COLOR.idle;

  ctx.save();
  ctx.translate(p.x, p.y);
  if (st.sx !== 1 || st.sy !== 1) { ctx.rotate(st.angle); ctx.scale(st.sx, st.sy); ctx.rotate(-st.angle); }

  if (n.display === 'switch') {
    const on = !!n._value;
    const press = pressAnim(n);
    if (theme().pixel) drawSwitchPixel(ctx, w, h, on, selected, zoom, press, color);
    else if (themeId_() === 'winxp') drawSwitchWinXP(ctx, w, h, on, selected, zoom, press, color);
    else drawSwitchVector(ctx, w, h, on, selected, zoom, press, color);
  } else if (n.display === 'readout') {
    drawConnectorReadout(ctx, n, color, stl, selected, zoom, w, h);
  } else if (n.display === 'clock') {
    drawConnectorClock(ctx, color, stl, selected, zoom, w, h, n);
  } else {
    // Generic triangle: outline + a small status dot (top corner) + last value as text.
    const pts = triCorners(0, 0, w, h);
    ctx.beginPath();
    pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.12);
    ctx.fill();
    ctx.shadowColor = color;
    ctx.shadowBlur = (selected ? 22 : 10) * GLOW();
    ctx.lineWidth = selected ? 5 : 3;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(0, -h / 2 + 10 * zoom, Math.max(3, 4 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = statusColor;
    ctx.fill();

    if (n._value !== null && n._value !== undefined) {
      const fs = clamp(12 * zoom * getTextScale(), 7, 22);
      ctx.font = `${fs}px ${FONT()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = stl.text;
      ctx.shadowColor = color; ctx.shadowBlur = 3 * GLOW();
      ctx.fillText(String(n._value), 0, h * 0.12);
      ctx.shadowBlur = 0;
    }
  }
  if (n.bridge) drawBridgeBadge(ctx, w, h, zoom);
  ctx.restore();
}

// Plain rectangle readout: last fetched value as fitted text, with a green
// border that fades in/out (ripple) while a request is in flight, and a
// small corner dot when poll_interval keeps it auto-refreshing in the
// background (see connector.js: node._polling, never synced -- it just
// reflects whether pollConnector() actually started a timer for this device).
function drawConnectorReadout(ctx, n, color, stl, selected, zoom, w, h) {
  ctx.fillStyle = stl.fill;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  const loading = n._status === 'loading';
  let borderColor = color, blur = (selected ? 22 : 10) * GLOW(), lineW = selected ? 5 : 3;
  if (loading) {
    const pulse = (Math.sin(performance.now() / 260) + 1) / 2; // 0..1 fade in/out
    borderColor = '#39ff14';
    blur = (10 + pulse * 20) * GLOW();
    lineW = (selected ? 5 : 3) + pulse * 2;
  }
  ctx.shadowColor = borderColor;
  ctx.shadowBlur = blur;
  ctx.lineWidth = lineW;
  ctx.strokeStyle = borderColor;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.shadowBlur = 0;

  if (n._value !== null && n._value !== undefined) {
    const fs = clamp(13 * zoom * getTextScale(), 7, 24);
    ctx.shadowColor = color; ctx.shadowBlur = 4 * GLOW();
    ctx.fillStyle = stl.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawFitted(ctx, String(n._value), w - 16 * zoom, h - 14 * zoom, fs);
    ctx.shadowBlur = 0;
  }

  if (n._polling) {
    ctx.beginPath();
    ctx.arc(w / 2 - 9 * zoom, h / 2 - 9 * zoom, Math.max(2.5, 3.5 * zoom), 0, Math.PI * 2);
    ctx.fillStyle = '#00b7eb';
    ctx.shadowColor = '#00b7eb';
    ctx.shadowBlur = 4 * GLOW();
    ctx.fill();
    ctx.shadowBlur = 0;
    // Countdown to the next poll, left of the dot (the loop redraws every frame).
    if (n._nextPollAt) {
      const remaining = Math.max(0, Math.ceil((n._nextPollAt - Date.now()) / 1000));
      const fs = clamp(9 * zoom * getTextScale(), 6, 14);
      ctx.font = `${fs}px ${FONT()}`;
      ctx.fillStyle = '#00b7eb';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(remaining + 's', w / 2 - 16 * zoom, h / 2 - 4 * zoom);
    }
  }
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ms -> digit-pair groups for a flip-tile / segment display. Past 99 hours a
// leading (unpadded) day count is prepended -- a countdown/stopwatch running
// for multiple days still fits on one line instead of overflowing HH.
function msToGroups(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  let hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  if (hh > 99) {
    const dd = Math.floor(hh / 24);
    hh %= 24;
    return [String(dd), String(hh).padStart(2, '0'), String(mm).padStart(2, '0'), String(ss).padStart(2, '0')];
  }
  return [String(hh).padStart(2, '0'), String(mm).padStart(2, '0'), String(ss).padStart(2, '0')];
}

// What a clock connector should currently show, independent of theme:
// either digit groups (HH:MM(:SS), stopwatch/countdown -- all "time-shaped",
// tile/segment friendly) or a plain text line (day name / full date). `sub`
// is an optional smaller secondary line (a date pill, or a paused/reached
// hint for stopwatch/countdown).
function clockContent(node, fmt) {
  const now = new Date();
  const lang = getLang() === 'fr' ? 'fr-FR' : 'en-US';
  if (fmt === 'DAY') return { text: capitalize(now.toLocaleDateString(lang, { weekday: 'long' })) };
  if (fmt === 'FULLDATE') return { text: capitalize(now.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) };
  if (fmt === 'STOPWATCH') {
    const ms = (node.stopwatchStart ? now.getTime() - node.stopwatchStart : 0) + (node.stopwatchElapsed || 0);
    return { groups: msToGroups(ms), sub: node.stopwatchStart ? '' : t('clock.paused') };
  }
  if (fmt === 'COUNTDOWN') {
    if (!node.countdownTarget) return { text: t('clock.noTarget') };
    const remain = node.countdownTarget - now.getTime();
    if (remain <= 0) return { groups: ['00', '00', '00'], sub: t('clock.reached') };
    return { groups: msToGroups(remain), sub: '' };
  }
  const showSec = fmt !== 'HH:MM';
  const groups = [String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0')];
  if (showSec) groups.push(String(now.getSeconds()).padStart(2, '0'));
  return { groups, sub: fmt === 'HH:MM:SS+DATE' ? now.toLocaleDateString(lang) : '' };
}

// Local clock readout -- no network at all, just the current time (or
// stopwatch/countdown state) per the chosen clockFormat (picked via
// input.js: openClockFormatPicker), rendered completely differently
// depending on the active theme (see below). One clock, four completely
// different personalities depending on the active theme -- a plain
// "HH:MM:SS in a box" felt like an afterthought, so each variant leans into
// what that theme is already doing elsewhere (LCD glow for pixel, a real
// analog face for the two classic themes, a skeuomorphic desk clock for
// winxp) rather than just recoloring the same shape.
function drawConnectorClock(ctx, color, stl, selected, zoom, w, h, node) {
  const info = clockContent(node, node.clockFormat || 'HH:MM:SS');
  if (theme().pixel) drawClockPixel(ctx, color, selected, zoom, w, h, info);
  else if (themeId_() === 'winxp') drawClockWinXP(ctx, color, selected, zoom, w, h, info);
  else drawClockFlip(ctx, color, stl, selected, zoom, w, h, info, themeId_() === 'classic');
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// One flip-card tile per digit group (HH / MM / SS), split by a thin hinge
// line -- the classic split-flap travel-clock look, distinct from the pixel
// LCD panel even though both are "digital".
function drawFlipTile(ctx, cx, w, h, text, face, ink, hinge, glowColor, glow) {
  const r = Math.min(w, h) * 0.16;
  roundRectPath(ctx, cx - w / 2, -h / 2, w, h, r);
  ctx.fillStyle = face;
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.beginPath();
  ctx.moveTo(cx - w / 2 + r * 0.4, 0);
  ctx.lineTo(cx + w / 2 - r * 0.4, 0);
  ctx.strokeStyle = hinge;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = `700 ${h * 0.56}px ${FONT()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  if (glow) { ctx.shadowColor = glowColor; ctx.shadowBlur = glow; }
  ctx.fillText(text, cx, h * 0.03);
  ctx.shadowBlur = 0;
}

// Classic / classic-dark: a row of flip-clock tiles (one per HH/MM/SS group)
// with blinking colon dots between them, plus a small date pill underneath
// if the format asks for a date. `light` picks the classic (white tiles) vs
// classic-dark (node-bg tiles) palette.
function drawClockFlip(ctx, color, stl, selected, zoom, w, h, info, light) {
  const face = light ? '#ffffff' : stl.fill;
  const ink = light ? '#23262b' : stl.text;
  const hinge = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';

  ctx.shadowColor = color;
  ctx.shadowBlur = (selected ? 18 : 0) * (light ? 0.4 : 1);
  ctx.lineWidth = selected ? 4 : 2;
  ctx.strokeStyle = color;
  roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.08);
  if (selected) ctx.stroke();
  ctx.shadowBlur = 0;

  // Word-shaped content (day name / full date / "no target set"): no tiles,
  // just fitted text on the same card background the tiles would otherwise
  // provide -- `ink` is only legible against `face`, not the bare canvas.
  if (info.text) {
    roundRectPath(ctx, -w * 0.42, -h * 0.34, w * 0.84, h * 0.62, Math.min(w, h) * 0.1);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.font = `700 ${clamp(h * 0.2, 8, 26)}px ${FONT()}`;
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!light) { ctx.shadowColor = color; ctx.shadowBlur = 5 * GLOW(); }
    drawFitted(ctx, info.text, w * 0.76, h * 0.5, clamp(h * 0.2, 8, 26));
    ctx.shadowBlur = 0;
    return;
  }

  const groups = info.groups;
  const withSub = !!info.sub;
  const availW = w * 0.86, tileH = h * (withSub ? 0.52 : 0.62);
  const gap = availW * 0.06;
  const tileW = (availW - gap * (groups.length - 1)) / groups.length;
  const totalW = tileW * groups.length + gap * (groups.length - 1);
  let x = -totalW / 2 + tileW / 2;
  const yOff = withSub ? -h * 0.08 : 0;
  const now = Date.now();

  ctx.save();
  ctx.translate(0, yOff);
  groups.forEach((g, i) => {
    drawFlipTile(ctx, x, tileW, tileH, g, face, ink, hinge, color, light ? 0 : 5 * GLOW());
    x += tileW + gap;
    if (i < groups.length - 1) {
      const blink = Math.floor(now / 500) % 2 === 0;
      if (blink) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x - gap / 2, -tileH * 0.14, Math.max(1.5, tileH * 0.045), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x - gap / 2, tileH * 0.14, Math.max(1.5, tileH * 0.045), 0, Math.PI * 2); ctx.fill();
      }
    }
  });
  ctx.restore();

  if (withSub) {
    ctx.font = `${clamp(h * 0.11, 7, 15)}px ${FONT()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.75;
    ctx.fillText(info.sub, 0, h * 0.36);
    ctx.globalAlpha = 1;
  }
}

// Pixel theme: a bedside digital alarm clock -- dark bezel, recessed LCD
// panel, glowing segment-style digits with a blinking colon, tiny power LED.
function drawClockPixel(ctx, color, selected, zoom, w, h, info) {
  ctx.fillStyle = '#1c2024';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  const bevel = Math.max(2, 3 * zoom);
  ctx.fillStyle = '#3a3f47';
  ctx.fillRect(-w / 2, -h / 2, w, bevel);
  ctx.fillRect(-w / 2, -h / 2, bevel, h);
  ctx.fillStyle = '#0d0f10';
  ctx.fillRect(-w / 2, h / 2 - bevel, w, bevel);
  ctx.fillRect(w / 2 - bevel, -h / 2, bevel, h);
  if (selected) { ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 2; ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6); }

  const padX = w * 0.1, padY = h * 0.16;
  const sx = -w / 2 + padX, sy = -h / 2 + padY, sw = w - 2 * padX, sh = h - 2 * padY;
  ctx.fillStyle = '#061a0e';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.strokeRect(sx, sy, sw, sh);

  let mainStr, subStr;
  if (info.text) { mainStr = info.text; subStr = ''; }
  else {
    const blink = Math.floor(Date.now() / 500) % 2 === 0;
    mainStr = info.groups.join(blink ? ':' : ' ');
    subStr = info.sub || '';
  }
  const fs = clamp(sw / (mainStr.length * 0.6), 7, 60);
  ctx.font = `bold ${fs}px 'Courier New', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#39ff14';
  ctx.shadowColor = '#39ff14';
  ctx.shadowBlur = 8 * GLOW();
  ctx.fillText(mainStr, 0, subStr ? -sh * 0.14 : 0);
  ctx.shadowBlur = 0;

  if (subStr) {
    ctx.font = `${clamp(fs * 0.32, 6, 16)}px 'Courier New', monospace`;
    ctx.fillStyle = '#1f8f4a';
    ctx.fillText(subStr, 0, sh * 0.26);
  }

  ctx.beginPath();
  ctx.arc(w / 2 - 10 * zoom, -h / 2 + 10 * zoom, Math.max(1.5, 2 * zoom), 0, Math.PI * 2);
  ctx.fillStyle = '#39ff14';
  ctx.shadowColor = '#39ff14';
  ctx.shadowBlur = 4 * GLOW();
  ctx.fill();
  ctx.shadowBlur = 0;
}

// Windows XP: the old beveled-plastic frame (same treatment as
// drawSwitchWinXP) around a recessed silver/navy LCD panel -- a digital
// travel clock rather than an analog dial, staying skeuomorphic without
// bringing back hands.
function drawClockWinXP(ctx, color, selected, zoom, w, h, info) {
  ctx.fillStyle = '#ece9d8';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  const bevel = Math.max(2, 2.5 * zoom);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-w / 2, -h / 2, w, bevel);
  ctx.fillRect(-w / 2, -h / 2, bevel, h);
  ctx.fillStyle = '#716f64';
  ctx.fillRect(-w / 2, h / 2 - bevel, w, bevel);
  ctx.fillRect(w / 2 - bevel, -h / 2, bevel, h);
  ctx.lineWidth = selected ? 3 : 1.5;
  ctx.strokeStyle = '#0a246a';
  ctx.strokeRect(-w / 2 + bevel / 2, -h / 2 + bevel / 2, w - bevel, h - bevel);

  const padX = w * 0.14, padY = h * 0.22;
  const sx = -w / 2 + padX, sy = -h / 2 + padY, sw = w - 2 * padX, sh = h - 2 * padY;
  roundRectPath(ctx, sx, sy, sw, sh, Math.min(sw, sh) * 0.1);
  ctx.fillStyle = '#a9c3d6';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#0a246a';
  ctx.stroke();

  let mainStr, subStr;
  if (info.text) { mainStr = info.text; subStr = ''; }
  else {
    const blink = Math.floor(Date.now() / 500) % 2 === 0;
    mainStr = info.groups.join(blink ? ':' : ' ');
    subStr = info.sub || '';
  }
  const fs = clamp(sw / (mainStr.length * 0.62), 6, 40);
  ctx.font = `bold ${fs}px 'Courier New', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0a246a';
  ctx.fillText(mainStr, 0, subStr ? -sh * 0.16 : 0);

  if (subStr) {
    ctx.font = `${clamp(fs * 0.34, 6, 13)}px ${FONT()}`;
    ctx.fillStyle = '#0a246a';
    ctx.fillText(subStr, 0, sh * 0.24);
  }
}

// Small cloud badge (top-right corner): marks a connector whose yaml isn't
// synced anymore -- it's being remote-actuated by other peers through the
// creator's own device instead (see sync.js switchReq/switchRes).
function drawBridgeBadge(ctx, w, h, zoom) {
  const cx = w / 2 - 12 * zoom, cy = -h / 2 + 10 * zoom, r = 6 * zoom;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#00b7eb';
  ctx.shadowColor = '#00b7eb';
  ctx.shadowBlur = 6 * GLOW();
  ctx.beginPath();
  ctx.arc(-r * 0.6, r * 0.15, r * 0.55, 0, Math.PI * 2);
  ctx.arc(r * 0.15, -r * 0.1, r * 0.65, 0, Math.PI * 2);
  ctx.arc(r * 0.7, r * 0.2, r * 0.5, 0, Math.PI * 2);
  ctx.rect(-r * 0.6, r * 0.1, r * 1.3, r * 0.4);
  ctx.fill();
  ctx.restore();
}

function drawHexagon(ctx, hgn, selected) {
  const p = worldToScreen(hgn.x, hgn.y);
  const R = hgn.r * state.camera.zoom;
  const pts = hexCorners(p.x, p.y, R);
  const col = toneColor(hgn.color);

  ctx.save();
  ctx.beginPath();
  pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
  ctx.closePath();
  ctx.fillStyle = hexToRgba(col, 0.08);
  ctx.fill();
  ctx.shadowColor = col;
  ctx.shadowBlur = (selected ? 24 : 12) * GLOW();
  ctx.lineWidth = selected ? 5 : 3;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.restore();

  if (hgn.description) {
    const fs = clamp(16 * state.camera.zoom * getTextScale(), 11, 48);
    ctx.save();
    ctx.font = `${fs}px ${FONT()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 8 * GLOW();
    ctx.fillText(hgn.description, p.x, p.y - R - 4);
    ctx.restore();
  }
}

function drawGrid(ctx) {
  const { x, y, zoom } = state.camera;
  const spacing = 48 * zoom;
  if (spacing < 6) return; // too zoomed out: hide the grid
  const ox = ((-x * zoom + view.w / 2) % spacing + spacing) % spacing;
  const oy = ((-y * zoom + view.h / 2) % spacing + spacing) % spacing;
  ctx.fillStyle = theme().grid;
  const s = Math.max(1, Math.round(zoom)); // big dots = pixelated
  for (let gx = ox; gx < view.w; gx += spacing) {
    for (let gy = oy; gy < view.h; gy += spacing) {
      ctx.fillRect(Math.round(gx), Math.round(gy), s, s);
    }
  }
}

function drawCircle(ctx, c, selected) {
  const p = worldToScreen(c.x, c.y);
  const r = c.r * state.camera.zoom;
  const col = toneColor(c.color);

  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(col, 0.08);
  ctx.fill();

  ctx.shadowColor = col;
  ctx.shadowBlur = (selected ? 24 : 12) * GLOW();
  ctx.lineWidth = selected ? 5 : 3;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.restore();

  // Description above the circle.
  if (c.description) {
    const fs = clamp(16 * state.camera.zoom * getTextScale(), 11, 48);
    ctx.save();
    ctx.font = `${fs}px ${FONT()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 8 * GLOW();
    ctx.fillText(c.description, p.x, p.y - r + fs * 0.2 - 4);
    ctx.restore();
  }
}

function drawRect(ctx, n, color, selected, zoom) {
  // Links: content derived from the source.
  const isLink = !!n.ref;
  const src = isLink ? sourceOf(n) : null;
  const text = isLink ? (src ? src.text : '') : n.text;
  const image = isLink ? (src ? src.image : null) : n.image;
  const ytId = !image ? youTubeId(text) : null; // text = YouTube URL -> video
  // .ics calendar: same "just paste it" convention as YouTube -- checks the
  // text first (pasted directly), then the link field (set via the radial
  // menu's "clickable link").
  const icsUrl = (!image && !ytId) ? (isIcsUrl(text) ? text : (isIcsUrl(displayLink(n)) ? displayLink(n) : null)) : null;
  // A "link to board" rectangle (js/input.js createBoardLink) gets its own
  // look: a red border with current running through it, rather than the
  // plain dashed border shared by every clickable link.
  const boardLink = !isLink && !!parseBoardUrl(displayLink(n));

  // Rendered (physics) position + center.
  const rx = n._rx !== undefined ? n._rx : n.x;
  const ry = n._ry !== undefined ? n._ry : n.y;
  const cx = rx + n.w / 2;
  const cy = ry + n.h / 2;
  const p = worldToScreen(cx, cy);
  const w = n.w * zoom;
  const h = n.h * zoom;

  const st = stretch(n);

  ctx.save();
  ctx.translate(p.x, p.y);
  // Directional squash/stretch.
  if (st.sx !== 1 || st.sy !== 1) {
    ctx.rotate(st.angle);
    ctx.scale(st.sx, st.sy);
    ctx.rotate(-st.angle);
  }

  // Style depending on the theme (pixel = neon; classic = pastel + default black/white square).
  const stl = nodeStyle(color);

  // Optional image (contain), or YouTube thumbnail (cover, fills the block).
  const imgSrc = image || (ytId ? ytThumb(ytId) : null);
  const img = imgSrc ? getImg(imgSrc) : null;
  const hasImage = !!(img && img.complete && img.naturalWidth);

  if (hasImage) {
    // Image block: raw rendering, no colored glow/fill/border.
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();
    const sc = ytId ? Math.max(w / img.naturalWidth, h / img.naturalHeight) // cover (thumbnail)
      : Math.min(w / img.naturalWidth, h / img.naturalHeight);             // contain (image)
    const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else {
    // Body (fallback: no image loaded yet, or text block).
    ctx.shadowColor = color;
    ctx.shadowBlur = (selected ? 22 : 10) * GLOW();
    ctx.fillStyle = stl.fill;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.shadowBlur = 0;

    // Border: dashed for a ref-link, "live wire" red pulse for a board link,
    // plain otherwise.
    ctx.lineWidth = selected ? 5 : 3;
    if (boardLink) {
      const dash = 9 * zoom, gap = 6 * zoom;
      ctx.strokeStyle = '#fe4365';
      ctx.shadowColor = '#fe4365';
      ctx.shadowBlur = (8 + Math.sin(performance.now() / 120) * 5) * Math.max(GLOW(), 0.6);
      ctx.setLineDash([dash, gap]);
      ctx.lineDashOffset = -(performance.now() / 18) % (dash + gap);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.shadowBlur = 0;
    } else {
      ctx.strokeStyle = stl.border;
      if (isLink) ctx.setLineDash([6 * zoom, 4 * zoom]);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.setLineDash([]);
    }
  }

  // Resize handle (bottom-right corner), only when selected alone.
  if (selected && state.selected === n.id && !isLink) {
    const hs = Math.max(7, 9 * zoom);
    ctx.fillStyle = stl.border;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2 - hs);
    ctx.lineTo(w / 2, h / 2);
    ctx.lineTo(w / 2 - hs, h / 2);
    ctx.closePath();
    ctx.fill();
  }

  // "Clickable link" badge (cyan ↗ arrow, top-right).
  if (displayLink(n)) {
    const bs = Math.max(9, 12 * zoom);
    const bx = w / 2 - bs - 4 * zoom, by = -h / 2 + 4 * zoom;
    ctx.fillStyle = '#00b7eb';
    ctx.shadowColor = '#00b7eb';
    ctx.shadowBlur = 6 * GLOW();
    ctx.fillRect(bx, by, bs, bs);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#04130a';
    ctx.lineWidth = Math.max(1, 1.4 * zoom);
    ctx.beginPath();
    ctx.moveTo(bx + bs * 0.28, by + bs * 0.72);
    ctx.lineTo(bx + bs * 0.72, by + bs * 0.28);
    ctx.moveTo(bx + bs * 0.46, by + bs * 0.28);
    ctx.lineTo(bx + bs * 0.72, by + bs * 0.28);
    ctx.lineTo(bx + bs * 0.72, by + bs * 0.54);
    ctx.stroke();
  }

  // Centered ▶ play button for a YouTube video block.
  if (ytId) {
    const r = Math.min(w, h) * 0.22;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff2222';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, -r * 0.42); ctx.lineTo(r * 0.5, 0); ctx.lineTo(-r * 0.3, r * 0.42);
    ctx.closePath(); ctx.fill();
  }

  // ICS calendar block: the body/border above stays, the content is a week grid.
  if (icsUrl) drawIcsWeek(ctx, icsUrl, stl, color, zoom, w, h);

  // Text (shrunk to fit the rectangle, except for an image/video/calendar block).
  if (text && !image && !ytId && !icsUrl) {
    const baseFs = 13 * zoom * getTextScale();
    ctx.shadowBlur = 6 * GLOW();
    ctx.fillStyle = stl.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawFitted(ctx, text, w - 16 * zoom, h - 14 * zoom, baseFs);
  }
  ctx.restore();
}

// Week agenda for a rectangle whose link is a .ics file (see js/ics.js).
// Drawn in the block's centered coordinate space: x in [-w/2, w/2], y in
// [-h/2, h/2]. Layout: one day-heading row per day, immediately followed by
// that day's events stacked one after another -- full block width for every
// line (no per-weekday column), since a specific time-of-day position isn't
// needed (the time is printed as part of the line) and a 7-column grid
// mostly wastes width on days with few or no events.
function drawIcsWeek(ctx, url, stl, color, zoom, w, h) {
  const cal = calendarWeek(url);
  ctx.shadowBlur = 0;
  if (!cal.days) {
    const fs = clamp(Math.min(w, h) * 0.07, 9, 22);
    ctx.font = `${fs}px ${FONT()}`;
    ctx.fillStyle = stl.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cal.status === 'error' ? t('ics.error') : t('ics.loading'), 0, 0);
    return;
  }

  const pad = 5 * zoom;
  const x0 = -w / 2 + pad, x1 = w / 2 - pad;
  const y0 = -h / 2 + pad, y1 = h / 2 - pad;
  const lang = getLang() === 'fr' ? 'fr-FR' : 'en-US';
  const today = new Date();

  // Row height stretches to fill the block's available height -- a light
  // week (few events) in a tall block otherwise left dead space at the
  // bottom instead of using it, and a fixed size (even one scaled off just
  // h) can't tell "7 headers + 2 events" from "7 headers + 30 events" apart.
  // Still capped so a near-empty calendar in a huge block doesn't blow up
  // into giant text.
  const totalEvents = cal.days.reduce((sum, list) => sum + list.length, 0);
  const avail = Math.max(40, y1 - y0);
  const unit = clamp(avail / (7 * 1.15 + totalEvents), 12, 50);
  const dayH = unit * 1.15;
  const evH = unit;
  const fsDay = clamp(dayH * 0.66, 10, 32);
  const fsEv = clamp(evH * 0.62, 9, 28);

  let y = y0;
  for (let d = 0; d < 7; d++) {
    if (y >= y1) break; // out of room: stop drawing further days entirely
    const day = new Date(cal.weekStart.getTime() + d * 86400000);
    const isToday = day.getFullYear() === today.getFullYear() && day.getMonth() === today.getMonth() && day.getDate() === today.getDate();
    const evs = cal.days[d];

    // Day heading: full-width bar, highlighted for today.
    if (isToday) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y, x1 - x0, Math.min(dayH, y1 - y));
      ctx.restore();
    }
    ctx.font = `700 ${fsDay}px ${FONT()}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isToday ? color : stl.text;
    ctx.globalAlpha = isToday ? 1 : 0.8;
    const label = capitalize(day.toLocaleDateString(lang, { weekday: 'short' })) + ' ' + day.getDate();
    ctx.fillText(label, x0 + 2, y + dayH / 2, x1 - x0 - 4);
    ctx.globalAlpha = 1;
    y += dayH + 1;

    for (let i = 0; i < evs.length && y < y1; i++) {
      const ev = evs[i];
      const remaining = evs.length - i;
      const lastRow = y + evH * 2 > y1 && remaining > 1; // no room for this one AND a next -> summarize instead
      if (lastRow) {
        ctx.font = `${fsEv}px ${FONT()}`;
        ctx.fillStyle = stl.text;
        ctx.globalAlpha = 0.7;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('+' + remaining, x0 + 3, y + evH / 2);
        ctx.globalAlpha = 1;
        y += evH;
        break;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y, x1 - x0, evH);
      ctx.clip();
      ctx.globalAlpha = ev.allDay ? 0.45 : 0.22;
      ctx.fillStyle = color;
      ctx.fillRect(x0 + 1, y, (x1 - x0) - 2, evH - 1);
      ctx.globalAlpha = 1;
      ctx.font = `${fsEv}px ${FONT()}`;
      ctx.fillStyle = stl.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tm = ev.allDay ? '' : String(ev.start.getHours()).padStart(2, '0') + ':' + String(ev.start.getMinutes()).padStart(2, '0') + '  ';
      ctx.fillText(tm + (ev.summary || ''), x0 + 4, y + evH / 2);
      ctx.restore();
      y += evH + 1;
    }
    y += 3; // gap before the next day
  }
}

// Minimal inline markdown: **bold**, *italic*/_italic_. Returns text runs.
function parseInline(text) {
  const segs = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index), bold: false, italic: false });
    if (m[1] !== undefined) segs.push({ text: m[1], bold: true, italic: false });
    else segs.push({ text: m[2] !== undefined ? m[2] : m[3], bold: false, italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ text: text.slice(last), bold: false, italic: false });
  return segs.length ? segs : [{ text, bold: false, italic: false }];
}

// Per-line markdown: "# heading" (bold), "- item" / "* item" (bullet), + inline bold/italic.
// Returns one token array per paragraph (blank line -> empty array).
function parseMarkdown(text) {
  return String(text).split('\n').map((raw) => {
    let line = raw;
    let bullet = false;
    const bm = line.match(/^\s*[-*]\s+(.*)$/);
    if (bm) { bullet = true; line = bm[1]; }
    const hm = line.match(/^\s*#{1,6}\s+(.*)$/);
    let heading = false;
    if (hm) { heading = true; line = hm[1]; }
    const tokens = [];
    if (bullet) tokens.push({ word: '•', bold: false, italic: false });
    for (const seg of parseInline(line)) {
      for (const word of seg.text.split(/\s+/).filter(Boolean)) {
        tokens.push({ word, bold: seg.bold || heading, italic: seg.italic });
      }
    }
    return tokens;
  });
}

function tokFont(fs, fam, tok) {
  return (tok.italic ? 'italic ' : '') + (tok.bold ? 'bold ' : '') + fs + 'px ' + fam;
}

// Greedy word-wrap of one paragraph's tokens, keeping bold/italic per word.
function wrapParagraph(ctx, fam, fs, tokens, maxW) {
  if (!tokens.length) return [[]];
  ctx.font = `${fs}px ${fam}`;
  const spaceW = ctx.measureText(' ').width;
  const out = [];
  let cur = [], curW = 0;
  for (const tok of tokens) {
    ctx.font = tokFont(fs, fam, tok);
    const w = ctx.measureText(tok.word).width;
    const addW = cur.length ? spaceW + w : w;
    if (curW + addW > maxW && cur.length) { out.push(cur); cur = [tok]; curW = w; }
    else { cur.push(tok); curW += addW; }
  }
  out.push(cur);
  return out;
}

function lineWidth(ctx, fam, fs, line) {
  ctx.font = `${fs}px ${fam}`;
  const spaceW = ctx.measureText(' ').width;
  let w = 0;
  line.forEach((tok, i) => {
    ctx.font = tokFont(fs, fam, tok);
    w += ctx.measureText(tok.word).width + (i ? spaceW : 0);
  });
  return w;
}

// Centered text (supporting minimal markdown) that shrinks until it fits within (maxW x maxH).
function drawFitted(ctx, text, maxW, maxH, baseFs) {
  const fam = FONT();
  const paragraphs = parseMarkdown(text);
  let fs = Math.max(5, baseFs);
  let lines = [];
  for (let i = 0; i < 16; i++) {
    lines = [];
    for (const p of paragraphs) lines.push(...wrapParagraph(ctx, fam, fs, p, maxW));
    const lineH = fs * 1.4;
    const tall = lines.length * lineH > maxH;
    const wide = lines.some((l) => lineWidth(ctx, fam, fs, l) > maxW);
    if ((!tall && !wide) || fs <= 5) break;
    fs = Math.max(5, fs * 0.86);
  }
  const lineH = fs * 1.4;
  const startY = -((lines.length - 1) * lineH) / 2;
  ctx.font = `${fs}px ${fam}`;
  const spaceW = ctx.measureText(' ').width;
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    let x = align === 'center' ? -lineWidth(ctx, fam, fs, line) / 2 : 0;
    line.forEach((tok) => {
      ctx.font = tokFont(fs, fam, tok);
      ctx.fillText(tok.word, x, y);
      x += ctx.measureText(tok.word).width + spaceW;
    });
  });
  ctx.textAlign = align;
}

// ---- utils ----
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
