'use client';

// The Preflight page: intake and the simulated payee inbox on the left, one AG Studio instance on
// the right holding the Review page (Preflight's custom widgets) and the Risk Control Room
// (AG Studio's own widgets, which the AI can extend).

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgStudioAiModule, type AgReportState, type AgStudioApi, type AgStudioMode } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { actions, preflightStore, usePreflight, type InboxMessage } from './client-store';
import { ChatPopup } from './chat-popup';
import { buildPreflightAi } from './preflight-ai';
import { buildPreflightData } from './studio-data';
import { CONTROL_ROOM_PAGE, REVIEW_PAGE, preflightReport } from './studio-report';
import { gridRowsFor, reviewLayout, useFit, useFitTo, useGridWant } from './fit';
import { fittedTheme } from './theme';
import { preflightWidgets } from './widgets';
import type { Scenario } from '@/lib/preflight/seed';

type Props = {
  licenseKey?: string;
  aiModels?: string[];
  scenarios: Scenario[];
};

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#ffffff" />
      <path d="M7 16.5 25 8l-5.5 17-4.2-6.3L7 16.5Z" fill="var(--pp-blue)" />
      <path d="m15.3 18.7 9.7-10.7" stroke="var(--pp-sky)" strokeWidth="1.6" />
    </svg>
  );
}

function Intake({ scenarios }: { scenarios: Scenario[] }) {
  const s = usePreflight();
  const demo = s.view === 'demo';
  const [text, setText] = useState('');
  const picked = s.scenario;
  const setPicked = actions.setScenario;
  const file = useRef<HTMLInputElement>(null);
  const pick = (id: string) => {
    const sc = scenarios.find((x) => x.id === id) ?? null;
    setPicked(sc);
    setText(sc?.text ?? '');
  };
  const group = (tone: Scenario['tone']) => scenarios.filter((x) => x.tone === tone);
  return (
    <section className="space-y-2.5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-pp-muted">{demo ? '1 · Payment request' : 'New payment request'}</h2>
      <p className="text-xs text-pp-muted">
        {demo ? 'Pick a scenario, paste an email, a list or a CSV, or upload an ' : 'Paste an email, a list or a CSV, or upload the original '}
        <b>.eml</b> so the sender can be checked.
      </p>
      <div className="flex items-center gap-2">
        <div className={`relative flex-1 ${demo ? '' : 'hidden'}`}>
          <span
            className={`pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${
              picked ? (picked.tone === 'fraud' ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'
            }`}
          />
          <select
            aria-label="Scenario"
            className="w-full cursor-pointer appearance-none rounded-lg border border-pp-border bg-white py-2 pl-6 pr-6 text-[0.7812rem] font-medium text-pp-navy shadow-sm transition hover:border-pp-blue focus:border-pp-blue focus:outline-none focus:ring-2 focus:ring-pp-blue/20"
            value={picked?.id ?? ''}
            onChange={(e) => pick(e.target.value)}
          >
            <option value="">Choose a scenario…</option>
            <optgroup label="Fraud scenarios">
              {group('fraud').map((sc) => <option key={sc.id} value={sc.id}>{sc.label}</option>)}
            </optgroup>
            <optgroup label="Genuine">
              {group('genuine').map((sc) => <option key={sc.id} value={sc.id}>{sc.label}</option>)}
            </optgroup>
          </select>
          <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-pp-muted" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <button
          title="Upload an .eml (so the sender can be checked) or a .csv"
          aria-label="Upload .eml or .csv"
          className={`flex h-[2.4rem] shrink-0 items-center justify-center gap-2 rounded-lg border border-pp-border bg-white text-pp-blue shadow-sm transition hover:border-pp-blue ${demo ? 'w-[2.4rem]' : 'flex-1 text-sm font-semibold'}`}
          onClick={() => file.current?.click()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 10.5V2.5M4.75 5.75 8 2.5l3.25 3.25M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {!demo && 'Upload .eml or .csv'}
        </button>
        <input
          ref={file}
          type="file"
          accept=".eml,.txt,.csv,message/rfc822,text/plain,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setText(await f.text());
              setPicked(null);
            }
            e.target.value = '';
          }}
        />
      </div>
      <textarea
        className="h-40 w-full resize-y rounded-md border border-pp-border bg-white p-2 font-mono text-[0.6875rem] leading-snug"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPicked(null);
        }}
        placeholder="Hi Dana, please pay this week's freelancers…"
      />
      <button
        className="w-full rounded-lg bg-gradient-to-r from-[#003087] to-[#0070e0] py-2 text-sm font-semibold text-white shadow-sm transition hover:shadow-md disabled:opacity-40"
        disabled={!text.trim() || !!s.busy}
        onClick={() => actions.runPreflight(text)}
      >
        Run Preflight
      </button>
    </section>
  );
}

