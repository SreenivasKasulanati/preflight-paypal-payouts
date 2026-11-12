'use client';

// Fit to window: the Review page's rows are sized from the height actually available, so the
// scoreboard, the batch grid, the case file and the sender check fill one screen on any display.
// Long content scrolls inside its own widget instead of the page. AG Studio's pixel font sizes
// follow the page's base text size (see html { font-size } in app/globals.css).

import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/** Rows in the Review page layout (studio-report.ts): scoreboard 8 + grid 35 + case/sender 16. */
export const REVIEW_ROWS = 59;
export const CANVAS_PADDING = 14;

/** Widget padding (theme.ts studioWidgetPadding) on both sides, plus the 1px border. */
const WIDGET_CHROME = 2 * 12 + 2;

export type Fit = { rowHeight: number; scale: number; totalRows: number; scoreboardRows: number };
const DEFAULT: Fit = { rowHeight: 18, scale: 1, totalRows: REVIEW_ROWS, scoreboardRows: 8 };

let fit = DEFAULT;
const listeners = new Set<() => void>();
const setFit = (next: Fit) => {
  if (next.rowHeight === fit.rowHeight && next.scale === fit.scale && next.totalRows === fit.totalRows && next.scoreboardRows === fit.scoreboardRows) return;
  fit = next;
  listeners.forEach((l) => l());
};

/** Read the current fit (row height and text scale) from any widget. */
export const useFit = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => fit,
    () => DEFAULT,
  );

/** Measures the Studio area and keeps the fit in step with the window. Call once, on the page. */
export function useFitTo(ref: RefObject<HTMLElement | null>) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
      const rowHeight = Math.max(9, Math.min(26, Math.floor((el.clientHeight - 2 * CANVAS_PADDING) / REVIEW_ROWS)));
      // Whole-pixel rows leave a little height over: the extra rows go to the bottom panels.
      const totalRows = Math.max(REVIEW_ROWS, Math.floor((el.clientHeight - 2 * CANVAS_PADDING) / rowHeight));
      // The scoreboard keeps its natural height (about 4.8rem of tiles plus padding) on any screen.
      const rootPx = 16 * scale;
      const scoreboardRows = Math.max(8, Math.ceil((4.8 * rootPx + WIDGET_CHROME) / rowHeight));
      setFit({ rowHeight, scale: Math.round(scale * 100) / 100, totalRows, scoreboardRows });
      setReady(true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return ready;
}

// ---- The batch grid's own height -----------------------------------------------------------------
// The grid widget reports the height it needs to show its rows (up to MAX_GRID_ROWS, then it
// scrolls); the page gives it exactly that many layout rows, and the case file and sender check
// below get the rest. The total stays REVIEW_ROWS, so everything stays on one screen.

export const MAX_GRID_ROWS = 8;
const MIN_GRID_ROWS = 12;
const MIN_BOTTOM_ROWS = 14;

let gridWant: number | null = null;
const wantListeners = new Set<() => void>();
export const setGridWant = (px: number | null) => {
  const next = px === null ? null : Math.ceil(px);
  if (next === gridWant || (next !== null && gridWant !== null && Math.abs(next - gridWant) < 2)) return;
  gridWant = next;
  wantListeners.forEach((l) => l());
};
export const useGridWant = () =>
  useSyncExternalStore(
    (l) => {
      wantListeners.add(l);
      return () => wantListeners.delete(l);
    },
    () => gridWant,
    () => null,
  );

/** How many layout rows the grid gets, for the height it asked for (null: the default layout). */
export function gridRowsFor(wantPx: number | null, f: Fit) {
  const max = f.totalRows - f.scoreboardRows - Math.max(MIN_BOTTOM_ROWS, Math.ceil(180 / f.rowHeight));
  if (wantPx === null) return Math.min(35, max);
  return Math.max(MIN_GRID_ROWS, Math.min(max, Math.ceil((wantPx + WIDGET_CHROME) / f.rowHeight)));
}

/** The Review page layout for a grid of `gridRows` layout rows. */
export function reviewLayout(gridRows: number, f: Fit) {
  const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });
  const top = f.scoreboardRows;
  const bottom = f.totalRows - top - gridRows;
  return {
    scoreboard: at(0, 0, 24, top),
    grid: at(0, top, 24, gridRows),
    case: at(0, top + gridRows, 14, bottom),
    sender: at(14, top + gridRows, 10, bottom),
  };
}
