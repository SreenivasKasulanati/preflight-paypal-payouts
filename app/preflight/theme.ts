// Preflight's AG Studio theme: the boilerplate's PayPal tokens (app/globals.css) with a richer chart
// palette, softer rounded widgets on a cool canvas, and roomier grid rows, so the Review page and the
// Risk Control Room read as one product.

import { agStudioPayPalTheme } from '../dashboard/studio/theme';

// Ten distinct, colour-blind-aware hues led by PayPal blue; Studio's charts take them in order.
const PALETTE = ['#0070e0', '#00a3a1', '#7b61ff', '#f5a623', '#e4572e', '#1ba672', '#003087', '#d6457a', '#47b5ff', '#8a94a6'];
const palette = Object.fromEntries(
  PALETTE.flatMap((c, i) => [
    [`chartPaletteFills${i + 1}Color`, c],
    [`chartPaletteStrokes${i + 1}Color`, c],
  ]),
);

export const preflightTheme = agStudioPayPalTheme.withParams({
  accentColor: 'var(--pp-blue)',
  studioWrapperBackgroundColor: '#eef2f8',
  studioCanvasBackgroundColor: '#eef2f8',
  studioCanvasPadding: 18,
  studioCanvasRowHeight: 18,
  studioWidgetBorderRadius: 14,
  studioWidgetBorder: { width: 1, color: '#dde4ee' },
  studioWidgetPadding: 14,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleTextColor: 'var(--pp-navy)',
  gridRowHeight: 44,
  gridHeaderBackgroundColor: '#f6f8fc',
  gridHeaderTextColor: 'var(--pp-navy)',
  ...palette,
});

/** The theme at the current fit: row height from the window, fonts following the page's base size. */
export const fittedTheme = (rowHeight: number, scale: number) =>
  preflightTheme.withParams({
    studioCanvasRowHeight: rowHeight,
    studioCanvasPadding: 14,
    studioWidgetPadding: 12,
    fontSize: Math.round(14 * scale),
    gridFontSize: Math.round(14 * scale),
    studioWidgetTitleFontSize: Math.round(15 * scale),
    chartFontSize: Math.round(12 * scale),
  });
