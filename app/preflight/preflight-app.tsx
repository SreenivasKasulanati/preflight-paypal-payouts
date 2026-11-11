'use client';

// The Preflight page: intake and the simulated payee inbox on the left, one AG Studio instance on
// the right holding the Review page (Preflight's custom widgets) and the Risk Control Room
// (AG Studio's own widgets, which the AI can extend).

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgStudioAiModule, type AgReportState, type AgStudioApi, type AgStudioMode } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { actions, preflightStore, usePreflight } from './client-store';
import { buildPreflightAi } from './preflight-ai';
import { buildPreflightData } from './studio-data';
import { CONTROL_ROOM_PAGE, REVIEW_PAGE, preflightReport } from './studio-report';
import { preflightTheme } from './theme';
import { preflightWidgets } from './widgets';

type Props = {
  licenseKey?: string;
  aiModels?: string[];
  samples: { fraud: string; genuine: string; csv: string };
};

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--pp-navy)" />
      <path d="M7 16.5 25 8l-5.5 17-4.2-6.3L7 16.5Z" fill="#fff" />
      <path d="m15.3 18.7 9.7-10.7" stroke="var(--pp-sky)" strokeWidth="1.6" />
    </svg>
  );
}

function Intake({ samples }: { samples: Props['samples'] }) {
  const s = usePreflight();
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const sample = (label: string, value: string) => (
    <button className="rounded-md px-2 py-1 text-xs font-semibold text-pp-blue ring-1 ring-pp-border hover:bg-pp-highlight" onClick={() => setText(value)}>
      {label}
    </button>
  );
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-pp-muted">1 · Payment request</h2>
      <p className="text-xs text-pp-muted">Paste an email, a list or a CSV, or upload the original <b>.eml</b> so the sender can be checked.</p>
      <div className="flex flex-wrap gap-1">
        {sample('Suspicious email', samples.fraud)}
        {sample('Genuine email', samples.genuine)}
        {sample('CSV', samples.csv)}
        <button className="rounded-md px-2 py-1 text-xs font-semibold text-pp-blue ring-1 ring-pp-border hover:bg-pp-highlight" onClick={() => file.current?.click()}>
          Upload .eml / .csv
        </button>
        <input
          ref={file}
          type="file"
          accept=".eml,.txt,.csv,message/rfc822,text/plain,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await f.text());
            e.target.value = '';
          }}
        />
      </div>
      <textarea
        className="h-48 w-full resize-y rounded-md border border-pp-border bg-white p-2 font-mono text-[11px] leading-snug"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Hi Dana, please pay this week's freelancers…"
      />
      <button
        className="w-full rounded-md bg-pp-blue py-2 text-sm font-semibold text-white disabled:opacity-40"
        disabled={!text.trim() || !!s.busy}
        onClick={() => actions.runPreflight(text)}
      >
        Run Preflight
      </button>
    </section>
  );
}

