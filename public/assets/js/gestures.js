'use strict';
/*
 * Touch / pointer gesture helpers built on Pointer Events.
 *
 * The SPA is mouse-first (context menus, hover actions), so these exist to give
 * touch users equivalents without changing the mouse behaviour. Everything is
 * progressive enhancement: if Pointer Events are unavailable the helpers are
 * no-ops and the mouse path still works.
 */

const MOVE_TOLERANCE = 10;   // px of travel that cancels a long-press
const LONG_PRESS_MS = 500;

export function isTouch() {
  return typeof window !== 'undefined'
    && (window.matchMedia?.('(hover: none)').matches || 'ontouchstart' in window);
}

/**
 * Fire `cb(x, y)` when the user presses and holds without moving.
 * Returns a teardown function.
 *
 * Only touch/pen pointers trigger it — a mouse press-and-hold should keep
 * behaving like a normal press so desktop selection is unaffected.
 */
export function onLongPress(node, cb) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const down = (e) => {
    if (e.pointerType === 'mouse') return;
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      cb(e.clientX, e.clientY);
    }, LONG_PRESS_MS);
  };

  const move = (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) cancel();
  };

  const up = () => cancel();

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('pointerleave', up);

  return () => {
    cancel();
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', up);
    node.removeEventListener('pointerleave', up);
  };
}

/**
 * Horizontal swipe detection. `onLeft`/`onRight` receive the event.
 * Vertical-dominant gestures are ignored so page scrolling still works.
 * Returns a teardown function.
 */
export function onSwipe(node, { onLeft, onRight, threshold = 60 } = {}) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const down = (e) => {
    if (e.pointerType === 'mouse') return;
    startX = e.clientX;
    startY = e.clientY;
    tracking = true;
  };

  const up = (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) onLeft && onLeft(e);
    else onRight && onRight(e);
  };

  const cancel = () => { tracking = false; };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  return () => {
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', cancel);
  };
}

/**
 * Swipe in from the left edge of the screen to open the drawer.
 * Uses a capture-phase listener on document so it works anywhere on the page.
 */
export function onEdgeSwipe(open, { edge = 28, threshold = 50 } = {}) {
  let startX = null;
  let startY = 0;

  const down = (e) => {
    if (e.pointerType === 'mouse') return;
    if (e.clientX > edge) return;
    startX = e.clientX;
    startY = e.clientY;
  };

  const up = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    const dy = Math.abs(e.clientY - startY);
    const fromEdge = startX;
    startX = null;
    if (dx > threshold && dy < 60 && fromEdge <= edge) open();
  };

  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointerup', up, true);
  return () => {
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('pointerup', up, true);
  };
}
