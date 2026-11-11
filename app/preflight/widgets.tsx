'use client';

// Preflight's custom AG Studio widgets. Each one reads the shared client store (client-store.ts),
// so an action in one widget (editing a row, a payee's answer, a PayPal status change) redraws
// them all. They render inside Studio's canvas, theme and edit mode like its built-in widgets.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useMemo, useState } from 'react';
import { AllCommunityModule, type ColDef, type ICellRendererParams } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { studioGridTheme } from 'ag-studio';
import { createWidgets } from 'ag-studio-react';
import type { Snapshot } from '@/lib/preflight/snapshot';
import { actions, currentReview, preflightStore, selectedItem, usePreflight } from './client-store';

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

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center rounded-lg border border-pp-border bg-white px-4 py-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-pp-muted">{label}</div>
      <div className={`text-2xl font-bold ${tone}`}>{value}</div>
      <div className="truncate text-xs text-pp-muted">{sub}</div>
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
      <Tile
        label="Went straight through"
        value={k.instantShare === null ? '–' : `${Math.round(k.instantShare * 100)}%`}
        sub="of decided payouts, with no waiting"
        tone="text-emerald-700"
      />
      <Tile label="Held right now" value={usd(k.heldAmount)} sub={`${k.held} payout${k.held === 1 ? '' : 's'} waiting for the payee`} tone="text-red-700" />
      <Tile label="Fraud stopped" value={usd(k.protectedAmount)} sub="never left Brightline's PayPal" tone="text-pp-navy" />
      <Tile label="Trusted payees" value={`${trusted} / ${s.snapshot.payees.length}`} sub="verify once, then straight through" tone="text-pp-blue" />
    </div>
  );
}

// --- Payout review grid ---------------------------------------------------------------------------