function Inbox() {
  const s = usePreflight();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-pp-muted">2 · Payee inbox (simulated)</h2>
      <p className="text-xs text-pp-muted">
        What each held payee receives at the email <b>on file</b>. Email delivery isn&apos;t wired up in this demo, so you answer for them here.
      </p>
      {s.inbox.length === 0 && <div className="rounded-md border border-dashed border-pp-border p-3 text-xs text-pp-muted">No checks waiting.</div>}
      {s.inbox.map((m) => (
        <div key={m.token} className="space-y-2 rounded-md border border-pp-border bg-white p-2">
          <pre className="whitespace-pre-wrap font-sans text-[11px] leading-snug">{m.message.replace('{verify_link}', '').trim()}</pre>
          <div className="flex gap-2">
            <button className="flex-1 rounded bg-emerald-600 py-1 text-xs font-semibold text-white" disabled={!!s.busy} onClick={() => actions.answer(m.token, 'yes')}>
              Yes, that&apos;s me
            </button>
            <button className="flex-1 rounded bg-red-700 py-1 text-xs font-semibold text-white" disabled={!!s.busy} onClick={() => actions.answer(m.token, 'no')}>
              No, not me
            </button>
          </div>
        </div>
      ))}
    </section>
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
        <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-[11px]">
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

export function PreflightApp({ licenseKey, aiModels, samples }: Props) {
  const s = usePreflight();
  const apiRef = useRef<AgStudioApi | null>(null);
  const [page, setPage] = useState(REVIEW_PAGE);
  const [mode, setMode] = useState<AgStudioMode>('view');
  const [initialState] = useState<AgReportState>(() => preflightReport);
  const ai = useMemo(() => (aiModels?.length ? buildPreflightAi(aiModels) : undefined), [aiModels]);
  const studioData = useMemo(() => (s.snapshot ? buildPreflightData(s.snapshot) : null), [s.snapshot]);

  useEffect(() => {
    actions.load();
  }, []);
  useEffect(() => {
    if (!s.notice) return;
    const t = setTimeout(() => preflightStore.dismiss(), 4000);
    return () => clearTimeout(t);
  }, [s.notice]);

  const pendingChat = useRef(false);
  // Chat open, the data and widget panels folded away so the canvas keeps its room.
  const openChat = () => {
    pendingChat.current = false;
    const api = apiRef.current;
    if (!api) return;
    const st = api.getState();
    api.setState({
      ...st,
      panels: { ...st.panels, ai: { ...st.panels?.ai, collapsed: false }, data: { ...st.panels?.data, collapsed: true }, edit: { ...st.panels?.edit, collapsed: true } },
    });
  };
  useEffect(() => {
    if (mode !== 'edit' || !pendingChat.current) return;
    const t = setTimeout(openChat, 100);
    return () => clearTimeout(t);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (id: string) => {
    setPage(id);
    const api = apiRef.current;
    if (api) api.setState({ ...api.getState(), selectedPageId: id });
  };

  const mode$ = s.snapshot?.mode;
  return (
    <div className="flex h-screen flex-col bg-pp-canvas font-paypal text-pp-ink">
      <header className="flex items-center gap-3 border-b border-pp-border bg-white px-5 py-2.5">
        <Logo />
        <div>
          <div className="text-lg font-bold leading-none text-pp-navy">Preflight</div>
          <div className="text-[11px] text-pp-muted">for PayPal Payouts</div>
        </div>
        <span className="ml-3 rounded-full bg-pp-highlight px-2.5 py-0.5 text-xs font-semibold text-pp-navy">{s.snapshot?.org.name ?? '…'}</span>
        {mode$ && (
          <>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${mode$.payouts === 'sandbox' ? 'text-emerald-800 ring-emerald-300' : 'text-amber-800 ring-amber-300'}`}>
              {mode$.payouts === 'sandbox' ? 'PayPal sandbox' : 'Simulated PayPal (no keys)'}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${mode$.ai === 'openai' ? 'text-emerald-800 ring-emerald-300' : 'text-amber-800 ring-amber-300'}`}>
              {mode$.ai === 'openai' ? 'AI on' : 'AI off: rules only'}
            </span>
          </>
        )}
        <nav className="ml-auto flex gap-1">
          {[
            [REVIEW_PAGE, 'Review'],
            [CONTROL_ROOM_PAGE, 'Risk Control Room'],
          ].map(([id, label]) => (
            <button key={id} onClick={() => goTo(id)} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${page === id ? 'bg-pp-highlight text-pp-blue' : 'text-pp-muted hover:text-pp-navy'}`}>
              {label}
            </button>
          ))}
        </nav>
        {ai && (
          <button
            className="rounded-md bg-pp-navy px-3 py-1.5 text-sm font-semibold text-white"
            onClick={() => {
              // Studio shows its AI chat panel in edit mode: switch, then open the chat once the
              // mode change has landed (see the effect above).
              pendingChat.current = true;
              if (mode === 'edit') openChat();
              else setMode('edit');
            }}
          >
            Ask Preflight AI
          </button>
        )}
        <button className="rounded-md px-3 py-1.5 text-sm font-semibold text-pp-muted ring-1 ring-pp-border hover:text-pp-navy" onClick={() => setMode(mode === 'view' ? 'edit' : 'view')}>
          {mode === 'view' ? 'Edit layout' : 'Done editing'}
        </button>
        <button className="rounded-md px-3 py-1.5 text-sm font-semibold text-pp-muted hover:text-red-700" onClick={() => actions.reset()}>
          Reset demo
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 space-y-6 overflow-auto border-r border-pp-border bg-pp-canvas p-4">
          <Intake samples={samples} />
          <Inbox />
          <Audit />
        </aside>
        <main className="min-w-0 flex-1">
          {studioData ? (
            <AgStudioProvider licenseKey={licenseKey} modules={ai ? [AgStudioAiModule] : undefined}>
              <AgStudio
                style={{ height: '100%', width: '100%' }}
                theme={preflightTheme}
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
    </div>
  );
}
