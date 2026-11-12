// The rules engine. Deterministic and the only thing that decides an item's state: AI may write a
// rule (compile.ts) or explain a result (investigate.ts), but never sets clear/warn/held.

import { baselineFor, outlierScore } from './baseline';
import type {
  Backtest, EmailEvidence, Finding, PastPayout, Payee, RequestRow, ReviewItem, Rule,
} from './types';

const DAY = 86_400_000;
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const usdText = (n: number) => usd(n);

export function readBack(rule: Pick<Rule, 'kind' | 'params' | 'action'>): string {
  const verb = rule.action === 'hold' ? 'Hold' : 'Warn on';
  const { limit = 0, multiplier = 0, days = 0 } = rule.params;
  switch (rule.kind) {
    case 'max_amount': return `${verb} any single payout over ${usd(limit)}.`;
    case 'vs_usual': return `${verb} a payout above ${multiplier}x the payee's usual (median) amount.`;
    case 'changed_destination': return `${verb} a payout over ${usd(limit)} when it goes to a different email than the one on file.`;
    case 'new_payee': return `${verb} a payout over ${usd(limit)} to someone this business has never paid.`;
    case 'duplicate': return `${verb} a payout when the same payee got the same amount within ${days} days.`;
    case 'batch_total': return `${verb} the whole batch when it totals more than ${usd(limit)}.`;
  }
}

/**
 * Matches a request row to a known payee: by email, then exact full name, then by first name when
 * exactly one payee has it ("Maria" -> Maria Lopez). An ambiguous first name matches no one.
 */
export function matchPayee(row: Pick<RequestRow, 'name' | 'receiver'>, payees: Payee[]) {
  const email = row.receiver.toLowerCase();
  const name = row.name.trim().toLowerCase();
  const byEmail = email ? payees.find((p) => p.email.toLowerCase() === email) : undefined;
  if (byEmail) return byEmail;
  const byName = payees.find((p) => p.name.toLowerCase() === name);
  if (byName) return byName;
  const first = name.split(/\s+/)[0];
  const byFirst = payees.filter((p) => p.name.toLowerCase().split(' ')[0] === first);
  return name && !name.includes(' ') && byFirst.length === 1 ? byFirst[0] : undefined;
}

type Ctx = { payees: Payee[]; history: PastPayout[]; now: Date; batchTotal: number };

function ruleFinding(rule: Rule, row: RequestRow, ctx: Ctx): Finding | undefined {
  const payee = matchPayee(row, ctx.payees);
  const { limit = 0, multiplier = 0, days = 0 } = rule.params;
  const hit = (message: string): Finding => ({ code: 'RULE', severity: rule.action, ruleId: rule.id, message });
  switch (rule.kind) {
    case 'max_amount':
      return row.amount > limit ? hit(`${usd(row.amount)} is over the ${usd(limit)} limit.`) : undefined;
    case 'batch_total':
      return ctx.batchTotal > limit ? hit(`Batch total ${usd(ctx.batchTotal)} is over ${usd(limit)}.`) : undefined;
    case 'new_payee':
      return !payee && row.amount > limit ? hit(`${row.name} has never been paid before.`) : undefined;
    case 'changed_destination':
      if (!payee || payee.email.toLowerCase() === row.receiver.toLowerCase() || row.amount <= limit) return undefined;
      return hit(`Email on file is ${payee.email}; this request sends to ${row.receiver}.`);
    case 'vs_usual': {
      if (!payee) return undefined;
      const b = baselineFor(ctx.history, payee.id);
      if (b.count < 3 || row.amount <= multiplier * b.median) return undefined;
      return hit(`${usd(row.amount)} is ${(row.amount / b.median).toFixed(1)}x ${payee.name.split(' ')[0]}'s usual ${usd(b.median)}.`);
    }
    case 'duplicate': {
      if (!payee) return undefined;
      const since = ctx.now.getTime() - days * DAY;
      const dup = [...ctx.history]
        .reverse()
        .find((h) => h.payeeId === payee.id && h.amount === row.amount && Date.parse(h.date) >= since);
      if (!dup) return undefined;
      const gap = (ctx.now.getTime() - Date.parse(dup.date)) / DAY;
      // A payee paid the same amount every week is on schedule, not a duplicate: only flag a repeat
      // that comes sooner than this payee's usual gap.
      const usual = baselineFor(ctx.history, payee.id).usualGapDays;
      if (usual > 0 ? gap >= usual * 0.8 : gap >= days) return undefined;
      const ago = Math.max(1, Math.round(gap));
      const cadence = usual > 0 ? `; usually paid every ${Math.round(usual)} days` : '';
      return hit(`Same amount (${usd(row.amount)}) paid ${ago} day${ago === 1 ? '' : 's'} ago${cadence}.`);
    }
  }
}

