// Coordinate transformations between world coordinates (in meters) and screen coordinates (in CSS pixels).
import { state } from './state.js?v=ms946jiz';

// Viewport size in CSS pixels (window.innerWidth/Height).
export const view = { w: window.innerWidth, h: window.innerHeight };

// Set the viewport size (in CSS pixels).
export function setView(w, h) { view.w = w; view.h = h; }

// Convert world coordinates (in meters) to screen coordinates (in CSS pixels).
export function worldToScreen(wx, wy) {
  const { x, y, zoom } = state.camera;
  return {
    x: (wx - x) * zoom + view.w / 2,
    y: (wy - y) * zoom + view.h / 2,
  };
}

// Convert screen coordinates (in CSS pixels) to world coordinates (in meters).
export function screenToWorld(sx, sy) {
  const { x, y, zoom } = state.camera;
  return {
    x: (sx - view.w / 2) / zoom + x,
    y: (sy - view.h / 2) / zoom + y,
  };
}

// Zoom in/out at a given screen position (in CSS pixels).
export function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  state.camera.zoom = Math.min(8, Math.max(0.05, state.camera.zoom * factor));
  const after = screenToWorld(sx, sy);
  state.camera.x += before.x - after.x;
  state.camera.y += before.y - after.y;
}

// Pan in screen pixels.
export function panBy(dxScreen, dyScreen) {
  state.camera.x -= dxScreen / state.camera.zoom;
  state.camera.y -= dyScreen / state.camera.zoom;
}

// Center the camera on a given world position (in meters).
export function centerOn(wx, wy) {
  state.camera.x = wx;
  state.camera.y = wy;
}
