// Exports the current board as a single standalone HTML file: a frozen
// snapshot (pan/zoom only, no editing, no live network) that opens in any
// browser with no server and no dependency on this app being installed.
// Connector blocks (IoT) are dropped entirely -- they'd otherwise imply a
// live network poll, which contradicts "frozen snapshot".
import { serialize, getBoardName } from './state.js?v=ms7c2a3u';
import { inlineImages } from './images.js?v=ms7c2a3u';
import { theme, getTextScale } from './theme.js?v=ms7c2a3u';
import { saveTextFile } from './platform.js?v=ms7c2a3u';

// Fetches a same-origin asset (e.g. the winxp wallpaper) and inlines it as a
// data URL, so the exported file has zero external file dependencies.
async function assetToDataUrl(path) {
  try {
    const res = await fetch(path);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch (e) { return null; }
}

export async function exportBoardHtml() {
  const snap = serialize();
  snap.nodes = snap.nodes.filter((n) => n.kind !== 'connector'); // frozen snapshot: no live polling
  await inlineImages(snap.nodes);

  const th = theme();
  const themeSnap = {
    bg: th.bg, grid: th.grid, nodeBg: th.nodeBg, ink: th.ink,
    accent: th.accent, font: th.font, pixel: !!th.pixel, glow: th.glow,
  };
  if (th.wallpaper) themeSnap.wallpaper = await assetToDataUrl(th.wallpaper);

  const html = buildViewerHtml(snap, themeSnap, getTextScale(), getBoardName() || 'Bete');
  const filename = 'bete-' + (getBoardName() || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.html';
  await saveTextFile(html, filename, 'html');
}

// The exported page is fully self-contained: no imports, no build, just the
// board data + a trimmed read-only clone of camera.js/render.js's drawing
// logic (pan/zoom only -- no drag, no editing, no menus, no network).
function buildViewerHtml(board, th, textScale, title) {
  const boardJson = JSON.stringify(board).replace(/</g, '\\u003c');
  const themeJson = JSON.stringify(th).replace(/</g, '\\u003c');
  const fontLink = th.pixel
    ? '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>${escapeHtml(title)}</title>
${fontLink}
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${th.bg}; touch-action: none; }
  canvas { position: fixed; inset: 0; display: block; }
  #hint { position: fixed; top: 10px; left: 12px; font: 10px/1.4 monospace; color: ${th.ink}; opacity: 0.6; pointer-events: none; user-select: none; }
</style>
</head>
<body>
<canvas id="board"></canvas>
<div id="hint">${escapeHtml(title)} — scroll/pinch to zoom, drag to pan (read-only export)</div>
<script>
(function () {
  var state = ${boardJson};
  var TH = ${themeJson};
  var textScale = ${JSON.stringify(textScale)};
  var FONT = TH.font;
  var GLOW = TH.glow || 0;

  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var view = { w: 0, h: 0 };
  var cam = (state.camera && { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom }) || { x: 0, y: 0, zoom: 1 };

  function resize() {
    dpr = window.devicePixelRatio || 1;
    view.w = window.innerWidth; view.h = window.innerHeight;
    canvas.width = Math.floor(view.w * dpr); canvas.height = Math.floor(view.h * dpr);
    canvas.style.width = view.w + 'px'; canvas.style.height = view.h + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  function worldToScreen(x, y) { return { x: (x - cam.x) * cam.zoom + view.w / 2, y: (y - cam.y) * cam.zoom + view.h / 2 }; }
  function screenToWorld(x, y) { return { x: (x - view.w / 2) / cam.zoom + cam.x, y: (y - view.h / 2) / cam.zoom + cam.y }; }

  // ---- Pan / zoom (the only interaction this export supports) ----
  var dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', function (e) { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', function () { dragging = false; });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    cam.x -= (e.clientX - lastX) / cam.zoom; cam.y -= (e.clientY - lastY) / cam.zoom;
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var before = screenToWorld(e.clientX, e.clientY);
    var f = Math.exp(-e.deltaY * 0.001);
    cam.zoom = Math.max(0.05, Math.min(8, cam.zoom * f));
    var after = screenToWorld(e.clientX, e.clientY);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
  }, { passive: false });

  var touches = {};
  function touchDist(list) {
    if (list.length < 2) return 0;
    var dx = list[0].clientX - list[1].clientX, dy = list[0].clientY - list[1].clientY;
    return Math.hypot(dx, dy);
  }
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    if (e.touches.length === 1) { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    touches.pinchStart = touchDist(e.touches); touches.zoomStart = cam.zoom;
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (e.touches.length === 1 && dragging) {
      cam.x -= (e.touches[0].clientX - lastX) / cam.zoom; cam.y -= (e.touches[0].clientY - lastY) / cam.zoom;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2 && touches.pinchStart) {
      var d = touchDist(e.touches);
      cam.zoom = Math.max(0.05, Math.min(8, touches.zoomStart * (d / touches.pinchStart)));
    }
  }, { passive: false });
  canvas.addEventListener('touchend', function (e) { if (!e.touches.length) dragging = false; }, { passive: false });

  // ---- Geometry ----
  function hexCorners(cx, cy, r) {
    var pts = [];
    for (var i = 0; i < 6; i++) { var a = (Math.PI / 180) * (60 * i - 90); pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    return pts;
  }
  function pointInPolygon(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function pointInHex(px, py, cx, cy, r) { return pointInPolygon(px, py, hexCorners(cx, cy, r)); }

  var DEFAULT_GREEN = '#39ff14';
  function sourceOf(node) { if (!node.ref) return null; for (var i = 0; i < state.nodes.length; i++) { var n = state.nodes[i]; if (n.id === node.ref && !n.ref) return n; } return null; }
  function effectiveColor(node) {
    if (node.ref) { var s = sourceOf(node); return s ? effectiveColor(s) : DEFAULT_GREEN; }
    var cx = node.x + node.w / 2, cy = node.y + node.h / 2, color = DEFAULT_GREEN;
    for (var i = 0; i < state.circles.length; i++) { var c = state.circles[i]; var dx = cx - c.x, dy = cy - c.y; if (dx * dx + dy * dy <= c.r * c.r) color = c.color; }
    for (var j = 0; j < state.hexagons.length; j++) { var h = state.hexagons[j]; if (pointInHex(cx, cy, h.x, h.y, h.r)) color = h.color; }
    return color;
  }

  // ---- Theme-derived styling (ported from js/theme.js, frozen at export time) ----
  function hx(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function toHex(r, g, b) { function c(v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); } return '#' + c(r) + c(g) + c(b); }
  function mix(a, b, t) { var A = hx(a), B = hx(b); return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
  function lum(hex) { var c = hx(hex); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }
  function isDefaultColor(color) { return !color || color.toLowerCase() === DEFAULT_GREEN.toLowerCase(); }
  function toneColor(color) {
    if (TH.pixel) return color;
    if (lum(color) > 0.72) return mix(color, '#1a1a1a', 0.8);
    return mix(color, '#ffffff', 0.32);
  }
  function nodeStyle(color) {
    if (TH.pixel) return { fill: TH.nodeBg, border: color, text: color };
    var def = isDefaultColor(color);
    if (def) return { fill: '#fafafa', border: '#fafafa', text: '#141414' };
    var p = toneColor(color);
    return { fill: TH.nodeBg, border: p, text: p };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function hexToRgba(hex, a) { var h = hex.replace('#', ''); return 'rgba(' + parseInt(h.substring(0, 2), 16) + ',' + parseInt(h.substring(2, 4), 16) + ',' + parseInt(h.substring(4, 6), 16) + ',' + a + ')'; }

  // ---- Minimal markdown (bold/italic/heading/bullet), text fitting ----
  function parseInline(text) {
    var segs = [], re = /\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) segs.push({ text: text.slice(last, m.index), bold: false, italic: false });
      if (m[1] !== undefined) segs.push({ text: m[1], bold: true, italic: false });
      else segs.push({ text: m[2] !== undefined ? m[2] : m[3], bold: false, italic: true });
      last = re.lastIndex;
    }
    if (last < text.length) segs.push({ text: text.slice(last), bold: false, italic: false });
    return segs.length ? segs : [{ text: text, bold: false, italic: false }];
  }
  function parseMarkdown(text) {
    return String(text).split('\\n').map(function (raw) {
      var line = raw, bullet = false, heading = false;
      var bm = line.match(/^\\s*[-*]\\s+(.*)$/); if (bm) { bullet = true; line = bm[1]; }
      var hm = line.match(/^\\s*#{1,6}\\s+(.*)$/); if (hm) { heading = true; line = hm[1]; }
      var tokens = [];
      if (bullet) tokens.push({ word: '\\u2022', bold: false, italic: false });
      parseInline(line).forEach(function (seg) {
        seg.text.split(/\\s+/).filter(Boolean).forEach(function (word) { tokens.push({ word: word, bold: seg.bold || heading, italic: seg.italic }); });
      });
      return tokens;
    });
  }
  function tokFont(fs, fam, tok) { return (tok.italic ? 'italic ' : '') + (tok.bold ? 'bold ' : '') + fs + 'px ' + fam; }
  function wrapParagraph(fam, fs, tokens, maxW) {
    if (!tokens.length) return [[]];
    ctx.font = fs + 'px ' + fam;
    var spaceW = ctx.measureText(' ').width, out = [], cur = [], curW = 0;
    tokens.forEach(function (tok) {
      ctx.font = tokFont(fs, fam, tok);
      var w = ctx.measureText(tok.word).width, addW = cur.length ? spaceW + w : w;
      if (curW + addW > maxW && cur.length) { out.push(cur); cur = [tok]; curW = w; }
      else { cur.push(tok); curW += addW; }
    });
    out.push(cur);
    return out;
  }
  function lineWidth(fam, fs, line) {
    ctx.font = fs + 'px ' + fam;
    var spaceW = ctx.measureText(' ').width, w = 0;
    line.forEach(function (tok, i) { ctx.font = tokFont(fs, fam, tok); w += ctx.measureText(tok.word).width + (i ? spaceW : 0); });
    return w;
  }
  function drawFitted(text, maxW, maxH, baseFs) {
    var fam = FONT, paragraphs = parseMarkdown(text), fs = Math.max(5, baseFs), lines = [];
    for (var i = 0; i < 16; i++) {
      lines = [];
      paragraphs.forEach(function (p) { lines = lines.concat(wrapParagraph(fam, fs, p, maxW)); });
      var lineH = fs * 1.4;
      var tall = lines.length * lineH > maxH;
      var wide = lines.some(function (l) { return lineWidth(fam, fs, l) > maxW; });
      if ((!tall && !wide) || fs <= 5) break;
      fs = Math.max(5, fs * 0.86);
    }
    var lineH2 = fs * 1.4, startY = -((lines.length - 1) * lineH2) / 2;
    ctx.font = fs + 'px ' + fam;
    var spaceW = ctx.measureText(' ').width, align = ctx.textAlign;
    ctx.textAlign = 'left';
    lines.forEach(function (line, i) {
      var y = startY + i * lineH2, x = align === 'center' ? -lineWidth(fam, fs, line) / 2 : 0;
      line.forEach(function (tok) { ctx.font = tokFont(fs, fam, tok); ctx.fillText(tok.word, x, y); x += ctx.measureText(tok.word).width + spaceW; });
    });
    ctx.textAlign = align;
  }

  // ---- Board-link detection (frozen text pattern: "?id=" query string) ----
  function isBoardLink(link) { return typeof link === 'string' && /[?&]id=/.test(link); }

  // ---- Drawing ----
  var wallpaperImg = null;
  if (TH.wallpaper) { wallpaperImg = new Image(); wallpaperImg.src = TH.wallpaper; }

  function drawGrid() {
    var spacing = 48 * cam.zoom;
    if (spacing < 6) return;
    var ox = ((-cam.x * cam.zoom + view.w / 2) % spacing + spacing) % spacing;
    var oy = ((-cam.y * cam.zoom + view.h / 2) % spacing + spacing) % spacing;
    ctx.fillStyle = TH.grid;
    var s = Math.max(1, Math.round(cam.zoom));
    for (var gx = ox; gx < view.w; gx += spacing) for (var gy = oy; gy < view.h; gy += spacing) ctx.fillRect(Math.round(gx), Math.round(gy), s, s);
  }

  function drawCircle(c) {
    var p = worldToScreen(c.x, c.y), r = c.r * cam.zoom, col = TH.pixel ? c.color : toneColor(c.color);
    ctx.save();
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(col, 0.08); ctx.fill();
    ctx.shadowColor = col; ctx.shadowBlur = 12 * GLOW; ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
    ctx.restore();
    if (c.description) {
      var fs = clamp(16 * cam.zoom * textScale, 11, 48);
      ctx.save(); ctx.font = fs + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 6 * GLOW;
      ctx.fillText(c.description, p.x, p.y - r - 4); ctx.restore();
    }
  }
  function drawHexagon(hgn) {
    var p = worldToScreen(hgn.x, hgn.y), R = hgn.r * cam.zoom, pts = hexCorners(p.x, p.y, R), col = TH.pixel ? hgn.color : toneColor(hgn.color);
    ctx.save();
    ctx.beginPath(); pts.forEach(function (pt, i) { i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y); }); ctx.closePath();
    ctx.fillStyle = hexToRgba(col, 0.08); ctx.fill();
    ctx.shadowColor = col; ctx.shadowBlur = 12 * GLOW; ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
    ctx.restore();
    if (hgn.description) {
      var fs = clamp(16 * cam.zoom * textScale, 11, 48);
      ctx.save(); ctx.font = fs + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 6 * GLOW;
      ctx.fillText(hgn.description, p.x, p.y - R - 4); ctx.restore();
    }
  }

  var imgCache = {};
  function getImg(src) {
    var img = imgCache[src];
    if (!img) { img = new Image(); img.src = src; imgCache[src] = img; }
    return img;
  }

  function drawRect(n) {
    var isLink = !!n.ref, src = isLink ? sourceOf(n) : null;
    var text = isLink ? (src ? src.text : '') : n.text;
    var image = isLink ? (src ? src.image : null) : n.image;
    var link = isLink ? (src ? src.link : undefined) : n.link;
    var boardLink = !isLink && isBoardLink(link);
    var color = effectiveColor(n), stl = nodeStyle(color);
    var p = worldToScreen(n.x + n.w / 2, n.y + n.h / 2), w = n.w * cam.zoom, h = n.h * cam.zoom;

    ctx.save();
    ctx.translate(p.x, p.y);

    var img = image ? getImg(image) : null;
    var hasImage = !!(img && img.complete && img.naturalWidth);
    if (hasImage) {
      ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
      var sc = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      var dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    } else {
      ctx.shadowColor = color; ctx.shadowBlur = 10 * GLOW; ctx.fillStyle = stl.fill; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.shadowBlur = 0;
      ctx.lineWidth = 3;
      if (boardLink) {
        var dash = 9 * cam.zoom, gap = 6 * cam.zoom;
        ctx.strokeStyle = '#fe4365'; ctx.shadowColor = '#fe4365';
        ctx.shadowBlur = (8 + Math.sin(performance.now() / 120) * 5) * Math.max(GLOW, 0.6);
        ctx.setLineDash([dash, gap]); ctx.lineDashOffset = -(performance.now() / 18) % (dash + gap);
        ctx.strokeRect(-w / 2, -h / 2, w, h); ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = stl.border;
        if (isLink) ctx.setLineDash([6 * cam.zoom, 4 * cam.zoom]);
        ctx.strokeRect(-w / 2, -h / 2, w, h); ctx.setLineDash([]);
      }
    }
    if (text && !image) {
      var baseFs = 13 * cam.zoom * textScale;
      ctx.shadowBlur = 6 * GLOW; ctx.fillStyle = stl.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      drawFitted(text, w - 16 * cam.zoom, h - 14 * cam.zoom, baseFs);
    }
    ctx.restore();
  }

  function drawPancarte(n) {
    var p = worldToScreen(n.x + n.w / 2, n.y + n.h / 2), w = n.w * cam.zoom, h = n.h * cam.zoom;
    ctx.save(); ctx.translate(p.x, p.y);
    if (TH.pixel) {
      ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
      ctx.save(); ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
      var shades = ['#6b4a2b', '#5c3f24', '#74522f'], planks = 3, ph = h / planks;
      for (var i = 0; i < planks; i++) {
        var top = -h / 2 + i * ph;
        ctx.fillStyle = shades[i % shades.length]; ctx.fillRect(-w / 2, top, w, ph);
        ctx.fillStyle = '#3d2917'; ctx.fillRect(-w / 2, top, w, Math.max(1, 2 * cam.zoom));
      }
      ctx.restore();
      ctx.shadowBlur = 0; ctx.lineWidth = 3; ctx.strokeStyle = '#3d2917'; ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = '#2a1a0e';
      var nail = Math.max(2, 3 * cam.zoom), off = 9 * cam.zoom;
      [[-w / 2 + off, -h / 2 + off], [w / 2 - off, -h / 2 + off], [-w / 2 + off, h / 2 - off], [w / 2 - off, h / 2 - off]]
        .forEach(function (xy) { ctx.beginPath(); ctx.arc(xy[0], xy[1], nail, 0, Math.PI * 2); ctx.fill(); });
      if (n.text) {
        var baseFs = 13 * cam.zoom * textScale;
        ctx.fillStyle = '#f3e3c0'; ctx.shadowColor = '#2a1a0e'; ctx.shadowOffsetX = 1.5 * cam.zoom; ctx.shadowOffsetY = 1.5 * cam.zoom;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        drawFitted(n.text, w - 22 * cam.zoom, h - 22 * cam.zoom, baseFs);
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetX = 2 * cam.zoom; ctx.shadowOffsetY = 3 * cam.zoom;
      ctx.fillStyle = '#ffe066'; ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(-w / 2, -h / 2, w, Math.max(4, h * 0.16));
      var fold = Math.min(w, h) * 0.18;
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath(); ctx.moveTo(w / 2 - fold, h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(w / 2, h / 2 - fold); ctx.closePath(); ctx.fill();
      if (n.text) {
        var baseFs2 = 13 * cam.zoom * textScale;
        ctx.fillStyle = '#3a2f00'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        drawFitted(n.text, w - 22 * cam.zoom, h - 22 * cam.zoom, baseFs2);
      }
    }
    ctx.restore();
  }

  function fmtDur(s) { s = Math.max(0, Math.round(s)); var m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
  function drawVoice(n) {
    var color = effectiveColor(n), stl = nodeStyle(color);
    var p = worldToScreen(n.x + n.w / 2, n.y + n.h / 2), w = n.w * cam.zoom, h = n.h * cam.zoom;
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.shadowColor = color; ctx.shadowBlur = 10 * GLOW; ctx.fillStyle = stl.fill; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.lineWidth = 3; ctx.strokeStyle = stl.border; ctx.strokeRect(-w / 2, -h / 2, w, h); ctx.shadowBlur = 0;
    var fs = clamp(11 * cam.zoom * textScale, 7, 22);
    ctx.font = fs + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = stl.text;
    ctx.fillText('\\u266a ' + fmtDur(n.dur || 0), 0, 0);
    ctx.restore();
  }

  function render() {
    if (wallpaperImg && wallpaperImg.complete && wallpaperImg.naturalWidth) {
      var sc = Math.max(view.w / wallpaperImg.naturalWidth, view.h / wallpaperImg.naturalHeight);
      var dw = wallpaperImg.naturalWidth * sc, dh = wallpaperImg.naturalHeight * sc;
      ctx.drawImage(wallpaperImg, (view.w - dw) / 2, (view.h - dh) / 2, dw, dh);
    } else { ctx.fillStyle = TH.bg; ctx.fillRect(0, 0, view.w, view.h); }
    drawGrid();
    state.circles.forEach(drawCircle);
    state.hexagons.forEach(drawHexagon);
    state.nodes.forEach(function (n) {
      if (n.kind === 'pancarte') drawPancarte(n);
      else if (n.kind === 'voice') drawVoice(n);
      else drawRect(n);
    });
  }

  function loop() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