function StateCell({ data, node }: ICellRendererParams<Item>) {
  if (!data || node.rowPinned) return null;
  const st = STATE_STYLE[data.state];
  return <Badge cls={st.cls}>{st.label}</Badge>;
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
        return <rect key={i} x={i * (bw + 2)} y={h - bh} width={bw} height={bh} rx={1} fill={today ? (unusual ? 'var(--pp-danger)' : 'var(--pp-blue)') : '#b8c4d6'} />;
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
          <span key={i} title={f.message} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ${cls}`}>
            {label}
          </span>
        );
      })}
      {data.findings.length > 4 && <span className="px-1 text-[11px] text-pp-muted" title={data.findings.slice(4).map((f) => f.message).join('\n')}>+{data.findings.length - 4} more</span>}
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
    return <span className="text-xs text-red-800">{data.awaitingPayee ? 'waiting for payee' : 'held'}{left ? ` · ${mmss(left)}` : ''}</span>;
  }
  if (data.state === 'sent' && data.paypal?.status === 'UNCLAIMED')
    return <button className={`${btn} bg-white text-slate-800 ring-slate-300 hover:bg-slate-50`} onClick={() => actions.pullBack(data.rowId)}>Pull back</button>;
  if (data.state === 'sent' && data.releasedBy) return <span className="text-xs text-blue-800">released by {data.releasedBy}</span>;
  return null;
}

function ReviewWidget() {
  const s = usePreflight();
  const review = currentReview(s);
  const rules = s.snapshot?.rules ?? [];

  const columns = useMemo<ColDef<Item>[]>(
    () => [
      { headerName: 'Preflight', field: 'state', cellRenderer: StateCell, width: 104, editable: false },
      { headerName: 'Payee', field: 'name', editable: (p) => p.data?.state !== 'sent' && p.data?.state !== 'denied', width: 130 },
      {
        headerName: 'Send to',
        field: 'receiver',
        flex: 1,
        minWidth: 190,
        editable: (p) => p.data?.state !== 'sent' && p.data?.state !== 'denied',
        tooltipValueGetter: (p) => (p.data?.receiverSource === 'on_file' ? 'Email on file (the request named the payee only)' : 'Email written in the request'),
        valueFormatter: (p) =>
          `${p.value}${p.data?.wallet === 'VENMO' ? (p.data.paypal?.walletSent === 'PAYPAL' ? '  · Venmo → PayPal (sandbox)' : '  · Venmo') : ''}`,
      },
      {
        headerName: 'Amount',
        field: 'amount',
        width: 112,
        type: 'rightAligned',
        editable: (p) => p.data?.state !== 'sent' && p.data?.state !== 'denied',
        cellEditor: 'agNumberCellEditor',
        valueFormatter: (p) => (typeof p.value === 'number' ? usd(p.value) : ''),
      },
      { headerName: 'Last 10 + today', colId: 'history', cellRenderer: HistoryCell, width: 136, sortable: false },
      { headerName: 'Signals', colId: 'signals', cellRenderer: SignalsCell, flex: 1.2, minWidth: 200, autoHeight: true, wrapText: true, sortable: false },
      { headerName: 'PayPal', colId: 'paypal', valueGetter: (p) => p.data?.paypal?.status ?? '', cellRenderer: PayPalCell, width: 116, enableCellChangeFlash: true },
      { headerName: '', colId: 'action', cellRenderer: ActionCell, width: 176, sortable: false },
    ],
    [],
  );

  if (!review) return <Empty>Paste or upload a payment request on the left, then press <b className="mx-1">Run Preflight</b>.</Empty>;

  const ready = review.items.filter((i) => i.state === 'clear' || (i.state === 'warn' && i.acknowledged));
  const sum = (xs: Item[]) => xs.reduce((t, i) => t + i.amount, 0);
  const totals = {
    rowId: 'totals', name: 'Batch total', receiver: `${review.items.length} payouts`, amount: sum(review.items),
  } as unknown as Item;
  const waitingWarnings = review.items.filter((i) => i.state === 'warn' && !i.acknowledged).length;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-pp-navy">This week&apos;s batch</span>
        <span className="text-pp-muted">
          {review.items.length} payouts from {review.source === 'email' ? 'an email' : review.source === 'csv' ? 'a CSV' : 'pasted text'} · read by {review.extractedBy === 'ai' ? 'AI, checked against the text' : 'parser'}
        </span>
        {review.aiNote && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">{review.aiNote}</span>}
        <span className="ml-auto text-xs text-pp-muted">
          Ready {usd(sum(ready))} · Held {usd(sum(review.items.filter((i) => i.state === 'held')))} · Sent {usd(sum(review.items.filter((i) => i.state === 'sent')))}
        </span>
        <button
          className="rounded-md bg-pp-blue px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
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
      <div className="min-h-0 flex-1">
        <AgGridProvider modules={modules}>
          <AgGridReact<Item>
            theme={studioGridTheme}
            rowData={review.items}
            columnDefs={columns}
            context={{ rules }}
            getRowId={(p) => p.data.rowId}
            pinnedBottomRowData={[totals]}
            rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
            onRowClicked={(e) => e.data && e.data.rowId !== 'totals' && preflightStore.select(e.data.rowId)}
            onCellValueChanged={(e) => {
              if (!e.data || e.data.rowId === 'totals' || e.newValue === e.oldValue) return;
              const field = e.colDef.field as 'amount' | 'receiver' | 'name';
              actions.edit(e.data.rowId, { [field]: field === 'amount' ? Number(e.newValue) : String(e.newValue) });
            }}
            getRowClass={(p) => (p.node.rowPinned ? 'font-semibold' : p.data?.rowId === s.selectedRowId ? 'ag-row-selected' : '')}
            tooltipShowDelay={300}
            singleClickEdit={false}
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
  const [called, setCalled] = useState(false);
  useEffect(() => setCalled(false), [item?.rowId]);
  if (!item) return <Empty>Select a payout to see its case.</Empty>;
  const payee = s.snapshot?.payees.find((p) => p.id === item.payeeId);
  const inv = item.investigation;
  const left = coolingLeft(item, now);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto pr-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-semibold text-pp-navy">{item.name}</div>
          <div className="text-pp-muted">{usd(item.amount)} to {item.receiver}</div>
        </div>
        <Badge cls={STATE_STYLE[item.state].cls}>{STATE_STYLE[item.state].label}</Badge>
      </div>

      {inv && (
        <div className="rounded-lg border border-pp-border p-3">
          <div className="mb-1 flex items-center gap-2">
            <Badge cls={verdictCls[inv.verdict]}>{verdictLabel[inv.verdict]}</Badge>
            <span className="text-xs text-pp-muted">{inv.by === 'ai' ? 'AI investigator · advice only' : 'Rules summary (AI off)'}</span>
          </div>
          <p className="mb-2">{inv.summary}</p>
          <ul className="space-y-1">
            {inv.evidence.map((e, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <code className="shrink-0 rounded bg-pp-highlight px-1 text-[10px] text-pp-blue">{e.source}</code>
                <span>{e.fact}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!inv && item.findings.length > 0 && (
        <ul className="space-y-1 text-xs">{item.findings.map((f, i) => <li key={i}>• {f.message}</li>)}</ul>
      )}

      {item.state === 'held' && (
        <div className="space-y-2 rounded-lg bg-red-50 p-3">
          <div className="font-semibold text-red-900">Nothing has been sent. What happens next:</div>
          {payee ? (
            <>
              <div>
                1. A one-click check went to the <b>email on file</b> ({payee.email}), not to the address in the request.
                {item.awaitingPayee ? ' Waiting for the answer (see the payee inbox on the left).' : ''}
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

function Line({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className={ok === null ? 'text-pp-muted' : ok ? 'text-emerald-700' : 'text-red-700'}>{ok === null ? '○' : ok ? '✓' : '✗'}</span>
      <span className="w-16 shrink-0 text-pp-muted">{label}</span>
      <span className="min-w-0 break-all">{value}</span>
    </div>
  );
}

function SenderWidget() {
  const s = usePreflight();
  const review = currentReview(s);
  if (!review) return <Empty>The sender check appears here.</Empty>;
  const e = review.email;
  return (
    <div className="flex h-full flex-col gap-1 overflow-auto">
      <div className="text-sm font-semibold text-pp-navy">Who sent this request? <span className="font-normal text-pp-muted">(checked in code)</span></div>
      {!e.provided ? (
        <div className="text-xs text-pp-muted">No email headers were provided, so the sender could not be checked. Upload the original .eml to check it.</div>
      ) : (
        <>
          <Line ok={!e.lookalikeOf} label="From" value={`${e.from}${e.lookalikeOf ? ` (imitates ${e.lookalikeOf})` : ''}`} />
          <Line ok={!e.replyToDomain || e.replyToDomain === e.fromDomain} label="Reply-To" value={e.replyTo ?? 'same as sender'} />
          <Line ok={e.auth ? e.auth.dmarc !== 'fail' && e.auth.spf !== 'fail' && e.auth.dkim !== 'fail' : null} label="Auth" value={e.auth ? `SPF ${e.auth.spf ?? '?'} · DKIM ${e.auth.dkim ?? '?'} · DMARC ${e.auth.dmarc ?? '?'}` : 'not reported'} />
        </>
      )}
      <Line ok={e.urgencyPhrases.length === 0} label="Pressure" value={e.urgencyPhrases.length ? e.urgencyPhrases.map((p) => `"${p}"`).join(', ') : 'none'} />
    </div>
  );
}

// --- Rules ----------------------------------------------------------------------------------------

function RulesWidget() {
  const s = usePreflight();
  const [text, setText] = useState('');
  const rules = s.snapshot?.rules ?? [];
  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
        {rules.map((r) => (
          <div key={r.id} className={`rounded-lg border p-2 ${r.confirmed ? 'border-pp-border' : 'border-amber-300 bg-amber-50'}`}>
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
    <div className="flex h-full flex-col gap-2 text-sm">
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
          <div className="text-[11px] text-pp-muted">Synthetic data (seed {r.seed}), payout rules only: email header checks not included.</div>
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
