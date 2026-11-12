// What the UI reads: the store, minus secrets, plus flat tables for AG Studio and the KPI tiles.

import { aiAvailable } from './llm';
import { baselineFor } from './baseline';
import { payoutsMode } from './payouts';
import { usdText } from './rules';
import { ORG } from './seed';
import { store } from './store';
import type { ItemState } from './types';

const RULE_SIGNAL: Record<string, string> = {
  changed_destination: 'Email changed', vs_usual: 'Above usual amount', duplicate: 'Possible duplicate',
  new_payee: 'New payee', max_amount: 'Over limit', batch_total: 'Batch total',
};
const CODE_SIGNAL: Record<string, string> = {
  AMOUNT_OUTLIER: 'Unusual amount', UNVERIFIED_EXTRACTION: 'Check extraction', UNKNOWN_PAYEE: 'New payee',
  HEADER_REPLY_TO_MISMATCH: 'Reply-to redirect', HEADER_LOOKALIKE_DOMAIN: 'Lookalike domain',
  HEADER_AUTH_FAIL: 'Email auth failed', URGENCY_LANGUAGE: 'Pressure wording', HEADERS_NOT_PROVIDED: 'Sender unchecked', SENDER_UNVERIFIED: 'Suspicious sender', DUPLICATE_IN_BATCH: 'Twice in batch',
};

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
      items: r.items.map(({ verifyToken: _t, phoneCode: _c, ...rest }) => ({ ...rest, awaitingPayee: Boolean(_t), awaitingCode: Boolean(_c) })),
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
          signal: f.code === 'RULE' ? (RULE_SIGNAL[s.rules.find((r) => r.id === f.ruleId)?.kind ?? ''] ?? 'Rule') : (CODE_SIGNAL[f.code] ?? f.code),
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
        return { id: p.id, payee: p.name, email: p.email, wallet: p.wallet === 'VENMO' ? 'Venmo' : 'PayPal', trusted: p.trusted ? 'Verified' : 'Pending', usualAmount: b.median, usualPay: `$${b.median.toLocaleString('en-US')}`, payouts: b.count };
      }),
    },
  };
}

export type Snapshot = ReturnType<typeof snapshot>;

/**
 * The simulated payee side: the verification email at the address on file and, once that email says
 * yes to new details, the text message to the phone on file carrying the code.
 */
export function inbox() {
  const s = store();
  return s.reviews.flatMap((r) =>
    r.items
      .filter((i) => i.state === 'held' && i.verifyToken && i.verificationDraft)
      .map((i) => {
        const payee = s.payees.find((p) => p.id === i.payeeId);
        return {
          rowId: i.rowId,
          name: i.name,
          token: i.verifyToken as string,
          message: i.verificationDraft as string,
          sms: i.phoneCode && payee
            ? {
                phone: payee.phoneOnFile,
                text: `${ORG.name}: someone confirmed a ${usdText(i.amount)} payout to a NEW address (${i.receiver}) from your email. ` +
                  `Your code is ${i.phoneCode}. If this wasn't you, tap Not me: nothing has been sent.`,
              }
            : null,
        };
      }),
  );
}
