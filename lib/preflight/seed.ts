// Demo data for Brightline Studio, a small design agency that pays freelancers every Friday.
// Deterministic: the same history is rebuilt on every start, because the free host's disk is wiped
// on restart (see README).

import type { PastPayout, Payee, Rule } from './types';

export const ORG = {
  name: 'Brightline Studio',
  owner: 'Dana',
  /** The business's real email domain; lookalikes of it are flagged. */
  domain: 'brightline-studio.com',
};

/**
 * Domain for the demo payees' emails. PayPal sandbox addresses look shared across developers, so a
 * common one such as jane.doe@example.com may already belong to someone else's sandbox account
 * (a payout to it then lands there). Set PREFLIGHT_PAYEE_DOMAIN to a domain only you use and create
 * your sandbox Personal accounts with it.
 */
export const PAYEE_DOMAIN = (process.env.PREFLIGHT_PAYEE_DOMAIN || 'example.com').trim().toLowerCase();
const at = (local: string) => `${local}@${PAYEE_DOMAIN}`;

export const PAYEES: Payee[] = [
  { id: 'priya', name: 'Priya Nayar', email: at('priya.nayar'), wallet: 'PAYPAL', phoneOnFile: '(513) 555-0142', trusted: true },
  { id: 'james', name: 'James Chen', email: at('james.chen'), wallet: 'PAYPAL', phoneOnFile: '(513) 555-0187', trusted: true },
  { id: 'tom', name: 'Tom Becker', email: at('tom.becker'), wallet: 'PAYPAL', phoneOnFile: '(513) 555-0119', trusted: true },
  { id: 'aisha', name: 'Aisha Khan', email: at('aisha.khan'), wallet: 'VENMO', phoneOnFile: '(513) 555-0163', trusted: true },
  { id: 'diego', name: 'Diego Ruiz', email: at('diego.ruiz'), wallet: 'PAYPAL', phoneOnFile: '(513) 555-0175', trusted: true },
  { id: 'maria', name: 'Maria Lopez', email: at('maria.lopez'), wallet: 'PAYPAL', phoneOnFile: '(513) 555-0131', trusted: true },
];

