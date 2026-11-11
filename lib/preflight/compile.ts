// Turns a rule written in plain English into one of the engine's fixed check types. The AI only
// chooses a type and its numbers; the result is read back in plain words and backtested before
// the owner confirms it. A rule that fits no supported type is refused, not approximated.

import { aiAvailable, nullable, num, obj, oneOf, str, structured } from './llm';
import { readBack } from './rules';
import type { Rule, RuleAction, RuleKind } from './types';

const KINDS: RuleKind[] = ['max_amount', 'vs_usual', 'changed_destination', 'new_payee', 'duplicate', 'batch_total'];

export const SUPPORTED =
  'Supported checks: a single payout over an amount; a payout above N times the payee\'s usual; ' +
  'a payout over an amount to a changed email; a payout over an amount to a new payee; ' +
  'the same amount to the same payee within N days; a batch total over an amount.';

type Compiled = { ok: true; rule: Omit<Rule, 'id' | 'confirmed'> } | { ok: false; problem: string };

function finish(text: string, kind: RuleKind, action: RuleAction, params: Rule['params']): Compiled {
  const need: Record<RuleKind, (keyof Rule['params'])[]> = {
    max_amount: ['limit'], batch_total: ['limit'], changed_destination: ['limit'], new_payee: ['limit'],
    vs_usual: ['multiplier'], duplicate: ['days'],
  };
  const clean: Rule['params'] = {};
  for (const k of need[kind]) {
    const v = params[k];
    if (typeof v !== 'number' || !(v >= 0)) return { ok: false, problem: `That check needs a ${k}, and none was found in the rule.` };
    clean[k] = v;
  }
  return { ok: true, rule: { text, kind, action, params: clean, readBack: readBack({ kind, action, params: clean }) } };
}

/** A small pattern parser, used when no AI key is set. */
export function compileWithPatterns(text: string): Compiled {
  const t = text.toLowerCase().replace(/,/g, '');
  const action: RuleAction = /\bwarn|flag|tell me|notify/.test(t) ? 'warn' : 'hold';
  const money = Number(t.match(/\$\s?(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  const times = Number(t.match(/(\d+(?:\.\d+)?)\s?(x|×|times)/)?.[1] ?? NaN);
  const days = Number(t.match(/(\d+)\s?days?/)?.[1] ?? (/\bweek\b/.test(t) ? 7 : NaN));
  if (/same (amount|person)|twice|duplicate/.test(t)) return finish(text, 'duplicate', action, { days });
  if (/usual|normal|average|typical/.test(t)) return finish(text, 'vs_usual', action, { multiplier: times });
  if (/(email|account|details?).*(chang|new|switch)|(chang|new|switch).*(email|account)/.test(t))
    return finish(text, 'changed_destination', action, { limit: Number.isNaN(money) ? 0 : money });
  if (/new (payee|person|contractor|vendor)|never paid|first time/.test(t)) return finish(text, 'new_payee', action, { limit: Number.isNaN(money) ? 0 : money });
  if (/batch|total|altogether/.test(t)) return finish(text, 'batch_total', action, { limit: money });
  if (/over|above|more than|exceed/.test(t) && !Number.isNaN(money)) return finish(text, 'max_amount', action, { limit: money });
  return { ok: false, problem: `I couldn't match that to a supported check. ${SUPPORTED}` };
}

export async function compileRule(text: string): Promise<Compiled & { by: 'ai' | 'patterns' }> {
  if (!aiAvailable()) return { ...compileWithPatterns(text), by: 'patterns' };
  try {
    return await compileWithAi(text);
  } catch (e) {
    console.error('[preflight] AI rule compile failed, using patterns', e);
    return { ...compileWithPatterns(text), by: 'patterns' };
  }
}

async function compileWithAi(text: string): Promise<Compiled & { by: 'ai' | 'patterns' }> {
  const { value } = await structured<{
    fits: boolean; kind: RuleKind; action: RuleAction; limit: number | null; multiplier: number | null; days: number | null; problem: string;
  }>({
    name: 'compiled_rule',
    instructions:
      'Map a payout safety rule written by a business owner onto exactly one supported check type. ' +
      `${SUPPORTED} ` +
      'Take numbers exactly as the owner wrote them ($500 is 500, "a week" is 7 days, "double" is 2). ' +
      'Use action "warn" only if the owner asks to be warned, flagged or told; otherwise "hold". ' +
      'If the rule fits none of the types, or a needed number is missing, set fits to false and explain in problem. Never guess a number.',
    input: text,
    schema: obj({
      fits: { type: 'boolean' },
      kind: oneOf(KINDS),
      action: oneOf(['hold', 'warn']),
      limit: nullable(num('Dollar amount for amount-based checks')),
      multiplier: nullable(num('Times-usual multiplier')),
      days: nullable(num('Window in days')),
      problem: str('Empty if it fits'),
    }),
  });
  if (!value.fits) return { ok: false, problem: value.problem || `I couldn't match that to a supported check. ${SUPPORTED}`, by: 'ai' };
  const params: Rule['params'] = {};
  if (value.limit !== null) params.limit = value.limit;
  if (value.multiplier !== null) params.multiplier = value.multiplier;
  if (value.days !== null) params.days = value.days;
  return { ...finish(text, value.kind, value.action, params), by: 'ai' };
}