function InboxCard({ m }: { m: InboxMessage }) {
  const s = usePreflight();
  const [code, setCode] = useState('');
  return (
    <div className="space-y-2">
      <div className="space-y-2 rounded-md border border-pp-border bg-white p-2">
        <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-pp-muted">✉ Email to the address on file</div>
        <pre className="whitespace-pre-wrap font-sans text-[0.6875rem] leading-snug">{m.message.replace('{verify_link}', '').trim()}</pre>
        {!m.sms ? (
          <div className="flex gap-2">
            <button className="flex-1 rounded bg-emerald-600 py-1 text-xs font-semibold text-white" disabled={!!s.busy} onClick={() => actions.answer(m.token, 'yes')}>
              Yes, that&apos;s me
            </button>
            <button className="flex-1 rounded bg-red-700 py-1 text-xs font-semibold text-white" disabled={!!s.busy} onClick={() => actions.answer(m.token, 'no')}>
              No, not me
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 rounded bg-amber-50 p-2 text-[0.6875rem] ring-1 ring-amber-200">
            <div>
              Answered <b>Yes</b>, but these are <b>new payout details</b>, so email alone isn&apos;t enough (the mailbox itself could be hacked). Enter
              the code texted to the phone on file:
            </div>
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-pp-border px-2 py-1 font-mono text-xs tracking-widest"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <button className="rounded bg-pp-navy px-3 py-1 text-xs font-semibold text-white disabled:opacity-40" disabled={code.length !== 6 || !!s.busy} onClick={() => actions.enterCode(m.token, code)}>
                Confirm
              </button>
            </div>
          </div>
        )}
      </div>
      {m.sms && (
        <div className="ml-6 space-y-2 rounded-2xl bg-slate-900 p-2.5 text-white shadow-md">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wide text-slate-400">📱 Text to the phone on file · {m.sms.phone}</div>
          <div className="rounded-xl rounded-tl-sm bg-slate-700 px-2.5 py-1.5 text-[0.6875rem] leading-snug">{m.sms.text}</div>
          <button className="w-full rounded-lg bg-red-600 py-1 text-xs font-semibold text-white" disabled={!!s.busy} onClick={() => actions.answer(m.token, 'no')}>
            Not me: stop it
          </button>
        </div>
      )}
    </div>
  );
}

function Inbox() {
  const s = usePreflight();
  if (s.view === 'product') return <AwaitingPayees />;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-pp-muted">2 · Payee inbox (simulated)</h2>
      <p className="text-xs text-pp-muted">
        What each held payee receives at the email and phone <b>on file</b>. Delivery isn&apos;t wired up in this demo, so you answer for them here.
      </p>
      {s.inbox.length === 0 && <div className="rounded-md border border-dashed border-pp-border p-3 text-xs text-pp-muted">No checks waiting.</div>}
      {s.inbox.map((m) => <InboxCard key={m.token} m={m} />)}
    </section>
  );
}