/** Checks that don't need a rule: they come from the data itself. */
function builtInFindings(row: RequestRow, ctx: Ctx, extractionVerified: boolean): Finding[] {
  const out: Finding[] = [];
  const payee = matchPayee(row, ctx.payees);
  if (!extractionVerified) {
    out.push({
      code: 'UNVERIFIED_EXTRACTION',
      severity: 'hold',
      message: 'The amount or email in this row could not be found word-for-word in the request. Check it.',
    });
  }
  if (!payee) {
    out.push({ code: 'UNKNOWN_PAYEE', severity: 'info', message: `${row.name} is not in the payee list.` });
  } else {
    const b = baselineFor(ctx.history, payee.id);
    const z = outlierScore(b, row.amount);
    // Far outside the payee's normal range: a warning (one click, never a hold) once the amount is at
    // least 1.5x their usual, a note below that. Holds stay with the owner's rules, so a genuine
    // raise is never blocked.
    if (z > 3.5) {
      out.push({
        code: 'AMOUNT_OUTLIER',
        severity: row.amount >= b.median * 1.5 ? 'warn' : 'info',
        message: `Well outside ${payee.name.split(' ')[0]}'s normal range (${usd(b.min)}-${usd(b.max)} over ${b.count} payouts).`,
      });
    }
  }
  return out;
}

function emailFindings(email: EmailEvidence): Finding[] {
  const out: Finding[] = [];
  if (!email.provided) {
    out.push({
      code: 'HEADERS_NOT_PROVIDED',
      severity: 'info',
      message: 'No email headers were provided, so the sender could not be checked. Upload the .eml to check it.',
    });
  } else {
    if (email.lookalikeOf)
      out.push({ code: 'HEADER_LOOKALIKE_DOMAIN', severity: 'warn', message: `Sender domain ${email.fromDomain} imitates ${email.lookalikeOf}.` });
    if (email.replyToDomain && email.replyToDomain !== email.fromDomain)
      out.push({ code: 'HEADER_REPLY_TO_MISMATCH', severity: 'warn', message: `Replies go to ${email.replyTo}, not the sender.` });
    if (email.auth?.dmarc === 'fail' || email.auth?.spf === 'fail' || email.auth?.dkim === 'fail')
      out.push({ code: 'HEADER_AUTH_FAIL', severity: 'warn', message: `Email authentication failed (SPF ${email.auth?.spf ?? '?'}, DKIM ${email.auth?.dkim ?? '?'}, DMARC ${email.auth?.dmarc ?? '?'}).` });
  }
  if (email.urgencyPhrases.length)
    out.push({ code: 'URGENCY_LANGUAGE', severity: 'info', message: `Pressure wording: "${email.urgencyPhrases.join('", "')}".` });
  return out;
}

/**
 * Whether the row's amount (and name, or email when the request gave one) appear verbatim in the
 * source, so an AI misread can't slip through unnoticed.
 */
export function extractionVerified(row: RequestRow, source: string) {
  const text = source.toLowerCase().replace(/,/g, '');
  const amount = Number.isInteger(row.amount) ? String(row.amount) : row.amount.toFixed(2);
  const amountOk = new RegExp(`(^|[^0-9.])${amount.replace('.', '\\.')}(\\.00)?([^0-9]|$)`).test(text);
  const who =
    row.receiverSource === 'request'
      ? text.includes(row.receiver.toLowerCase())
      : new RegExp(`\\b${row.name.toLowerCase().split(' ')[0]}\\b`).test(text); // first name is enough: the email comes from the payee list
  return amountOk && who;
}

/** A request whose sender fails a check is not a real instruction to pay anyone. */
export const senderSuspicious = (email: EmailEvidence) =>
  email.provided &&
  (!!email.lookalikeOf ||
    (!!email.replyToDomain && email.replyToDomain !== email.fromDomain) ||
    email.auth?.dmarc === 'fail' || email.auth?.spf === 'fail' || email.auth?.dkim === 'fail');

