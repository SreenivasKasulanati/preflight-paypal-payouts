// In-memory state for the demo, rebuilt from seed data on start and by "Reset demo".
// Kept on globalThis so Next.js dev reloads don't wipe it between requests.

import { PAYEES, SEED_RULES, seedHistory } from './seed';
import { backtest } from './rules';
import type { AuditEvent, PastPayout, Payee, Review, Rule } from './types';

export type Store = {
  payees: Payee[];
  history: PastPayout[];
  rules: Rule[];
  reviews: Review[];
  audit: AuditEvent[];
  startedAt: string;
};

function fresh(): Store {
  const payees = structuredClone(PAYEES);
  const history = seedHistory();
  const rules = SEED_RULES.map((r) => ({ ...r, backtest: backtest(r, payees, history) }));
  return { payees, history, rules, reviews: [], audit: [], startedAt: new Date().toISOString() };
}

const g = globalThis as { __preflight?: Store };

export const store = (): Store => (g.__preflight ??= fresh());

export function resetStore() {
  g.__preflight = fresh();
  return g.__preflight;
}

export function log(e: Omit<AuditEvent, 'at'>) {
  store().audit.unshift({ at: new Date().toISOString(), ...e });
}
