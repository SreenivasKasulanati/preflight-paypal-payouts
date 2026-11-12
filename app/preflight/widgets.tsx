'use client';

// Preflight's custom AG Studio widgets. Each one reads the shared client store (client-store.ts),
// so an action in one widget (editing a row, a payee's answer, a PayPal status change) redraws
// them all. They render inside Studio's canvas, theme and edit mode like its built-in widgets.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AllCommunityModule, type ColDef, type GridApi, type ICellRendererParams } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { studioGridTheme } from 'ag-studio';

// The review grid's theme: Studio's grid theme without the cell focus box (the selected row is
// highlighted instead) and with a soft stripe on alternate rows.
const reviewGridTheme = studioGridTheme.withParams({
  rangeSelectionBorderColor: 'transparent',
  oddRowBackgroundColor: '#fafbfd',
  selectedRowBackgroundColor: '#e8f1fd',
  headerFontWeight: 600,
});
import { createWidgets } from 'ag-studio-react';
import type { Snapshot } from '@/lib/preflight/snapshot';
import { actions, currentReview, preflightStore, selectedItem, usePreflight } from './client-store';
import { MAX_GRID_ROWS, setGridWant, useFit } from './fit';

type Item = Snapshot['reviews'][number]['items'][number];

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const modules = [AllCommunityModule];

// --- Shared bits ----------------------------------------------------------------------------------

const STATE_STYLE: Record<Item['state'], { label: string; cls: string }> = {
  clear: { label: 'Clear', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  warn: { label: 'Warning', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  held: { label: 'Held', cls: 'bg-red-50 text-red-800 ring-red-200' },
  denied: { label: 'Stopped', cls: 'bg-slate-100 text-slate-700 ring-slate-300' },
  sent: { label: 'Sent', cls: 'bg-blue-50 text-blue-800 ring-blue-200' },
};

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}`}>{children}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-pp-muted">{children}</div>;
}

const verdictLabel = { likely_fraud: 'Likely fraud', likely_genuine: 'Likely genuine', needs_human: 'Needs a human' } as const;
const verdictCls = {
  likely_fraud: 'bg-red-600 text-white ring-red-600',
  likely_genuine: 'bg-emerald-600 text-white ring-emerald-600',
  needs_human: 'bg-amber-500 text-white ring-amber-500',
} as const;

function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function coolingLeft(item: Item, now: number) {
  if (!item.coolingUntil) return 0;
  return Math.max(0, Date.parse(item.coolingUntil) - now);
}
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// --- Scoreboard -----------------------------------------------------------------------------------

const TONES = {
  green: { bar: 'from-emerald-500 to-teal-400', bg: 'from-emerald-50', text: 'text-emerald-700', chip: 'bg-emerald-100 text-emerald-700' },
  red: { bar: 'from-rose-500 to-orange-400', bg: 'from-rose-50', text: 'text-rose-700', chip: 'bg-rose-100 text-rose-700' },
  navy: { bar: 'from-[#001c64] to-[#0070e0]', bg: 'from-blue-50', text: 'text-pp-navy', chip: 'bg-blue-100 text-pp-navy' },
  violet: { bar: 'from-violet-500 to-sky-400', bg: 'from-violet-50', text: 'text-violet-700', chip: 'bg-violet-100 text-violet-700' },
} as const;

function Tile({ label, value, sub, tone, icon }: { label: string; value: string; sub: string; tone: keyof typeof TONES; icon: string }) {
  const t = TONES[tone];
  return (
    <div className={`@container relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-xl border border-[#dde4ee] bg-gradient-to-br ${t.bg} to-white px-4 py-2 shadow-sm`}>
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${t.bar}`} />
      <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg @[15rem]:flex ${t.chip}`} aria-hidden>{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-[0.6875rem] font-semibold uppercase tracking-wider text-pp-muted">{label}</div>
        <div className={`text-2xl font-bold leading-tight ${t.text}`}>{value}</div>
        <div className="truncate text-xs text-pp-muted">{sub}</div>
      </div>
    </div>
  );
}