export const SENDER_HOLD: Finding = {
  code: 'SENDER_UNVERIFIED',
  severity: 'hold',
  message: 'This request came from a suspicious sender, so nothing in it is paid until the batch is confirmed with the real sender through a channel you already trust.',
};

export const duplicateInBatch = (row: RequestRow, first: RequestRow): Finding => ({
  code: 'DUPLICATE_IN_BATCH',
  severity: 'warn',
  message: `${row.name} is already in this batch (${usdText(first.amount)}). Check this isn't the same invoice twice, or one payout split in two.`,
});

export function evaluateItems(
  rows: RequestRow[],
  opts: {
    rules: Rule[]; payees: Payee[]; history: PastPayout[]; email: EmailEvidence; source: string; now?: Date;
    /** Set once the owner has confirmed the batch with the real sender: the batch-wide hold lifts. */
    senderConfirmed?: boolean;
  },
): ReviewItem[] {
  const now = opts.now ?? new Date();
  const ctx: Ctx = { payees: opts.payees, history: opts.history, now, batchTotal: rows.reduce((s, r) => s + r.amount, 0) };
  // Email-level signals apply to every row that changes destination, and are shown on the batch.
  const mailFindings = emailFindings(opts.email);
  const seen = new Map<string, RequestRow>();
  return rows.map((row) => {
    const payee = matchPayee(row, opts.payees);
    const findings: Finding[] = [
      ...opts.rules.filter((r) => r.confirmed).map((r) => ruleFinding(r, row, ctx)).filter((f): f is Finding => !!f),
      ...builtInFindings(row, ctx, extractionVerified(row, opts.source)),
    ];
    // Sender checks matter where the email is the only reason to trust a destination: a changed
    // email or an unknown payee. Elsewhere they would only add noise for genuine payouts.
    const changedDest = !payee || payee.email.toLowerCase() !== row.receiver.toLowerCase();
    if (changedDest) findings.push(...mailFindings);
    // A fake sender makes the whole request untrusted: every row waits for the owner to confirm the
    // batch with the real sender, even rows going to the right people.
    if (senderSuspicious(opts.email) && !opts.senderConfirmed) findings.unshift(SENDER_HOLD);
    // The same person twice in one request is the classic "invoice paid twice" (or split to stay under a limit).
    const key = payee?.id ?? row.receiver.toLowerCase();
    const first = seen.get(key);
    if (first) findings.push(duplicateInBatch(row, first));
    else seen.set(key, row);

    const state = findings.some((f) => f.severity === 'hold') ? 'held' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'clear';
    return {
      ...row,
      payeeId: payee?.id,
      state,
      findings,
      baseline: payee ? baselineFor(opts.history, payee.id) : undefined,
      acknowledged: false,
    };
  });
}

/** Replays a rule over past payouts, each judged against the history before it. */
export function backtest(rule: Rule, payees: Payee[], history: PastPayout[]): Backtest {
  let wouldHold = 0;
  let wouldWarn = 0;
  let warmupSkipped = 0;
  const examples: string[] = [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const warmupEnds = sorted.length ? Date.parse(sorted[0].date) + 14 * DAY : 0;
  sorted.forEach((past, i) => {
    if (Date.parse(past.date) < warmupEnds) {
      warmupSkipped++;
      return;
    }
    const before = sorted.slice(0, i);
    const payee = payees.find((p) => p.id === past.payeeId);
    if (!payee) return;
    // As of that day: payees seen before count as known, with the email they were last paid at.
    const lastReceiver = [...before].reverse().find((h) => h.payeeId === payee.id)?.receiver;
    const ctxPayees = lastReceiver
      ? payees.map((p) => (p.id === payee.id ? { ...p, email: lastReceiver } : p))
      : payees.filter((p) => p.id !== payee.id);
    const row: RequestRow = {
      rowId: past.id, name: payee.name, receiver: past.receiver, amount: past.amount,
      currency: 'USD', wallet: past.wallet, note: '', receiverSource: 'request', sourceQuote: '',
    };
    const f = ruleFinding({ ...rule, confirmed: true }, row, {
      payees: ctxPayees, history: before, now: new Date(past.date), batchTotal: past.amount,
    });
    if (!f) return;
    if (rule.action === 'hold') wouldHold++;
    else wouldWarn++;
    if (examples.length < 3) examples.push(`${payee.name}, ${past.date.slice(0, 10)}: ${f.message}`);
  });
  return { pastPayouts: history.length, warmupSkipped, wouldHold, wouldWarn, examples };
}