/** Product view: what the owner sees while payees are being asked (no simulated inbox). */
function AwaitingPayees() {
  const s = usePreflight();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-pp-muted">Waiting on payees</h2>
      <p className="text-xs text-pp-muted">Checks go to each payee&apos;s email and phone <b>on file</b>. Their answers update the batch on their own.</p>
      {s.inbox.length === 0 && <div className="rounded-md border border-dashed border-pp-border p-3 text-xs text-pp-muted">Nobody to wait for.</div>}
      {s.inbox.map((m) => (
        <div key={m.token} className="space-y-1 rounded-md border border-pp-border bg-white p-2.5 text-xs">
          <div className="flex items-center justify-between">
            <b className="text-pp-navy">{m.name}</b>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-amber-800 ring-1 ring-amber-200">{m.sms ? 'Code texted' : 'Email sent'}</span>
          </div>
          <div className="text-pp-muted">✉ {m.message.split('\n')[0].replace('To: ', '')}</div>
          {m.sms && <div className="text-pp-muted">📱 {m.sms.phone}: email said yes, waiting for the code</div>}
        </div>
      ))}
    </section>
  );
}

/** Demo mode's strip: the picked scenario in one line with its next step, details on demand. */
function DemoStrip({ payouts }: { payouts?: string }) {
  const s = usePreflight();
  const sc = s.scenario;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const fraud = sc?.tone === 'fraud';
  return (
    <div ref={box} className="relative z-30 flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-1 text-xs text-amber-900">
      <span className="shrink-0 rounded bg-amber-200/70 px-1.5 py-px text-[0.6875rem] font-bold uppercase tracking-wide">Demo</span>
      {sc ? (
        <>
          <span className={`shrink-0 rounded-full px-2 py-px text-[0.6875rem] font-semibold ring-1 ${fraud ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-emerald-50 text-emerald-700 ring-emerald-200'}`}>
            {sc.label}
          </span>
          <span className="min-w-0 truncate">
            {sc.short} <b>Next:</b> {sc.next}
          </span>
          <button className="ml-auto shrink-0 font-semibold underline underline-offset-2" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide details' : 'Details'}
          </button>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">
            Payee emails and texts are simulated in the left panel, so you can answer as the payee.{' '}
            {payouts === 'sandbox' ? 'Payouts go to the PayPal sandbox.' : 'PayPal is simulated (no keys).'} Pick a scenario to start.
          </span>
          <button className="ml-auto shrink-0 font-semibold underline underline-offset-2" onClick={() => actions.setView('product')}>
            See the product view
          </button>
        </>
      )}
      {sc && open && (
        <div className="absolute right-4 top-full mt-2 w-[26rem] overflow-hidden rounded-xl border border-pp-border bg-white text-[0.75rem] leading-snug text-pp-ink shadow-xl" role="dialog" aria-label={`${sc.label} scenario`}>
          <div className={`flex items-start gap-2 px-4 py-3 ${fraud ? 'bg-rose-50' : 'bg-emerald-50'}`}>
            <div className="min-w-0 flex-1">
              <div className={`text-[0.6875rem] font-semibold uppercase tracking-wide ${fraud ? 'text-rose-700' : 'text-emerald-700'}`}>
                {fraud ? 'Fraud scenario' : 'Genuine'} · {sc.label}
              </div>
              <div className="mt-1 text-pp-navy">{sc.story}</div>
            </div>
            <button className="text-pp-muted hover:text-pp-ink" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <dl className="space-y-2 px-4 py-3">
            <div className="flex gap-3">
              <dt className="w-12 shrink-0 font-semibold text-pp-muted">Expect</dt>
              <dd>{sc.expect}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-12 shrink-0 font-semibold text-pp-muted">Then</dt>
              <dd>{sc.play}</dd>
            </div>
          </dl>
          <div className="border-t border-pp-gridline px-4 py-2 text-[0.6875rem] text-pp-muted">
            Click Reset demo between scenarios so earlier payouts don&apos;t count as recent history.
          </div>
        </div>
      )}
    </div>
  );
}

