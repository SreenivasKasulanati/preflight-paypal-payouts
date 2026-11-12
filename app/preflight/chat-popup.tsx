'use client';

// Preflight's pop-up AI chat: a floating button bottom-right that opens a chat card, like the help
// chat on most websites. Minimise folds it back into the button and keeps the conversation; close
// ends it. It talks to the same AG Studio agent harness as Studio's own side panel (preflight-ai.ts),
// so the Preflight Analyst can still hand dashboard work to Studio's built-in agents.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgAiChatMessage, AgAiChatSession, AgAiHarness } from 'ag-studio';
import { PROMPT_STARTERS, onHarness } from './preflight-ai';

// --- A small, safe markdown renderer (headings, bullets, numbers, bold, code). No raw HTML. --------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} className="font-semibold text-pp-navy">{part.slice(2, -2)}</strong>
    ) : part.startsWith('`') && part.endsWith('`') ? (
      <code key={i} className="rounded bg-pp-highlight px-1 text-[0.75rem]">{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={blocks.length} className={`my-1 space-y-0.5 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'} marker:text-pp-blue`}>
        {list.items.map((it, i) => <li key={i}>{inline(it)}</li>)}
      </Tag>,
    );
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flush();
    if (heading) blocks.push(<div key={blocks.length} className="mb-0.5 mt-2 text-[0.8125rem] font-bold uppercase tracking-wide text-pp-navy">{inline(heading[1])}</div>);
    else if (line.trim()) blocks.push(<p key={blocks.length} className="my-1">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

// --- Tool steps, in plain words --------------------------------------------------------------------

const TOOL_LABEL: Record<string, string> = {
  get_batch_overview: 'Read the batch',
  get_payout_case: 'Opened the payout case',
  list_rules: 'Read the rules',
  propose_rule: 'Proposed a rule',
  run_safety_test: 'Ran the safety test',
  delegate_to: 'Asked the dashboard agents',
  rename_thread: 'Named the chat',
};

function Message({ m }: { m: AgAiChatMessage }) {
  if (m.role === 'system') return null;
  const mine = m.role === 'user';
  const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
  const tools = m.parts.filter((p) => p.type === 'tool_call').map((p) => (p as { toolCall: { name: string; toolCallId: string } }).toolCall);
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] space-y-1.5 ${mine ? '' : 'w-full'}`}>
        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tools.map((t) => (
              <span key={t.toolCallId} className="rounded-full bg-pp-highlight px-2 py-0.5 text-[0.6875rem] font-medium text-pp-blue">
                ✓ {TOOL_LABEL[t.name] ?? t.name.replaceAll('_', ' ')}
              </span>
            ))}
          </div>
        )}
        {text && (
          <div
            className={
              mine
                ? 'rounded-2xl rounded-br-sm bg-gradient-to-r from-[#003087] to-[#0070e0] px-3 py-2 text-sm text-white'
                : 'rounded-2xl rounded-bl-sm border border-[#dde4ee] bg-white px-3 py-2 text-sm leading-relaxed text-pp-ink shadow-sm'
            }
          >
            {mine ? text : <Markdown text={text} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Sparkle({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l1.8 4.6L18.5 9.4l-4.7 1.8L12 16l-1.8-4.8L5.5 9.4l4.7-1.8L12 3z" fill="#fff" />
      <path d="M18.5 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" fill="#ffd166" />
    </svg>
  );
}

// --- The pop-up ------------------------------------------------------------------------------------

export function ChatPopup() {
  const [open, setOpen] = useState(false);
  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [, redraw] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = onHarness(setHarness);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const onChange = () => redraw((n) => n + 1);
    session.addEventListener('changed', onChange);
    return () => session.removeEventListener('changed', onChange);
  }, [session]);

  const messages = session?.messages ?? [];
  const status = session?.status ?? 'idle';
  const lastParts = messages.at(-1)?.parts.length;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, status, lastParts]);

  const send = async (prompt: string) => {
    const value = prompt.trim();
    if (!value || !harness || status === 'running') return;
    setError(null);
    setText('');
    try {
      const s = session ?? (await harness.createThread({ agentId: 'preflight', title: value.slice(0, 40) }));
      if (!session) setSession(s);
      s.sendMessage(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const newChat = () => {
    session?.cancel();
    session?.close();
    setSession(null);
    setError(null);
  };

  const close = () => {
    session?.cancel();
    session?.close();
    setSession(null);
    setOpen(false);
  };

  const lastError =
    status === 'error'
      ? 'The AI could not answer just now (often a rate limit). Try again in a minute.'
      : error;

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[min(600px,calc(100vh-140px))] w-[400px] max-w-[calc(100vw-48px)] origin-bottom-right animate-[pf-pop_160ms_ease-out] flex-col overflow-hidden rounded-2xl border border-[#dde4ee] bg-[#f6f8fc] shadow-2xl">
          <div className="flex items-center gap-3 bg-gradient-to-r from-[#001c64] to-[#0070e0] px-4 py-3 text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15"><Sparkle /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">Preflight AI</div>
              <div className="text-[0.6875rem] text-white/70">{status === 'running' ? 'Working on it…' : 'Explains, never moves money'}</div>
            </div>
            {session && (
              <button className="rounded px-1.5 text-xs text-white/80 hover:bg-white/10 hover:text-white" title="Start a new chat" onClick={newChat} aria-label="New chat">
                New
              </button>
            )}
            <button className="rounded px-2 text-lg leading-none text-white/80 hover:bg-white/10 hover:text-white" title="Minimise" aria-label="Minimise" onClick={() => setOpen(false)}>
              –
            </button>
            <button className="rounded px-2 text-lg leading-none text-white/80 hover:bg-white/10 hover:text-white" title="Close and end the chat" aria-label="Close" onClick={close}>
              ×
            </button>
          </div>

          <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <div className="rounded-2xl rounded-bl-sm border border-[#dde4ee] bg-white px-3 py-2 text-sm text-pp-ink shadow-sm">
                  Hi! I can explain why a payout was held, summarise this batch, suggest a rule, or add a chart to the Risk Control Room.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PROMPT_STARTERS.map((p) => (
                    <button
                      key={p.label}
                      disabled={!harness}
                      onClick={() => send(p.prompt)}
                      className="rounded-full border border-[#c9d8ee] bg-white px-3 py-1 text-xs font-medium text-pp-blue hover:bg-pp-highlight disabled:opacity-40"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => <Message key={m.id} m={m} />)}
            {status === 'running' && (
              <div className="flex items-center gap-1 pl-1 text-pp-muted" aria-label="Thinking">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-pp-blue [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-pp-blue [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-pp-blue" />
              </div>
            )}
            {lastError && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800 ring-1 ring-rose-200">{lastError}</div>}
          </div>

          <form
            className="flex items-end gap-2 border-t border-[#dde4ee] bg-white p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <textarea
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(text);
                }
              }}
              placeholder={harness ? 'Ask about a payout, a rule, or the batch…' : 'Connecting…'}
              className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-[#dde4ee] bg-[#f6f8fc] px-3 py-2 text-sm outline-none focus:border-pp-blue focus:bg-white"
            />
            {status === 'running' ? (
              <button type="button" onClick={() => session?.cancel()} className="h-10 rounded-xl bg-slate-200 px-3 text-sm font-semibold text-pp-ink">
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!text.trim() || !harness} className="h-10 rounded-xl bg-gradient-to-r from-[#003087] to-[#0070e0] px-4 text-sm font-semibold text-white disabled:opacity-40">
                Send
              </button>
            )}
          </form>
        </div>
      )}

      <button
        onClick={() => setOpen(!open)}
        className="group fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-gradient-to-r from-[#001c64] to-[#0070e0] py-3 pl-3 pr-5 text-sm font-semibold text-white shadow-xl ring-4 ring-white/70 transition hover:-translate-y-0.5 hover:shadow-2xl"
        aria-label={open ? 'Minimise Preflight AI' : 'Ask Preflight AI'}
        aria-expanded={open}
      >
        <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-white/15">
          {!open && <span className="absolute inset-0 animate-ping rounded-full bg-white/20 group-hover:hidden" />}
          {open ? <span className="text-lg leading-none">⌄</span> : <Sparkle />}
        </span>
        {open ? 'Minimise' : session ? 'Back to chat' : 'Ask Preflight AI'}
      </button>
    </>
  );
}
