'use client';

// The browser's copy of Preflight's state, shared by the host page and every custom AG Studio
// widget. Widgets read it with useSyncExternalStore, so a change made anywhere redraws everything.

import type { Scenario } from '@/lib/preflight/seed';
import { useSyncExternalStore } from 'react';
import type { Snapshot } from '@/lib/preflight/snapshot';

export type InboxMessage = { rowId: string; name: string; token: string; message: string; sms: { phone: string; text: string } | null };
export type EvalResult = {
  synthetic: true; seed: number; total: number; rules: string[];
  genuine: { n: number; instant: number; warned: number; held: number };
  fraud: { n: number; held: number; warned: number; missed: number };
  byKind: { kind: string; label: string; n: number; held: number; warned: number; clear: number }[];
};

type State = {
  /** The demo scenario loaded into the request box (shown in the demo strip), if any. */
  scenario: Scenario | null;
  /** Demo shows the simulation (scenarios, payee inbox and phone); Product shows what a business sees. */
  view: 'demo' | 'product';
  snapshot: Snapshot | null;
  inbox: InboxMessage[];
  selectedRowId: string | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  evaluation: EvalResult | null;
};

let state: State = { scenario: null, view: 'demo', snapshot: null, inbox: [], selectedRowId: null, busy: null, error: null, notice: null, evaluation: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const preflightStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  select(rowId: string | null) {
    set({ selectedRowId: rowId });
  },
  dismiss() {
    set({ error: null, notice: null });
  },
};

export const usePreflight = () => useSyncExternalStore(preflightStore.subscribe, preflightStore.get, preflightStore.get);

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/preflight/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

async function run(label: string, fn: () => Promise<Snapshot | void>, notice?: string | (() => string)) {
  set({ busy: label, error: null, notice: null });
  try {
    const snap = await fn();
    const inbox = await request<InboxMessage[]>('GET', 'inbox');
    set({ ...(snap ? { snapshot: snap } : {}), inbox, busy: null, notice: (typeof notice === 'function' ? notice() : notice) ?? null });
    return true;
  } catch (e) {
    set({ busy: null, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export const actions = {
  setView: (view: State['view']) => set({ view }),
  setScenario: (scenario: Scenario | null) => set({ scenario }),
  load: () => run('Loading', () => request<Snapshot>('GET', 'state')),
  runPreflight: (text: string) =>
    run('Reading the request and checking every payout', async () => {
      const snap = await request<Snapshot>('POST', 'reviews', { text });
      const first = snap.reviews[0]?.items.find((i) => i.state !== 'clear') ?? snap.reviews[0]?.items[0];
      set({ selectedRowId: first?.rowId ?? null });
      return snap;
    }),
  send: (reviewId: string) => run('Sending ready payouts through PayPal', () => request<Snapshot>('POST', `reviews/${reviewId}/send`), 'Sent. PayPal statuses update in the grid.'),
  refresh: (reviewId: string) => run('Reading PayPal statuses', () => request<Snapshot>('POST', `reviews/${reviewId}/refresh`)),
  edit: (rowId: string, patch: { amount?: number; receiver?: string; name?: string }) =>
    run('Re-checking the row', () => request<Snapshot>('POST', `items/${rowId}`, { action: 'edit', ...patch })),
  confirmSender: (reviewId: string) =>
    run('Confirming the batch', () => request<Snapshot>('POST', `reviews/${reviewId}/confirm-sender`, { confirmed: true }), 'Batch confirmed. Rows with their own holds stay held.'),
  rejectSender: (reviewId: string) =>
    run('Stopping the whole batch', () => request<Snapshot>('POST', `reviews/${reviewId}/reject-sender`), 'Fake request stopped. Nothing in it was paid.'),
  acknowledge: (rowId: string) => run('Saving', () => request<Snapshot>('POST', `items/${rowId}`, { action: 'ack' })),
  release: (rowId: string) =>
    run('Releasing after call-back', () => request<Snapshot>('POST', `items/${rowId}`, { action: 'release', calledPayee: true }), 'Released and sent.'),
  stop: (rowId: string) => run('Stopping', () => request<Snapshot>('POST', `items/${rowId}`, { action: 'cancel' }), 'Stopped. Nothing was sent.'),
  pullBack: (rowId: string) => run('Asking PayPal to cancel the unclaimed payout', () => request<Snapshot>('POST', `items/${rowId}`, { action: 'pullback' }), 'Pulled back: PayPal returned the money.'),
  answer: (token: string, answer: 'yes' | 'no') => {
    let needsCode = false;
    return run(
      answer === 'yes' ? 'Payee confirmed by email' : 'Payee denied: stopping',
      async () => {
        needsCode = (await request<{ needsCode?: boolean }>('POST', 'verify', { token, answer })).needsCode === true;
        return request<Snapshot>('GET', 'state');
      },
      () =>
        answer === 'no'
          ? 'The payee said no. Marked as fraud; nothing was sent.'
          : needsCode
            ? 'New payout details: a code was texted to the phone on file. Nothing is sent until it is entered.'
            : 'Verified by the payee and sent through PayPal.',
    );
  },
  enterCode: (token: string, code: string) =>
    run(
      'Checking the code',
      async () => {
        await request('POST', 'verify', { token, code });
        return request<Snapshot>('GET', 'state');
      },
      'Code matched the phone on file: verified and sent through PayPal.',
    ),
  addRule: async (text: string) => {
    let problem: string | undefined;
    const ok = await run('Reading your rule', async () => {
      const snap = await request<Snapshot & { problem?: string }>('POST', 'rules', { text });
      problem = snap.problem;
      return snap;
    });
    if (ok && problem) set({ error: problem });
    return ok && !problem;
  },
  confirmRule: (id: string, confirmed: boolean) => run('Saving rule', () => request<Snapshot>('POST', `rules/${id}`, { confirmed })),
  deleteRule: (id: string) => run('Removing rule', () => request<Snapshot>('POST', `rules/${id}`, { delete: true })),
  evaluate: async () => {
    set({ busy: 'Running the synthetic safety test' });
    try {
      set({ evaluation: await request<EvalResult>('POST', 'eval'), busy: null });
    } catch (e) {
      set({ busy: null, error: String(e) });
    }
    return state.evaluation;
  },
  reset: () => run('Resetting the demo', () => request<Snapshot>('POST', 'reset'), 'Demo reset.').then((ok) => (set({ selectedRowId: null, evaluation: null }), ok)),
};

/** The newest review, which the Review page shows. */
export const currentReview = (s: State) => s.snapshot?.reviews[0] ?? null;
export const selectedItem = (s: State) => currentReview(s)?.items.find((i) => i.rowId === s.selectedRowId) ?? null;
