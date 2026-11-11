// Preflight's AG Studio theme: the boilerplate's PayPal tokens (app/globals.css), with a slightly
// denser canvas and navy widget titles so the Review page reads as one product, not a dashboard kit.

import { agStudioPayPalTheme } from '../dashboard/studio/theme';

export const preflightTheme = agStudioPayPalTheme.withParams({
  accentColor: 'var(--pp-blue)',
  studioCanvasPadding: 16,
  studioCanvasRowHeight: 18,
  studioWidgetBorderRadius: 10,
  studioWidgetPadding: 12,
  studioWidgetTitleTextColor: 'var(--pp-navy)',
});
