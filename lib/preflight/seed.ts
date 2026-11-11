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
 * common one such as priya.nair@example.com may already belong to someone else's sandbox account
 * (a payout to it then lands there). Set PREFLIGHT_PAYEE_DOMAIN to a domain only you use and create
 * your sandbox Personal accounts with it.
 */
export const PAYEE_DOMAIN = (process.env.PREFLIGHT_PAYEE_DOMAIN || 'example.com').trim().toLowerCase();
const at = (local: string) => `${local}@${PAYEE_DOMAIN}`;

export const PAYEES: Payee[] = [
  { id: 'priya', name: 'Priya Nair', email: at('priya.nayar'), wallet: 'PAYPAL', phoneOnFile: '(513) 555-0142', trusted: true },
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
- Priya Nair $1,200
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
- Priya Nair $1,200
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