// Typical weekly amount and how much it wobbles, per payee.
const PATTERN: Record<string, { base: number; wobble: number[] }> = {
  priya: { base: 1200, wobble: [0, 50, -50, 0, 100, -100, 0, 50, 0, -50, 0, 50] },
  james: { base: 900, wobble: [0, 0, 60, -40, 0, 0, 40, 0, -60, 0, 20, 0] },
  tom: { base: 600, wobble: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  aisha: { base: 750, wobble: [0, 25, 0, -25, 50, 0, 0, -50, 25, 0, 0, 25] },
  diego: { base: 1000, wobble: [0, 50, 100, 0, -50, 50, 0, 100, 0, 50, 0, 0] },
  maria: { base: 1500, wobble: [0, -100, 0, 100, 0, 0, -50, 50, 0, 0, 100, 0] },
};

const DAY = 86_400_000;

/**
 * Twelve weekly payouts, the latest exactly a week ago, so "today" is always a normal pay day,
 * plus Tom's mid-week rush-job payout three days ago.
 */
export function seedHistory(now = new Date()): PastPayout[] {
  const lastRun = new Date(now.getTime() - 7 * DAY);
  const out: PastPayout[] = [];
  for (const payee of PAYEES) {
    const { base, wobble } = PATTERN[payee.id];
    for (let week = 11; week >= 0; week--) {
      // Maria skipped one week; history is rarely perfectly regular.
      if (payee.id === 'maria' && week === 6) continue;
      const date = new Date(lastRun.getTime() - week * 7 * DAY);
      out.push({
        id: `${payee.id}-w${week}`,
        payeeId: payee.id,
        date: date.toISOString(),
        amount: base + wobble[11 - week],
        receiver: payee.email,
        wallet: payee.wallet,
      });
    }
  }
  // Tom was paid $600 three days ago for a separate rush job, so a second $600 today looks like a duplicate.
  out.push({
    id: 'tom-rush',
    payeeId: 'tom',
    date: new Date(now.getTime() - 3 * DAY).toISOString(),
    amount: 600,
    receiver: at('tom.becker'),
    wallet: 'PAYPAL',
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Dana's rules, already compiled, so the demo starts ready. She can edit or add more. */
export const SEED_RULES: Rule[] = [
  {
    id: 'r1',
    text: "If someone's PayPal email changed, hold anything over $500.",
    kind: 'changed_destination',
    params: { limit: 500 },
    action: 'hold',
    readBack: 'Hold a payout over $500.00 when it goes to a different email than the one on file.',
    confirmed: true,
  },
  {
    id: 'r2',
    text: 'Hold anyone getting more than 2x their usual.',
    kind: 'vs_usual',
    params: { multiplier: 2 },
    action: 'hold',
    readBack: "Hold a payout above 2x the payee's usual (median) amount.",
    confirmed: true,
  },
  {
    id: 'r3',
    text: 'Warn me if I pay the same person the same amount twice in 7 days.',
    kind: 'duplicate',
    params: { days: 7 },
    action: 'warn',
    readBack: 'Warn when the same payee gets the same amount within 7 days.',
    confirmed: true,
  },
  {
    id: 'r4',
    text: 'Hold any new payee over $300 until I check them.',
    kind: 'new_payee',
    params: { limit: 300 },
    action: 'hold',
    readBack: 'Hold a payout over $300.00 to someone Brightline has never paid.',
    confirmed: true,
  },
];

const FRAUD_BODY = `Hi Dana,

Please run this week's payouts:
- Priya Nayar $1,200
- James Chen $900
- Tom Becker $600
- Aisha Khan $750 (Venmo)
- Diego Ruiz $1,100

Also, Maria switched PayPal accounts. Send her $4,800 to maria.lopez.pay@gmail.com this week (she's covering the Hartwell launch).

Need it before noon, thanks!
Mark`;

/** The request in the demo: it looks like the ops manager, but the domain is a lookalike. */
export const SAMPLE_FRAUD_EML = `Return-Path: <mark@brightline-studlo.com>
Authentication-Results: mx.brightline-studio.com; spf=pass smtp.mailfrom=brightline-studlo.com; dkim=pass header.d=brightline-studlo.com; dmarc=fail (p=none) header.from=brightline-studlo.com
From: Mark Ellis <mark@brightline-studlo.com>
Reply-To: Mark Ellis <mark.ellis.ops@gmail.com>
To: Dana Whitfield <dana@brightline-studio.com>
Subject: This week's payouts - urgent
Date: Fri, 13 Nov 2026 09:12:00 -0500
Content-Type: text/plain; charset="UTF-8"

${FRAUD_BODY}
`;

/** The same week, sent genuinely: no Maria change, real domain, no reply-to redirect. */
export const SAMPLE_GENUINE_EML = `Return-Path: <mark@brightline-studio.com>
Authentication-Results: mx.brightline-studio.com; spf=pass smtp.mailfrom=brightline-studio.com; dkim=pass header.d=brightline-studio.com; dmarc=pass header.from=brightline-studio.com
From: Mark Ellis <mark@brightline-studio.com>
To: Dana Whitfield <dana@brightline-studio.com>
Subject: This week's payouts
Date: Fri, 13 Nov 2026 09:12:00 -0500
Content-Type: text/plain; charset="UTF-8"

Hi Dana,

This week's payouts:
- Priya Nayar $1,200
- James Chen $900
- Aisha Khan $750 (Venmo)
- Diego Ruiz $1,100
- Maria Lopez $1,550

Thanks!
Mark
`;

export const SAMPLE_CSV = [
  'name,email,amount,wallet,note',
  ...([
    ['priya', 1200], ['james', 900], ['tom', 600], ['aisha', 750], ['diego', 1100], ['maria', 1550],
  ] as const).map(([id, amount]) => {
    const p = PAYEES.find((x) => x.id === id)!;
    return `${p.name},${p.email},${amount},${p.wallet},Week 46`;
  }),
  '',
].join('\n');

// ---- Scenario library: one click loads a request, with what to expect and how to play it out. ----

const realMark = (subject: string, body: string) => `Return-Path: <mark@brightline-studio.com>
Authentication-Results: mx.brightline-studio.com; spf=pass smtp.mailfrom=brightline-studio.com; dkim=pass header.d=brightline-studio.com; dmarc=pass header.from=brightline-studio.com
From: Mark Ellis <mark@brightline-studio.com>
To: Dana Whitfield <dana@brightline-studio.com>
Subject: ${subject}
Date: Fri, 13 Nov 2026 09:12:00 -0500
Content-Type: text/plain; charset="UTF-8"

Hi Dana,

${body}

Thanks!
Mark
`;

const usual = `- Priya Nayar $1,200
- James Chen $900
- Aisha Khan $750 (Venmo)`;

export type Scenario = {
  id: string; label: string; tone: 'fraud' | 'genuine'; text: string;
  /** One line for the demo strip. */
  short: string;
  /** The next step, for the demo strip. */
  next: string;
  story: string; expect: string; play: string;
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'fake-sender', label: 'Fake sender', tone: 'fraud', text: SAMPLE_FRAUD_EML,
    short: "A scammer pretends to be Mark from a lookalike domain.",
    next: "Run it, call Mark, then \"Not from them: stop all\" or \"Confirm batch\".",
    story: 'A scammer pretends to be Mark from brightline-studlo.com (one letter off), with replies going to Gmail.',
    expect: 'The whole batch is held: nothing in a fake email gets paid.',
    play: 'Call Mark. If he didn\'t send it, click "Not from them: stop all": nothing is paid. If he did, tick "They confirmed it" and Confirm batch: Maria stays held, Tom gets a warning, and in the payee inbox Maria answers "No, not me".',
  },
  {
    id: 'hacked-boss', label: "Mark's mailbox hacked", tone: 'fraud',
    short: "Sent from Mark's real mailbox, with Diego's PayPal changed.",
    next: "Run it, send the 4 clear payouts, then Diego answers \"No, not me\".",
    text: realMark("This week's payouts", `This week's payouts:\n${usual}\n- Diego Ruiz $1,000 to his new PayPal, diego.ruiz.pay@gmail.com\n- Maria Lopez $1,500`),
    story: "The scammer is inside Mark's real mailbox, so the email passes every sender check. They change one line: Diego's PayPal.",
    expect: "Sender checks pass, so the batch isn't held. Diego is held anyway: new email on a $1,000 payout.",
    play: 'Send the 4 clear payouts. The check goes to Diego\'s email on file (not the hacked one): the real Diego answers "No, not me".',
  },
  {
    id: 'hacked-payee', label: "Maria's mailbox hacked", tone: 'fraud',
    short: "The scammer controls Maria's mailbox and changed her PayPal.",
    next: "Run it, click \"Yes\" as the scammer, then the real Maria taps \"Not me\" on her phone.",
    text: realMark('Payouts + Maria update', `This week's payouts:\n${usual}\n- Diego Ruiz $1,000\n- Maria Lopez $1,500 to her new PayPal, maria.lopez.pay@gmail.com (she emailed me about the change)`),
    story: 'The scammer took over Maria\'s mailbox and emailed Mark "I changed my PayPal". Mark believes it and forwards it. The request is genuine; the details are not.',
    expect: 'Maria is held: new email on a $1,500 payout. Her check goes to her email on file, which is the hacked mailbox.',
    play: 'In the payee inbox, click "Yes, that\'s me" as the scammer would: nothing is sent, a code goes to the phone on file instead. On the phone card, the real Maria taps "Not me".',
  },
  {
    id: 'ghost', label: 'Ghost contractor', tone: 'fraud',
    short: "A contractor nobody hired is slipped into the list.",
    next: "Run it, send the 5 clear payouts, then stop Alex's payout.",
    text: realMark("This week's payouts", `This week's payouts:\n${usual}\n- Diego Ruiz $1,000\n- Maria Lopez $1,500\n- Alex Morgan $2,500 alex.morgan.dev@gmail.com (new contractor, started this week)`),
    story: 'Someone slips in a contractor nobody hired, with a convincing note.',
    expect: 'Alex is held: a new payee over $300, with no email or phone on file to check with.',
    play: 'Send the 5 clear payouts. Open Alex\'s case: only a check through a channel you already trust can release it, so click "Stop this payout".',
  },
  {
    id: 'inflated', label: 'Inflated invoice', tone: 'fraud',
    short: "James, usually $900, is listed at $3,000.",
    next: "Run it, send the 4 clear payouts, then James answers \"No, not me\".",
    text: realMark("This week's payouts", `This week's payouts:\n- Priya Nayar $1,200\n- James Chen $3,000\n- Aisha Khan $750 (Venmo)\n- Diego Ruiz $1,000\n- Maria Lopez $1,500`),
    story: "James is usually paid $900. This week's request says $3,000, to his normal account (padding, or a typo).",
    expect: "James is held: more than 2x his usual. The account didn't change, so his email answer alone settles it.",
    play: 'Send the 4 clear payouts. In the payee inbox, James answers "No, not me" (he invoiced $900), or edit the amount to 900 in the grid and it turns clear.',
  },
  {
    id: 'paid-twice', label: 'Paid twice', tone: 'fraud',
    short: "Maria's invoice appears twice in one request.",
    next: "Run it and send the rest; don't acknowledge the second Maria row.",
    text: realMark("This week's payouts", `This week's payouts:\n${usual}\n- Maria Lopez $1,500\n- Diego Ruiz $1,000\n- Maria Lopez $1,500`),
    story: "Maria's invoice appears twice in the same request: a copy-paste slip, or a payout split to stay under a limit.",
    expect: "Maria's second row gets a warning: she is already in this batch.",
    play: "Don't acknowledge the second Maria row: send the rest, and it stays behind.",
  },
  {
    id: 'genuine', label: 'Genuine', tone: 'genuine', text: SAMPLE_GENUINE_EML,
    short: "Mark's real weekly email, nothing changed.",
    next: "Run it and send: everything goes straight to PayPal.",
    story: "Mark's real weekly email, nothing changed.",
    expect: 'Every payout is clear and goes straight to PayPal. No extra steps.',
    play: 'Click Send via PayPal, then Refresh PayPal.',
  },
  {
    id: 'csv', label: 'CSV', tone: 'genuine', text: SAMPLE_CSV,
    short: "A payout export, with no email headers to check.",
    next: "Run it, acknowledge Tom's warning, then send.",
    story: 'A payout export as CSV, with no email headers to check.',
    expect: 'Normal rows are clear; Tom gets a warning (same amount paid three days ago).',
    play: 'Acknowledge Tom, then send.',
  },
];
