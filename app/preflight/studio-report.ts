// The Preflight report: a Review page made of Preflight's custom widgets, and a Risk Control Room
// built from AG Studio's own widgets over the same data, which the AI can add to and edit.

import type { AgPageState, AgReportState, AgWidgetLayoutState } from 'ag-studio';

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const countd = (id: string) => ({ id, aggregation: 'countd' as const });

export const REVIEW_PAGE = 'review';
export const CONTROL_ROOM_PAGE = 'control-room';

// Custom widget types aren't in Studio's default registry typings, so pages are typed loosely here.
const page = (p: { id: string; widgets: Record<string, unknown>; widgetLayout: Record<string, AgWidgetLayoutState> }) =>
  p as unknown as AgPageState;

const review = page({
  id: REVIEW_PAGE,
  widgets: {
    scoreboard: { type: 'pf-scoreboard', dataMapping: {}, format: {} },
    grid: { type: 'pf-review', dataMapping: {}, format: {} },
    case: { type: 'pf-case', dataMapping: {}, format: {} },
    sender: { type: 'pf-sender', dataMapping: {}, format: {} },
  },
  widgetLayout: {
    // 59 rows in all (fit.ts sizes each row so the page fills the window).
    scoreboard: at(0, 0, 24, 8),
    grid: at(0, 8, 24, 35),
    case: at(0, 43, 14, 16),
    sender: at(14, 43, 10, 16),
  },
});

const controlRoom = page({
  id: CONTROL_ROOM_PAGE,
  widgets: {
    'by-state': {
      type: 'column-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'payouts.state' }], valueKey: [sum('payouts.amount')], legendKey: [{ id: 'payouts.state' }] },
      format: {
        ...title('Payout dollars by Preflight state'),
        style: { theme: { bar: { series: { label: { enabled: true } } }, common: { legend: { enabled: false } } }, custom: { categoryAxis: { gridLine: { enabled: false } } } },
      },
    },
    'by-signal': {
      type: 'donut-chart',
      dataMapping: { categoryKey: [{ id: 'findings.signal' }], valueKey: [countd('findings.id')] },
      format: { ...title('What triggered holds and warnings'), style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } } } },
    },
    'weekly-history': {
      type: 'column-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'calendar::week' }], valueKey: [sum('history.amount')], legendKey: [{ id: 'history.payee' }] },
      format: {
        ...title('Payouts sent per week, by payee'),
        style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } }, custom: { categoryAxis: { gridLine: { enabled: false } } } },
      },
    },
    safety: { type: 'pf-safety-test', dataMapping: {}, format: {} },
    rules: { type: 'pf-rules', dataMapping: {}, format: {} },
    payees: {
      type: 'grid',
      dataMapping: {
        cols: [{ id: 'payees.payee' }, { id: 'payees.email' }, { id: 'payees.trusted' }, { id: 'payees.usualPay' }],
      },
      format: title('Payees and trust'),
    },
    findings: {
      type: 'grid',
      dataMapping: { cols: [{ id: 'findings.payee' }, { id: 'findings.severity' }, { id: 'findings.signal' }, { id: 'findings.message' }] },
      format: title('Every signal, with its source'),
    },
  },
  widgetLayout: {
    'by-state': at(0, 0, 8, 18),
    'by-signal': at(8, 0, 8, 18),
    safety: at(16, 0, 8, 18),
    'weekly-history': at(0, 18, 14, 18),
    rules: at(14, 18, 10, 18),
    payees: at(0, 36, 12, 16),
    findings: at(12, 36, 12, 16),
  },
});

export const preflightReport: AgReportState = {
  selectedPageId: REVIEW_PAGE,
  pages: [review, controlRoom],
  // The Review page has no page filters, so the filters panel starts collapsed to give the grid room.
  panels: { filters: { collapsed: true } },
} as AgReportState;