function Audit() {
  const s = usePreflight();
  const [open, setOpen] = useState(false);
  const events = s.snapshot?.audit ?? [];
  return (
    <section>
      <button className="text-sm font-semibold uppercase tracking-wide text-pp-muted" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Audit log ({events.length})
      </button>
      {open && (
        <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-[0.6875rem]">
          {events.map((e, i) => (
            <li key={i} className="border-b border-pp-gridline pb-1">
              <span className="text-pp-muted">{new Date(e.at).toLocaleTimeString('en-US')}</span> <b>{e.action.replaceAll('_', ' ')}</b> · {e.detail}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Toast() {
  const s = usePreflight();
  if (!s.busy && !s.error && !s.notice) return null;
  const cls = s.error ? 'bg-red-700' : s.busy ? 'bg-pp-navy' : 'bg-emerald-700';
  return (
    <div className={`fixed bottom-4 left-1/2 z-50 flex max-w-xl -translate-x-1/2 items-center gap-3 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${cls}`}>
      <span>{s.error ?? (s.busy ? `${s.busy}…` : s.notice)}</span>
      {!s.busy && <button className="text-white/80" onClick={() => preflightStore.dismiss()}>✕</button>}
    </div>
  );
}

export function PreflightApp({ licenseKey, aiModels, scenarios }: Props) {
  const s = usePreflight();
  const apiRef = useRef<AgStudioApi | null>(null);
  const [page, setPage] = useState(REVIEW_PAGE);
  const [mode, setMode] = useState<AgStudioMode>('view');
  const [initialState] = useState<AgReportState>(() => preflightReport);
  const ai = useMemo(() => (aiModels?.length ? buildPreflightAi(aiModels) : undefined), [aiModels]);
  const studioData = useMemo(() => (s.snapshot ? buildPreflightData(s.snapshot) : null), [s.snapshot]);
  const mainRef = useRef<HTMLElement>(null);
  useFitTo(mainRef);
  const fit = useFit();
  const theme = useMemo(() => fittedTheme(fit.rowHeight, fit.scale), [fit.rowHeight, fit.scale]);
  // The batch grid takes the height its rows need (up to 8, then it scrolls); the case file and
  // sender check get the rest. Only in view mode, so a layout edited by hand is left alone.
  const gridWant = useGridWant();
  const [apiReady, setApiReady] = useState(false);
  useEffect(() => {
    const api = apiRef.current;
    if (!api || mode !== 'view') return;
    const layout = reviewLayout(gridRowsFor(gridWant, fit), fit);
    const state = api.getState();
    const review = state.pages?.find((p) => p.id === REVIEW_PAGE);
    if (!review || JSON.stringify(review.widgetLayout) === JSON.stringify(layout)) return;
    api.setState({
      ...state,
      pages: state.pages!.map((p) => (p.id === REVIEW_PAGE ? ({ ...p, widgetLayout: layout } as typeof p) : p)),
    });
  }, [gridWant, fit, mode, apiReady]);

  useEffect(() => {
    actions.load();
  }, []);
  useEffect(() => {
    if (!s.notice) return;
    const t = setTimeout(() => preflightStore.dismiss(), 4000);
    return () => clearTimeout(t);
  }, [s.notice]);

  const goTo = (id: string) => {
    setPage(id);
    const api = apiRef.current;
    if (api) api.setState({ ...api.getState(), selectedPageId: id });
  };

  const mode$ = s.snapshot?.mode;
  return (
    <div className="flex h-screen flex-col bg-pp-canvas font-paypal text-pp-ink">
      <header className="flex items-center gap-3 bg-gradient-to-r from-[#001c64] via-[#003087] to-[#0070e0] px-5 py-2.5 text-white shadow-md">
        <Logo />
        <div>
          <div className="text-lg font-bold leading-none text-white">Preflight</div>
          <div className="text-[0.6875rem] text-white/70">for PayPal Payouts</div>
        </div>
        <span className="ml-3 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white ring-1 ring-white/30">{s.snapshot?.org.name ?? '…'}</span>
        {mode$ && (
          <>
            <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${mode$.payouts === 'sandbox' ? 'bg-emerald-400/20 text-emerald-100 ring-1 ring-emerald-300/50' : 'bg-amber-400/20 text-amber-100 ring-1 ring-amber-300/50'}`}>
              {mode$.payouts === 'sandbox' ? 'PayPal sandbox' : 'Simulated PayPal (no keys)'}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${mode$.ai === 'openai' ? 'bg-emerald-400/20 text-emerald-100 ring-1 ring-emerald-300/50' : 'bg-amber-400/20 text-amber-100 ring-1 ring-amber-300/50'}`}>
              {mode$.ai === 'openai' ? 'AI on' : 'AI off: rules only'}
            </span>
          </>
        )}
        <div className="ml-4 flex rounded-lg bg-white/10 p-0.5 ring-1 ring-white/25" role="tablist" aria-label="View">
          {(
            [
              ['demo', 'Demo', 'Simulation: scenarios, and you answer as the payee'],
              ['product', 'Product', 'What a business sees, with no simulation controls'],
            ] as const
          ).map(([v, label, hint]) => (
            <button
              key={v}
              role="tab"
              aria-selected={s.view === v}
              title={hint}
              onClick={() => actions.setView(v)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition ${s.view === v ? 'bg-white text-pp-navy shadow-sm' : 'text-white/75 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <nav className="ml-auto flex gap-1">
          {[
            [REVIEW_PAGE, 'Review'],
            [CONTROL_ROOM_PAGE, 'Risk Control Room'],
          ].map(([id, label]) => (
            <button key={id} onClick={() => goTo(id)} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${page === id ? 'bg-white text-pp-navy shadow-sm' : 'text-white/80 hover:bg-white/10 hover:text-white'}`}>
              {label}
            </button>
          ))}
        </nav>
        <button className="rounded-md px-3 py-1.5 text-sm font-semibold text-white ring-1 ring-white/40 hover:bg-white/10" onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}>
          {mode === 'view' ? 'Edit layout' : 'Done editing'}
        </button>
        {s.view === 'demo' && (
          <button className="rounded-md px-3 py-1.5 text-sm font-semibold text-white/70 hover:text-white" onClick={() => actions.reset()}>
            Reset demo
          </button>
        )}
      </header>
      {s.view === 'demo' && <DemoStrip payouts={mode$?.payouts} />}
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 space-y-4 overflow-auto border-r border-[#dde4ee] bg-[#eef2f8] p-3 [&>section]:rounded-xl [&>section]:border [&>section]:border-[#dde4ee] [&>section]:bg-white [&>section]:p-3 [&>section]:shadow-sm">
          <Intake scenarios={scenarios} />
          <Inbox />
          <Audit />
        </aside>
        <main ref={mainRef} className="min-w-0 flex-1">
          {studioData ? (
            <AgStudioProvider licenseKey={licenseKey} modules={ai ? [AgStudioAiModule] : undefined}>
              <AgStudio
                style={{ height: '100%', width: '100%' }}
                theme={theme}
                layout={{ widgetBorderEnabled: true }}
                // View mode shows no side panels (Preflight has no page filters); edit mode adds the
                // AI chat on the right, next to Studio's widget editor, with the data panel on the left.
                panels={{ view: { right: [] }, edit: { left: ['data'], right: ai ? ['ai', 'edit'] : ['edit'] } }}
                data={studioData}
                widgets={preflightWidgets as never}
                ai={ai}
                initialState={initialState}
                mode={mode}
                onApiReady={(e) => {
                  apiRef.current = e.api;
                  setApiReady(true);
                  // Build the AI harness now, so the pop-up chat works without opening Studio's panel.
                  if (typeof ai === 'function') ai({ api: e.api } as Parameters<typeof ai>[0]);
                }}
                onStateUpdated={(e) => setPage(e.state.selectedPageId ?? REVIEW_PAGE)}
              />
            </AgStudioProvider>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-pp-muted">{s.error ?? 'Loading Preflight…'}</div>
          )}
        </main>
      </div>
      <Toast />
      {ai && <ChatPopup />}
    </div>
  );
}