function ScoreboardWidget() {
  const s = usePreflight();
  const k = s.snapshot?.kpis;
  if (!s.snapshot || !k) return <Empty>Loading…</Empty>;
  const trusted = s.snapshot.payees.filter((p) => p.trusted).length;
  return (
    <div className="flex h-full gap-3">
      <Tile tone="green" icon="✓" label="Went straight through" value={k.instantShare === null ? '–' : `${Math.round(k.instantShare * 100)}%`} sub="of decided payouts, with no waiting" />
      <Tile tone="red" icon="⏸" label="Held right now" value={usd(k.heldAmount)} sub={`${k.held} payout${k.held === 1 ? '' : 's'} on hold, nothing sent`} />
      <Tile tone="navy" icon="⛨" label="Fraud stopped" value={usd(k.protectedAmount)} sub="never left Brightline's PayPal" />
      <Tile tone="violet" icon="★" label="Trusted payees" value={`${trusted} / ${s.snapshot.payees.length}`} sub="verify once, then straight through" />
    </div>
  );
}

// --- Payout review grid ---------------------------------------------------------------------------

const DOT: Record<Item['state'], string> = { clear: 'bg-emerald-500', warn: 'bg-amber-500', held: 'bg-rose-500', denied: 'bg-slate-500', sent: 'bg-blue-600' };

