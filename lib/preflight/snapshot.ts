// What the UI reads: the store, minus secrets, plus flat tables for AG Studio and the KPI tiles.

import { aiAvailable } from './llm';
import { baselineFor } from './baseline';
import { payoutsMode } from './payouts';
import { ORG } from './seed';
import { store } from './store';
import type { ItemState } from './types';

const STATE_LABEL: Record<ItemState, string> = { clear: 'Clear', warn: 'Warning', held: 'Held', denied: 'Stopped', sent: 'Sent' };

export function snapshot() {
  const s = store();
  const items = s.reviews.flatMap((r) => r.items.map((i) => ({ review: r, item: i })));
  const decided = items.filter(({ item }) => item.state === 'sent' || item.state === 'denied');
  const sentInstantly = items.filter(({ item }) => item.state === 'sent' && !item.releasedBy).length;
  const everHeld = items.filter(({ item }) => item.coolingUntil).length;

  return {
    org: ORG,
    mode: { payouts: payoutsMode(), ai: aiAvailable() ? 'openai' : 'rules-only' },
    coolingMinutes: Number(process.env.PREFLIGHT_COOLING_MINUTES ?? 10),
    rules: s.rules,
    payees: s.payees.map((p) => ({ ...p, baseline: baselineFor(s.history, p.id) })),
    reviews: s.reviews.map((r) => ({
      ...r,
      items: r.items.map(({ verifyToken: _t, ...rest }) => ({ ...rest, awaitingPayee: Boolean(_t) })),
    })),
    audit: s.audit.slice(0, 100),
    kpis: {
      reviewed: items.length,
      sent: items.filter(({ item }) => item.state === 'sent').length,
      held: items.filter(({ item }) => item.state === 'held').length,
      heldAmount: items.filter(({ item }) => item.state === 'held').reduce((t, { item }) => t + item.amount, 0),
      protectedAmount: items.filter(({ item }) => item.state === 'denied').reduce((t, { item }) => t + item.amount, 0),
      // Friction: of everything decided, how much went straight through without anyone waiting.
      instantShare: decided.length ? sentInstantly / decided.length : null,
      everHeld,
    },
    // Flat tables for AG Studio's data engine.
    tables: {
      payouts: items.map(({ review, item }) => ({
        id: `${review.id}-${item.rowId}`,
        reviewId: review.id,
        rowId: item.rowId,
        createdAt: review.createdAt,
        payee: item.name,
        receiver: item.receiver,
        wallet: item.wallet === 'VENMO' ? 'Venmo' : 'PayPal',
        amount: item.amount,
        state: STATE_LABEL[item.state],
        paypalStatus: item.paypal?.status ?? null,
        reason: item.findings.find((f) => f.severity === 'hold')?.message ?? item.findings.find((f) => f.severity === 'warn')?.message ?? null,
        holdCount: item.findings.filter((f) => f.severity === 'hold').length,
        warnCount: item.findings.filter((f) => f.severity === 'warn').length,
        verdict: item.investigation?.verdict ?? null,
        releasedBy: item.releasedBy ?? null,
      })),
      findings: items.flatMap(({ review, item }) =>
        item.findings.map((f, n) => ({
          id: `${review.id}-${item.rowId}-${n}`,
          payoutId: `${review.id}-${item.rowId}`,
          payee: item.name,
          code: f.code,
          severity: f.severity === 'hold' ? 'Hold' : f.severity === 'warn' ? 'Warn' : 'Note',
          rule: f.ruleId ? (s.rules.find((r) => r.id === f.ruleId)?.text ?? f.ruleId) : 'Built-in check',
          message: f.message,
        })),
      ),
      history: s.history.map((h) => ({
        id: h.id,
        payee: s.payees.find((p) => p.id === h.payeeId)?.name ?? h.payeeId,
        date: h.date,
        amount: h.amount,
        receiver: h.receiver,
        wallet: h.wallet === 'VENMO' ? 'Venmo' : 'PayPal',
      })),
      payees: s.payees.map((p) => {
        const b = baselineFor(s.history, p.id);
        return { id: p.id, payee: p.name, email: p.email, wallet: p.wallet === 'VENMO' ? 'Venmo' : 'PayPal', trusted: p.trusted, usualAmount: b.median, payouts: b.count };
      }),
    },
  };
}

export type Snapshot = ReturnType<typeof snapshot>;

/** The simulated inbox of each held payee: what the verification email to the address on file says. */
export function inbox() {
  const s = store();
  return s.reviews.flatMap((r) =>
    r.items
      .filter((i) => i.state === 'held' && i.verifyToken && i.verificationDraft)
      .map((i) => ({ rowId: i.rowId, name: i.name, token: i.verifyToken as string, message: i.verificationDraft as string })),
  );
}
