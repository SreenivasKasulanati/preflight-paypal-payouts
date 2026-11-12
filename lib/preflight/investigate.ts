// The investigator: for a held or warned row, an AI agent calls tools to gather evidence and
// writes a verdict. The verdict is advice shown to the owner; it never changes the row's state.
// Evidence citing a tool the agent never called is dropped. Without a key, a rules-based summary
// is built from the findings instead.

import { baselineFor } from './baseline';
import { aiAvailable, list, obj, oneOf, str, structured, type ToolDef } from './llm';
import type { EmailEvidence, Investigation, PastPayout, Payee, ReviewItem, Verdict } from './types';

type Ctx = { item: ReviewItem; payees: Payee[]; history: PastPayout[]; email: EmailEvidence; sentStatuses: { receiver: string; status?: string }[] };

function tools(ctx: Ctx): ToolDef[] {
  const payee = ctx.payees.find((p) => p.id === ctx.item.payeeId);
  return [
    {
      name: 'get_payee_profile',
      description: 'The payee on file for this row: name, email on file, wallet, whether they are trusted.',
      parameters: obj({}),
      run: () => (payee ? { found: true, name: payee.name, email_on_file: payee.email, wallet: payee.wallet, trusted: payee.trusted } : { found: false }),
    },
    {
      name: 'get_payout_history',
      description: "The payee's past payouts from this business: count, median, range, last amounts, and every email ever paid.",
      parameters: obj({}),
      run: () => {
        if (!payee) return { found: false };
        const b = baselineFor(ctx.history, payee.id);
        const receivers = [...new Set(ctx.history.filter((h) => h.payeeId === payee.id).map((h) => h.receiver))];
        return { count: b.count, median: b.median, min: b.min, max: b.max, last_amounts: b.lastAmounts, last_paid: b.lastPaid, emails_paid_before: receivers };
      },
    },
    {
      name: 'check_request_email',
      description: 'What code found in the email headers of the request: sender, reply-to, lookalike domain, SPF/DKIM/DMARC, urgency wording. provided=false means no headers were given.',
      parameters: obj({}),
      run: () => ctx.email,
    },
    {
      name: 'get_paypal_payout_status',
      description: 'PayPal statuses of payouts this business already sent to this row\'s email address in this session.',
      parameters: obj({}),
      run: () => ctx.sentStatuses.filter((s) => s.receiver.toLowerCase() === ctx.item.receiver.toLowerCase()),
    },
  ];
}

export function investigateWithRules(item: ReviewItem): Investigation {
  const strong = item.findings.filter((f) => f.severity !== 'info');
  const headerHits = item.findings.filter((f) => f.code.startsWith('HEADER_')).length;
  const verdict: Verdict = strong.length >= 2 && headerHits > 0 ? 'likely_fraud' : strong.length === 0 ? 'likely_genuine' : 'needs_human';
  return {
    verdict,
    summary:
      verdict === 'likely_fraud'
        ? 'Several independent warning signs line up: treat this as a likely impersonation attempt.'
        : verdict === 'likely_genuine'
          ? 'Nothing beyond minor notes was found.'
          : item.findings.some((f) => f.severity === 'hold')
            ? 'Some checks failed. Confirm with the payee before releasing.'
            : 'A warning only: check it, then acknowledge it to send with the batch.',
    evidence: item.findings.map((f) => ({ source: 'rules engine', fact: f.message })),
    by: 'rules',
  };
}

export async function investigate(ctx: Ctx): Promise<Investigation> {
  if (!aiAvailable()) return investigateWithRules(ctx.item);
  const t = tools(ctx);
  const { value, toolsCalled } = await structured<{ verdict: Verdict; summary: string; evidence: { source: string; fact: string }[] }>({
    name: 'investigation',
    instructions:
      'You investigate one payout that a business\'s safety rules held or flagged, and write a short case for the owner. ' +
      'Call all the tools you need in a single round (they run in parallel), then answer. Every evidence item must state a fact a tool returned, ' +
      'with source set to that tool\'s name. Do not state anything no tool returned. If headers were not provided, say the sender could not be checked. ' +
      'verdict: likely_fraud when several independent signals point to impersonation or redirection; likely_genuine when the signals have an innocent explanation in the data; otherwise needs_human. ' +
      'summary: two sentences, plain English, no jargon. Your verdict is advice; the owner decides.',
    input: JSON.stringify({
      row: { name: ctx.item.name, receiver: ctx.item.receiver, amount: ctx.item.amount, wallet: ctx.item.wallet, note: ctx.item.note },
      rule_findings: ctx.item.findings.map((f) => f.message),
    }),
    schema: obj({
      verdict: oneOf(['likely_fraud', 'likely_genuine', 'needs_human']),
      summary: str(),
      evidence: list(obj({ source: oneOf(t.map((x) => x.name)), fact: str() })),
    }),
    tools: t,
    maxSteps: 2, // one round of tool calls, then the answer: 2-3 requests per held row
  });
  const evidence = value.evidence.filter((e) => toolsCalled.includes(e.source));
  return { verdict: value.verdict, summary: value.summary, evidence, by: 'ai' };
}