function StateCell({ data, node }: ICellRendererParams<Item>) {
  if (!data || node.rowPinned) return null;
  const st = STATE_STYLE[data.state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${st.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[data.state]}`} />
      {st.label}
    </span>
  );
}

/** Name over email, so nothing is cut off; the wallet as a small tag. */
function PayeeCell({ data, node }: ICellRendererParams<Item>) {
  if (!data) return null;
  if (node.rowPinned) return <span className="font-semibold text-pp-navy">Batch total · {data.receiver}</span>;
  const venmo = data.wallet === 'VENMO';
  return (
    <div className="flex flex-col justify-center py-1 leading-tight" title={data.receiverSource === 'on_file' ? 'Email on file (the request named the payee only)' : 'Email written in the request'}>
      <span className="font-semibold text-pp-ink">{data.name}</span>
      <span className="flex items-center gap-1.5 text-xs text-pp-muted">
        {data.receiver}
        {venmo && (
          <span className="rounded bg-sky-50 px-1 text-[0.625rem] font-semibold text-sky-700 ring-1 ring-sky-200">
            {data.paypal?.walletSent === 'PAYPAL' ? 'Venmo → PayPal (sandbox)' : 'Venmo'}
          </span>
        )}
      </span>
    </div>
  );
}

function PayPalCell({ data }: ICellRendererParams<Item>) {
  const status = data?.paypal?.status;
  if (!status) return <span className="text-xs text-pp-muted">–</span>;
  const cls =
    status === 'SUCCESS' ? 'bg-emerald-600 text-white ring-emerald-600'
      : status === 'UNCLAIMED' || status === 'PENDING' || status === 'ONHOLD' ? 'bg-amber-100 text-amber-900 ring-amber-300'
        : status === 'RETURNED' ? 'bg-slate-200 text-slate-800 ring-slate-300'
          : 'bg-red-100 text-red-800 ring-red-300';
  return <Badge cls={cls}>{status}</Badge>;
}

/** Last ten payouts as a small bar chart, with today's amount drawn in red when it's out of range. */
function HistoryCell({ data, node }: ICellRendererParams<Item>) {
  if (node.rowPinned) return null;
  const b = data?.baseline;
  if (!data || !b || b.count === 0) return <span className="text-xs text-pp-muted">no history</span>;
  const values = [...b.lastAmounts, data.amount];
  const max = Math.max(...values);
  const w = 120;
  const h = 26;
  const bw = w / values.length - 2;
  const unusual = data.amount > b.max * 1.15 || data.amount < b.min * 0.85;
  return (
    <svg width={w} height={h} role="img" aria-label={`Usual ${usd(b.median)}, today ${usd(data.amount)}`}>
      {values.map((v, i) => {
        const bh = Math.max(2, (v / max) * (h - 2));
        const today = i === values.length - 1;
        return <rect key={i} x={i * (bw + 2)} y={h - bh} width={bw} height={bh} rx={1} fill={today ? (unusual ? 'var(--pp-danger)' : 'var(--pp-blue)') : '#a9c7ee'} />;
      })}
    </svg>
  );
}

const rank = { hold: 0, warn: 1, info: 2 } as const;

const SIGNAL_LABEL: Record<string, string> = {
  AMOUNT_OUTLIER: 'unusual amount',
  UNVERIFIED_EXTRACTION: 'check extraction',
  UNKNOWN_PAYEE: 'new payee',
  HEADER_REPLY_TO_MISMATCH: 'reply-to redirect',
  HEADER_LOOKALIKE_DOMAIN: 'lookalike domain',
  HEADER_AUTH_FAIL: 'email auth failed',
  URGENCY_LANGUAGE: 'pressure wording',
  HEADERS_NOT_PROVIDED: 'sender unchecked',
  SENDER_UNVERIFIED: 'suspicious sender',
  DUPLICATE_IN_BATCH: 'twice in batch',
};

function SignalsCell({ data, node, context }: ICellRendererParams<Item> & { context: { rules: Snapshot['rules'] } }) {
  if (!data || node.rowPinned) return null;
  if (data.findings.length === 0) return <span className="text-xs text-emerald-700">all checks passed</span>;
  return (
    <div className="flex flex-wrap gap-1 py-1">
      {[...data.findings]
        .sort((a, b) => rank[a.severity] - rank[b.severity])
        .slice(0, 4)
        .map((f, i) => {
        const rule = f.ruleId ? context.rules.find((r: Snapshot['rules'][number]) => r.id === f.ruleId) : undefined;
        const label =
          f.code === 'RULE'
            ? ({ changed_destination: 'email changed', vs_usual: 'above usual', duplicate: 'possible duplicate', new_payee: 'new payee', max_amount: 'over limit', batch_total: 'batch total' } as Record<string, string>)[rule?.kind ?? ''] ?? 'rule'
            : SIGNAL_LABEL[f.code] ?? f.code;
        const cls = f.severity === 'hold' ? 'bg-red-50 text-red-800 ring-red-200' : f.severity === 'warn' ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-slate-50 text-slate-700 ring-slate-200';
        return (
          <span key={i} title={f.message} className={`rounded px-1.5 py-0.5 text-[0.6875rem] font-medium ring-1 ${cls}`}>
            {label}
          </span>
        );
      })}
      {data.findings.length > 4 && <span className="px-1 text-[0.6875rem] text-pp-muted" title={data.findings.slice(4).map((f) => f.message).join('\n')}>+{data.findings.length - 4} more</span>}
    </div>
  );
}

function ActionCell({ data, node }: ICellRendererParams<Item>) {
  const now = useNow();
  if (!data || node.rowPinned) return null;
  const btn = 'rounded px-2 py-0.5 text-xs font-semibold ring-1';
  if (data.state === 'warn' && !data.acknowledged)
    return <button className={`${btn} bg-white text-amber-800 ring-amber-300 hover:bg-amber-50`} onClick={() => actions.acknowledge(data.rowId)}>Acknowledge</button>;
  if (data.state === 'warn') return <span className="text-xs text-amber-800">acknowledged</span>;
  if (data.state === 'held') {
    const left = coolingLeft(data, now);
    return <span className="text-xs text-red-800">{data.awaitingCode ? 'waiting for code' : data.awaitingPayee ? 'waiting for payee' : 'held'}{left ? ` · ${mmss(left)}` : ''}</span>;
  }
  if (data.state === 'sent' && data.paypal?.status === 'UNCLAIMED')
    return <button className={`${btn} bg-white text-slate-800 ring-slate-300 hover:bg-slate-50`} onClick={() => actions.pullBack(data.rowId)}>Pull back</button>;
  if (data.state === 'sent' && data.releasedBy) return <span className="text-xs text-blue-800">released by {data.releasedBy}</span>;
  return null;
}

/** The batch-wide hold: shown when the request's sender failed a check. */
function SenderBanner({ reviewId, from }: { reviewId: string; from?: string }) {
  const s = usePreflight();
  const [called, setCalled] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-gradient-to-r from-rose-50 to-white px-3 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-500 text-sm font-bold text-white" aria-hidden>!</span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-rose-900">Suspicious sender: the whole batch is on hold.</div>
        <div className="text-xs text-rose-800">
          {from ? <>It claims to be from <b>{from}</b>, but the sender check failed. </> : null}
          Check with the real sender by phone or in person, not by replying to this email.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          disabled={!!s.busy}
          onClick={() => actions.rejectSender(reviewId)}
          title="The real sender didn't send this: stop every payout in it"
          className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm disabled:opacity-40"
        >
          Not from them: stop all
        </button>
        <span className="text-xs text-rose-300">|</span>
        <label className="flex items-center gap-1.5 text-xs text-rose-900">
          <input type="checkbox" checked={called} onChange={(e) => setCalled(e.target.checked)} /> They confirmed it
        </label>
        <button
          disabled={!called || !!s.busy}
          onClick={() => actions.confirmSender(reviewId)}
          className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 ring-1 ring-rose-300 disabled:opacity-40"
        >
          Confirm batch
        </button>
      </div>
    </div>
  );
}

function ReviewWidget() {
  const s = usePreflight();
  const review = currentReview(s);
  const rules = s.snapshot?.rules ?? [];
  const { scale } = useFit();
  const gridTheme = useMemo(() => reviewGridTheme.withParams({ fontSize: Math.round(14 * scale) }), [scale]);

  // Report the height that shows every row (up to MAX_GRID_ROWS): everything in this widget that
  // isn't the grid's scrolling body, plus the first rows' real heights. The page sizes the layout to it.
  const rootRef = useRef<HTMLDivElement>(null);
  const gridApi = useRef<GridApi<Item> | null>(null);
  const hasReview = !!review;
  useEffect(() => {
    const root = rootRef.current;
    if (!hasReview || !root) {
      setGridWant(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // AG Grid 36: .ag-grid-viewport is the scrolling box; inside it sit the header (pinned top),
        // the rows and the pinned totals row. Wanted height = everything outside that box, plus the
        // header, the totals row and the first rows' real heights.
        const viewport = root.querySelector<HTMLElement>('.ag-grid-viewport');
        const api = gridApi.current;
        if (!viewport || !api || api.isDestroyed()) return;
        const header = root.querySelector<HTMLElement>('.ag-grid-pinned-top-rows')?.offsetHeight ?? 0;
        const totalsRow = root.querySelector<HTMLElement>('.ag-grid-pinned-bottom-rows')?.offsetHeight ?? 0;
        let rows = 0;
        let shown = 0;
        api.forEachNode((n) => {
          if (shown < MAX_GRID_ROWS) {
            rows += n.rowHeight ?? 0;
            shown++;
          }
        });
        setGridWant(root.clientHeight - viewport.clientHeight + header + totalsRow + rows + 2);
      });
    };
    // Rows grow after they render (auto height, wrapping chips), so watch the rows container too.
    let watched: Element | null = null;
    const watch = () => {
      const rowsBox = root.querySelector('.ag-grid-scrolling-container');
      if (rowsBox && rowsBox !== watched) {
        watched = rowsBox;
        ro.observe(rowsBox);
      }
      measure();
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    window.addEventListener('pf-grid-rendered', watch);
    watch();
    return () => {
      ro.disconnect();
      window.removeEventListener('pf-grid-rendered', watch);
      cancelAnimationFrame(frame);
    };
  }, [hasReview, review?.id, review?.items.length, review?.senderConfirmedAt, review?.senderRejectedAt]);
  useEffect(() => () => setGridWant(null), []);

  const columns = useMemo<ColDef<Item>[]>(
    () => [
      { headerName: 'Status', field: 'state', cellRenderer: StateCell, width: 120, editable: false, cellClass: 'pf-cell-center', headerClass: 'pf-header-center' },
      { headerName: 'Payee', colId: 'payee', cellRenderer: PayeeCell, flex: 1.3, minWidth: 230, sortable: false, autoHeight: true },
      {
        headerName: 'Amount',
        field: 'amount',
        width: 112,
        type: 'rightAligned',
        cellClass: 'pf-cell-end font-semibold tabular-nums',
        headerTooltip: 'Double-click to correct an amount: the row is re-checked at once',
        editable: (p) => !p.node.rowPinned && p.data?.state !== 'sent' && p.data?.state !== 'denied',
        cellEditor: 'agNumberCellEditor',
        valueFormatter: (p) => (typeof p.value === 'number' ? usd(p.value) : ''),
      },
      { headerName: 'Last 10 + today', colId: 'history', cellRenderer: HistoryCell, width: 136, sortable: false, cellClass: 'pf-cell-middle' },
      { headerName: 'Signals', colId: 'signals', cellRenderer: SignalsCell, flex: 1.2, minWidth: 200, autoHeight: true, wrapText: true, sortable: false },
      { headerName: 'PayPal', colId: 'paypal', valueGetter: (p) => p.data?.paypal?.status ?? '', cellRenderer: PayPalCell, width: 124, enableCellChangeFlash: true, cellClass: 'pf-cell-center', headerClass: 'pf-header-center' },
      { headerName: '', colId: 'action', cellRenderer: ActionCell, width: 176, sortable: false },
    ],
    [],
  );

  if (!review) return <Empty>Paste or upload a payment request on the left, then press <b className="mx-1">Run Preflight</b>.</Empty>;

  const ready = review.items.filter((i) => i.state === 'clear' || (i.state === 'warn' && i.acknowledged));
  const sum = (xs: Item[]) => xs.reduce((t, i) => t + i.amount, 0);
  const totals = {
    rowId: 'totals', name: 'Batch total', receiver: `${review.items.length} payouts`, amount: sum(review.items), findings: [],
  } as unknown as Item;
  const waitingWarnings = review.items.filter((i) => i.state === 'warn' && !i.acknowledged).length;

  return (
    <div ref={rootRef} className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-base font-semibold text-pp-navy">This week&apos;s batch</span>
        <span className="text-pp-muted">
          {review.items.length} payouts from {review.source === 'email' ? 'an email' : review.source === 'csv' ? 'a CSV' : 'pasted text'} · read by {review.extractedBy === 'ai' ? 'AI, checked against the text' : 'parser'}
        </span>
        {review.aiNote && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">{review.aiNote}</span>}
        <span className="ml-auto text-xs text-pp-muted">
          Ready {usd(sum(ready))} · Held {usd(sum(review.items.filter((i) => i.state === 'held')))} · Sent {usd(sum(review.items.filter((i) => i.state === 'sent')))}
        </span>
        <button
          className="rounded-lg bg-gradient-to-r from-[#003087] to-[#0070e0] px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40"
          disabled={ready.length === 0 || !!s.busy}
          title={waitingWarnings ? `${waitingWarnings} warning(s) need acknowledging first` : undefined}
          onClick={() => actions.send(review.id)}
        >
          Send {ready.length} ready via PayPal
        </button>
        <button className="rounded-md px-2 py-1.5 text-sm font-semibold text-pp-blue ring-1 ring-pp-border hover:bg-pp-highlight" onClick={() => actions.refresh(review.id)}>
          Refresh PayPal
        </button>
      </div>
      {review.senderSuspicious && !review.senderConfirmedAt && !review.senderRejectedAt && <SenderBanner reviewId={review.id} from={review.email.from} />}
      {review.senderRejectedAt && (
        <div className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-800 ring-1 ring-slate-300">
          <b>Fake request stopped</b> at {new Date(review.senderRejectedAt).toLocaleTimeString('en-US')}: the real sender didn&apos;t send it, so nothing in it was paid.
          Pay this week&apos;s freelancers from a genuine request.
        </div>
      )}
      {review.senderSuspicious && review.senderConfirmedAt && (
        <div className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 ring-1 ring-emerald-200">
          Batch confirmed with the real sender at {new Date(review.senderConfirmedAt).toLocaleTimeString('en-US')}. Rows with their own warning signs are still checked one by one.
        </div>
      )}
      <div className="min-h-0 flex-1">
        <AgGridProvider modules={modules}>
          <AgGridReact<Item>
            theme={gridTheme}
            rowData={review.items}
            columnDefs={columns}
            defaultColDef={{ cellClass: 'pf-cell-middle' }}
            context={{ rules }}
            getRowId={(p) => p.data.rowId}
            onGridReady={(e) => (gridApi.current = e.api)}
            onFirstDataRendered={() => window.dispatchEvent(new Event('pf-grid-rendered'))}
            onRowDataUpdated={() => window.dispatchEvent(new Event('pf-grid-rendered'))}
            pinnedBottomRowData={[totals]}
            rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
            onRowClicked={(e) => e.data && e.data.rowId !== 'totals' && preflightStore.select(e.data.rowId)}
            onCellValueChanged={(e) => {
              if (!e.data || e.data.rowId === 'totals' || e.newValue === e.oldValue) return;
              if (e.colDef.field === 'amount') actions.edit(e.data.rowId, { amount: Number(e.newValue) });
            }}
            getRowClass={(p) => (p.node.rowPinned ? 'font-semibold' : p.data?.rowId === s.selectedRowId ? 'ag-row-selected' : '')}
            tooltipShowDelay={300}
            singleClickEdit={false}
            suppressCellFocus
            stopEditingWhenCellsLoseFocus
          />
        </AgGridProvider>
      </div>
    </div>
  );
}

// --- Case file (investigator + what happens next) -------------------------------------------------

function CaseWidget() {
  const s = usePreflight();
  const now = useNow();
  const item = selectedItem(s);
  // The call-back tick belongs to one row: selecting another row clears it.
  const [calledFor, setCalledFor] = useState<string | null>(null);
  const called = !!item && calledFor === item.rowId;
  const setCalled = (v: boolean) => setCalledFor(v && item ? item.rowId : null);
  if (!item) return <Empty>Select a payout to see its case.</Empty>;
  const payee = s.snapshot?.payees.find((p) => p.id === item.payeeId);
  const inv = item.investigation;
  const left = coolingLeft(item, now);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-semibold text-pp-navy">{item.name}</div>
          <div className="text-pp-muted">{usd(item.amount)} to {item.receiver}</div>
        </div>
        <Badge cls={STATE_STYLE[item.state].cls}>{STATE_STYLE[item.state].label}</Badge>
      </div>

      {inv && (
        <div className={`rounded-xl border p-3 ${inv.verdict === 'likely_fraud' ? 'border-rose-200 bg-gradient-to-br from-rose-50 to-white' : inv.verdict === 'likely_genuine' ? 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white' : 'border-amber-200 bg-gradient-to-br from-amber-50 to-white'}`}>
          <div className="mb-1 flex items-center gap-2">
            <Badge cls={verdictCls[inv.verdict]}>{verdictLabel[inv.verdict]}</Badge>
            <span className="text-xs text-pp-muted">{inv.by === 'ai' ? 'AI investigator · advice only' : 'Rules summary (AI off)'}</span>
          </div>
          <p className="mb-2">{inv.summary}</p>
          <ul className="space-y-1">
            {inv.evidence.map((e, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <code className="shrink-0 rounded bg-pp-highlight px-1 text-[0.625rem] text-pp-blue">{e.source}</code>
                <span>{e.fact}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!inv && item.findings.some((f) => f.code !== 'SENDER_UNVERIFIED') && (
        <ul className="space-y-1 text-xs">{item.findings.map((f, i) => <li key={i}>• {f.message}</li>)}</ul>
      )}

      {item.state === 'held' && item.findings.every((f) => f.severity !== 'hold' || f.code === 'SENDER_UNVERIFIED') && (
        <div className="rounded-lg bg-rose-50 p-3">
          Held only because the request&apos;s sender is suspicious. Check with the real sender (the red banner above the grid): if they
          didn&apos;t send it, <b>Not from them: stop all</b>; if they did, <b>Confirm batch</b> and this row becomes ready to send.
        </div>
      )}
      {item.state === 'held' && item.findings.some((f) => f.severity === 'hold' && f.code !== 'SENDER_UNVERIFIED') && (
        <div className="space-y-2 rounded-lg bg-red-50 p-3">
          <div className="font-semibold text-red-900">Nothing has been sent. What happens next:</div>
          {payee ? (
            <>
              <div>
                1. A one-click check went to the <b>email on file</b> ({payee.email}), not to the address in the request.
                {payee.email.toLowerCase() !== item.receiver.toLowerCase() ? <> Because the payout details are new, a &quot;Yes&quot; also needs the code texted to <b>{payee.phoneOnFile}</b>.</> : ''}
                {item.awaitingCode ? ' The email said yes: waiting for the code.' : item.awaitingPayee ? (s.view === 'demo' ? ' Waiting for the answer (see the payee inbox on the left).' : ' Waiting for the answer.') : ''}
              </div>
              <div>
                2. Or release it yourself after the cooling-off period{left ? <> (<b>{mmss(left)}</b> left)</> : ' (over)'}, once you have called {payee.name.split(' ')[0]} on the number on file: <b>{payee.phoneOnFile}</b>.
              </div>
            </>
          ) : (
            <div>
              <b>{item.name}</b> isn&apos;t on the payee list, so there is no trusted email or phone to check with. Confirm through a channel you
              already trust (not this request&apos;s email), then release it after the cooling-off period{left ? <> (<b>{mmss(left)}</b> left)</> : ' (over)'}.
            </div>
          )}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={called} onChange={(e) => setCalled(e.target.checked)} /> {payee ? 'I called the number on file and they confirmed.' : 'I confirmed through a channel I already trust.'}
          </label>
          <div className="flex gap-2">
            <button className="rounded-md bg-white px-3 py-1 text-xs font-semibold text-pp-navy ring-1 ring-pp-border disabled:opacity-40" disabled={!called || left > 0} onClick={() => actions.release(item.rowId)}>
              Release and send
            </button>
            <button className="rounded-md bg-red-700 px-3 py-1 text-xs font-semibold text-white" onClick={() => actions.stop(item.rowId)}>
              Stop this payout
            </button>
          </div>
        </div>
      )}
      {item.state === 'warn' && !item.acknowledged && (
        <button className="self-start rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-white" onClick={() => actions.acknowledge(item.rowId)}>
          I checked this, send it with the batch
        </button>
      )}
      {item.state === 'denied' && <div className="rounded-lg bg-slate-100 p-3">Stopped. {usd(item.amount)} never left the account.</div>}
      {item.state === 'sent' && (
        <div className="rounded-lg bg-blue-50 p-3">
          Sent through PayPal Payouts{item.paypal?.status ? <>: <b>{item.paypal.status}</b></> : ''}.{' '}
          {item.paypal?.status === 'UNCLAIMED' && 'No account has claimed it yet, so it can still be pulled back.'}
          {item.wallet === 'VENMO' && item.paypal?.walletSent === 'PAYPAL' && (
            <div className="mt-1 text-xs text-pp-muted">The PayPal sandbox doesn&apos;t support Venmo payouts, so this test payout went to the PayPal wallet. Live sends use recipient_wallet VENMO.</div>
          )}
          <div className="mt-1 text-xs text-pp-muted">Batch {item.paypal?.batchId}</div>
        </div>
      )}
    </div>
  );
}

// --- Sender check ---------------------------------------------------------------------------------

/** One sender check as a small card: what was checked, what was found, and what it means. */
function Check({ ok, label, value, meaning }: { ok: boolean | null; label: string; value: string; meaning: string }) {
  const tone = ok === null ? 'border-slate-200 bg-slate-50' : ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/70';
  const icon = ok === null ? 'bg-slate-200 text-slate-600' : ok ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white';
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${tone}`}>
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold ${icon}`} aria-hidden>
        {ok === null ? '?' : ok ? '✓' : '!'}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-pp-muted">{label}</span>
          <span className="break-all text-sm font-medium text-pp-ink">{value}</span>
        </div>
        <div className="text-xs text-pp-muted">{meaning}</div>
      </div>
    </div>
  );
}

function SenderWidget() {
  const s = usePreflight();
  const review = currentReview(s);
  if (!review) return <Empty>The sender check appears here once a request is run.</Empty>;
  const e = review.email;
  const fromOk = !e.lookalikeOf;
  const replyOk = !e.replyToDomain || e.replyToDomain === e.fromDomain;
  const authOk = e.auth ? e.auth.dmarc !== 'fail' && e.auth.spf !== 'fail' && e.auth.dkim !== 'fail' : null;
  const pressureOk = e.urgencyPhrases.length === 0;
  const failed = [e.provided ? fromOk : true, e.provided ? replyOk : true, e.provided ? authOk !== false : true, pressureOk].filter((x) => !x).length;
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[0.9375rem] font-semibold text-pp-navy">Who sent this request?</div>
          <div className="text-xs text-pp-muted">Read from the email&apos;s headers in code, no AI.</div>
        </div>
        {e.provided && (
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${failed ? 'bg-rose-50 text-rose-800 ring-rose-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200'}`}>
            {failed ? `${failed} warning sign${failed === 1 ? '' : 's'}` : 'Looks genuine'}
          </span>
        )}
      </div>
      {!e.provided ? (
        <Check ok={null} label="Headers" value="not provided" meaning="Upload the original .eml so the sender can be checked." />
      ) : (
        <>
          <Check ok={fromOk} label="From" value={e.from ?? 'unknown'} meaning={e.lookalikeOf ? `Lookalike of ${e.lookalikeOf}: one letter changed.` : 'The sender domain looks right.'} />
          <Check ok={replyOk} label="Reply-To" value={e.replyTo ?? 'same as sender'} meaning={replyOk ? 'Replies go back to the sender.' : 'Replies would go somewhere else than the sender.'} />
          <Check
            ok={authOk}
            label="Auth"
            value={e.auth ? `SPF ${e.auth.spf ?? '?'} · DKIM ${e.auth.dkim ?? '?'} · DMARC ${e.auth.dmarc ?? '?'}` : 'not reported'}
            meaning={authOk === false ? "The email failed its domain's security check." : authOk ? 'Passed the domain security checks.' : 'The mail server did not report these checks.'}
          />
        </>
      )}
      <Check
        ok={pressureOk}
        label="Pressure"
        value={pressureOk ? 'none' : e.urgencyPhrases.map((p) => `"${p}"`).join(', ')}
        meaning={pressureOk ? 'No rushing words.' : 'Scam emails rush you so you skip checks.'}
      />
    </div>
  );
}

// --- Rules ----------------------------------------------------------------------------------------

function RulesWidget() {
  const s = usePreflight();
  const [text, setText] = useState('');
  const rules = s.snapshot?.rules ?? [];
  return (
    <div className="flex h-full flex-col gap-2 p-2 text-sm">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
        {rules.map((r) => (
          <div key={r.id} className={`rounded-lg border border-l-4 p-2 shadow-sm ${r.confirmed ? `border-[#dde4ee] bg-white ${r.action === 'hold' ? 'border-l-rose-500' : 'border-l-amber-400'}` : 'border-amber-300 border-l-amber-500 bg-amber-50'}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs italic text-pp-muted">&ldquo;{r.text}&rdquo;</div>
                <div className="font-medium">{r.readBack}</div>
                {r.backtest && (
                  <div className="text-xs text-pp-muted">
                    On the last {r.backtest.pastPayouts - r.backtest.warmupSkipped} payouts it would have {r.action === 'hold' ? `held ${r.backtest.wouldHold}` : `warned on ${r.backtest.wouldWarn}`}.
                    {r.backtest.examples[0] ? ` e.g. ${r.backtest.examples[0]}` : ''}
                  </div>
                )}
              </div>
              {r.confirmed ? (
                <button className="text-xs text-pp-muted hover:text-pp-blue" onClick={() => actions.confirmRule(r.id, false)}>Pause</button>
              ) : (
                <button className="rounded bg-pp-blue px-2 py-0.5 text-xs font-semibold text-white" onClick={() => actions.confirmRule(r.id, true)}>Confirm</button>
              )}
              <button className="text-xs text-pp-muted hover:text-red-700" onClick={() => actions.deleteRule(r.id)} aria-label="Delete rule">✕</button>
            </div>
          </div>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() && (await actions.addRule(text))) setText('');
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-md border border-pp-border px-2 py-1 text-sm"
          placeholder='Add a rule, e.g. "Hold any single payout over $5,000"'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="rounded-md bg-pp-navy px-3 py-1 text-sm font-semibold text-white" disabled={!!s.busy}>Add</button>
      </form>
    </div>
  );
}

// --- Synthetic safety test ------------------------------------------------------------------------

function SafetyTestWidget() {
  const s = usePreflight();
  const r = s.evaluation;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  return (
    <div className="flex h-full flex-col gap-2 p-2 text-sm">
      {!r ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-pp-muted">Replay 500 generated payouts (genuine and fraudulent) through today&apos;s rules.</p>
          <button className="rounded-md bg-pp-navy px-3 py-1.5 font-semibold text-white" onClick={() => actions.evaluate()}>Run the safety test</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-emerald-50 p-2">
              <div className="text-xs text-pp-muted">Genuine, straight through</div>
              <div className="text-xl font-bold text-emerald-800">{pct(r.genuine.instant, r.genuine.n)}</div>
              <div className="text-xs text-pp-muted">{r.genuine.warned} warned · {r.genuine.held} held, of {r.genuine.n}</div>
            </div>
            <div className="rounded-lg bg-red-50 p-2">
              <div className="text-xs text-pp-muted">Fraud caught</div>
              <div className="text-xl font-bold text-red-800">{r.fraud.held + r.fraud.warned} / {r.fraud.n}</div>
              <div className="text-xs text-pp-muted">{r.fraud.missed} missed</div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto text-xs">
            {r.byKind
              .sort((a, b) => a.label.localeCompare(b.label) || b.n - a.n)
              .map((k) => (
                <div key={k.kind} className="flex justify-between border-b border-pp-gridline py-0.5">
                  <span className={k.label === 'fraud' ? 'text-red-800' : ''}>{k.kind}</span>
                  <span className="text-pp-muted">{k.clear} clear · {k.warned} warn · {k.held} held</span>
                </div>
              ))}
          </div>
          <div className="text-[0.6875rem] text-pp-muted">Synthetic data (seed {r.seed}), payout rules only: email header checks not included.</div>
        </>
      )}
    </div>
  );
}

// --- Registration ---------------------------------------------------------------------------------

const custom = (id: string, label: string, comp: React.ComponentType<any>, w: number, h: number) => ({
  id,
  label,
  comp,
  form: (p: any) => p.createDefaults({}),
  defaultSize: { width: w, height: h },
  minSize: { width: Math.min(w, 6), height: 6 },
  toolbar: [],
});

export const PREFLIGHT_WIDGETS = [
  custom('pf-scoreboard', 'Preflight scoreboard', ScoreboardWidget, 24, 7),
  custom('pf-review', 'Payout review', ReviewWidget, 16, 30),
  custom('pf-case', 'Case file', CaseWidget, 8, 20),
  custom('pf-sender', 'Sender check', SenderWidget, 8, 12),
  custom('pf-rules', 'Rules and backtests', RulesWidget, 10, 18),
  custom('pf-safety-test', 'Safety test', SafetyTestWidget, 8, 18),
];

export const preflightWidgets = (widgetConfig: any) =>
  createWidgets({
    additionalTypes: PREFLIGHT_WIDGETS,
    menu: [{ label: 'Preflight', widgetIds: PREFLIGHT_WIDGETS.map((w) => w.id) }, ...widgetConfig.menu],
  } as any);
