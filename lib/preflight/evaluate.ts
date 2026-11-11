// A synthetic test of the rules engine: hundreds of labelled payouts, genuine and fraudulent, built
// by a generator that knows nothing about the rules. Reports how often genuine payouts were slowed
// down and how many frauds were caught, misses included. Synthetic data, and labelled as such.
// Email-header checks are not part of it (the generated payouts have no emails), so this measures
// the payout rules alone.

import { evaluateItems } from './rules';
import { PAYEES, SEED_RULES, seedHistory } from './seed';
import type { PastPayout, Payee, RequestRow } from './types';

// Deterministic random numbers, so the published result can be reproduced.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Case = { label: 'genuine' | 'fraud'; kind: string; row: RequestRow; payees: Payee[]; history: PastPayout[] };

const KINDS = {
  genuine: [
    ['normal week', 60],
    ['raise (1.2-1.8x)', 10],
    ['one-off big job (2.2-3x), same email', 4],
    ['changed email, normal amount', 6],
    ['new contractor, small first payout', 6],
    ['new contractor, large first payout', 2],
    ['second payout same week (rush job)', 4],
  ],
  fraud: [
    ['redirected email + inflated amount', 3],
    ['redirected email, normal amount', 3],
    ['fake new contractor, large amount', 1.5],
    ['inflated amount to real email (insider)', 0.5],
  ],
} as const;

export function runEvaluation(total = 500, seed = 20261112) {
  const rand = rng(seed);
  const now = new Date();
  const baseHistory = seedHistory(now).filter((h) => h.id !== 'tom-rush');
  const weights = [
    ...KINDS.genuine.map(([k, w]) => ({ label: 'genuine' as const, kind: k, w })),
    ...KINDS.fraud.map(([k, w]) => ({ label: 'fraud' as const, kind: k, w })),
  ];
  const sum = weights.reduce((t, x) => t + x.w, 0);
  const pick = () => {
    let r = rand() * sum;
    for (const x of weights) if ((r -= x.w) < 0) return x;
    return weights[0];
  };

  const cases: Case[] = [];
  for (let n = 0; n < total; n++) {
    const { label, kind } = pick();
    const payee = PAYEES[Math.floor(rand() * PAYEES.length)];
    const usual = baseHistory.filter((h) => h.payeeId === payee.id).map((h) => h.amount);
    const typical = usual[Math.floor(rand() * usual.length)];
    let history = baseHistory;
    let payees = PAYEES;
    let name = payee.name;
    let receiver = payee.email;
    let amount = typical;
    const between = (a: number, b: number) => Math.round(a + rand() * (b - a));
    switch (kind) {
      case 'raise (1.2-1.8x)': amount = Math.round(typical * (1.2 + rand() * 0.6)); break;
      case 'one-off big job (2.2-3x), same email': amount = Math.round(typical * (2.2 + rand() * 0.8)); break;
      case 'changed email, normal amount': receiver = `${payee.id}.new${n}@example.net`; break;
      case 'new contractor, small first payout': name = `New Person ${n}`; receiver = `new${n}@example.net`; amount = between(120, 300); payees = PAYEES; break;
      case 'new contractor, large first payout': name = `New Person ${n}`; receiver = `new${n}@example.net`; amount = between(800, 2500); break;
      case 'second payout same week (rush job)':
        history = [...baseHistory, { id: `rush${n}`, payeeId: payee.id, date: new Date(now.getTime() - between(1, 4) * 86_400_000).toISOString(), amount: typical, receiver: payee.email, wallet: payee.wallet }];
        break;
      case 'redirected email + inflated amount': receiver = `${payee.id}.pay${n}@mail-x.com`; amount = Math.round(typical * (1.5 + rand() * 3)); break;
      case 'redirected email, normal amount': receiver = `${payee.id}.pay${n}@mail-x.com`; break;
      case 'fake new contractor, large amount': name = `Vendor ${n}`; receiver = `billing${n}@mail-x.com`; amount = between(1500, 9000); break;
      case 'inflated amount to real email (insider)': amount = Math.round(typical * (1.3 + rand())); break;
    }
    cases.push({
      label, kind, payees, history,
      row: { rowId: String(n), name, receiver, receiverSource: 'request', amount, currency: 'USD', wallet: payee.wallet, note: '', sourceQuote: `${name} ${receiver} ${amount}` },
    });
  }

  const results = cases.map((c) => {
    const [item] = evaluateItems([c.row], {
      rules: SEED_RULES, payees: c.payees, history: c.history,
      email: { provided: true, urgencyPhrases: [] }, // header checks excluded, see note above
      source: c.row.sourceQuote, now,
    });
    return { ...c, state: item.state };
  });

  const genuine = results.filter((r) => r.label === 'genuine');
  const fraud = results.filter((r) => r.label === 'fraud');
  const byKind = Object.entries(
    results.reduce<Record<string, { label: string; n: number; held: number; warned: number; clear: number }>>((acc, r) => {
      const k = (acc[r.kind] ??= { label: r.label, n: 0, held: 0, warned: 0, clear: 0 });
      k.n++;
      if (r.state === 'held') k.held++;
      else if (r.state === 'warn') k.warned++;
      else k.clear++;
      return acc;
    }, {}),
  ).map(([kind, v]) => ({ kind, ...v }));

  return {
    synthetic: true,
    seed,
    total,
    rules: SEED_RULES.map((r) => r.text),
    genuine: {
      n: genuine.length,
      instant: genuine.filter((r) => r.state === 'clear').length,
      warned: genuine.filter((r) => r.state === 'warn').length,
      held: genuine.filter((r) => r.state === 'held').length,
    },
    fraud: {
      n: fraud.length,
      held: fraud.filter((r) => r.state === 'held').length,
      warned: fraud.filter((r) => r.state === 'warn').length,
      missed: fraud.filter((r) => r.state === 'clear').length,
    },
    byKind,
  };
}
