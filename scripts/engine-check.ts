// Engine checks: run with `npm run test:engine`. No network, no keys: the rules engine, sender
// checks, line parser, rule patterns and the synthetic evaluation are all plain code.

import assert from 'node:assert/strict';
import { compileWithPatterns } from '../lib/preflight/compile';
import { emailEvidence, isLookalike, parseEml } from '../lib/preflight/email';
import { runEvaluation } from '../lib/preflight/evaluate';
import { parseLines } from '../lib/preflight/extract';
import { evaluateItems } from '../lib/preflight/rules';
import { ORG, PAYEES, SAMPLE_FRAUD_EML, SAMPLE_GENUINE_EML, SCENARIOS, SEED_RULES, seedHistory } from '../lib/preflight/seed';

const check = (name: string, fn: () => void) => {
  fn();
  console.log(`✓ ${name}`);
};
const history = seedHistory();
const review = (eml: string) => {
  const parsed = parseEml(eml);
  const email = emailEvidence(parsed, ORG.domain);
  const rows = parseLines(parsed.body, PAYEES);
  return evaluateItems(rows, { rules: SEED_RULES, payees: PAYEES, history, email, source: parsed.body });
};

check('lookalike domains are caught, the real one is not', () => {
  assert.equal(isLookalike('brightline-studlo.com', 'brightline-studio.com'), true);
  assert.equal(isLookalike('brightline-studio.com', 'brightline-studio.com'), false);
  assert.equal(isLookalike('paypal.com', 'brightline-studio.com'), false);
});

check('suspicious email: the whole batch is held until the owner confirms it with the real sender', () => {
  const items = review(SAMPLE_FRAUD_EML);
  assert.equal(items.length, 6);
  assert.ok(items.every((i) => i.state === 'held' && i.findings.some((f) => f.code === 'SENDER_UNVERIFIED')));
  const maria = items.find((i) => i.name === 'Maria Lopez')!;
  for (const code of ['HEADER_LOOKALIKE_DOMAIN', 'HEADER_REPLY_TO_MISMATCH', 'HEADER_AUTH_FAIL']) {
    assert.ok(maria.findings.some((f) => f.code === code), code);
  }
});

check('after the batch is confirmed: Maria stays held, Tom warned, the rest clear', () => {
  const parsed = parseEml(SAMPLE_FRAUD_EML);
  const items = evaluateItems(parseLines(parsed.body, PAYEES), {
    rules: SEED_RULES, payees: PAYEES, history, email: emailEvidence(parsed, ORG.domain), source: parsed.body, senderConfirmed: true,
  });
  const by = Object.fromEntries(items.map((i) => [i.name, i.state]));
  assert.equal(by['Maria Lopez'], 'held');
  assert.equal(by['Tom Becker'], 'warn');
  for (const n of ['Priya Nayar', 'James Chen', 'Aisha Khan', 'Diego Ruiz']) assert.equal(by[n], 'clear', n);
});

check('genuine email: every payout goes straight through', () => {
  const items = review(SAMPLE_GENUINE_EML);
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.state === 'clear'), JSON.stringify(items.map((i) => [i.name, i.state, i.findings])));
});

check('pasted text without headers says the sender could not be checked', () => {
  const items = review('- Maria Lopez $4,800 maria.new@example.net');
  assert.ok(items[0].findings.some((f) => f.code === 'HEADERS_NOT_PROVIDED'));
});

check('a misread amount is held, not paid', () => {
  const parsed = parseEml(SAMPLE_GENUINE_EML);
  const rows = parseLines(parsed.body, PAYEES).map((r) => (r.name === 'Priya Nayar' ? { ...r, amount: 12000 } : r));
  const items = evaluateItems(rows, { rules: SEED_RULES, payees: PAYEES, history, email: emailEvidence(parsed, ORG.domain), source: parsed.body });
  assert.equal(items.find((i) => i.name === 'Priya Nayar')!.state, 'held');
});

check('rule patterns: supported rules compile, unsupported ones are refused', () => {
  const a = compileWithPatterns('Hold any single payment above $5,000');
  assert.ok(a.ok && a.rule.kind === 'max_amount' && a.rule.params.limit === 5000);
  assert.equal(compileWithPatterns('Block anyone from Canada').ok, false);
});

check('synthetic evaluation is reproducible', () => {
  const a = runEvaluation();
  const b = runEvaluation();
  assert.deepEqual(a.genuine, b.genuine);
  console.log(`  genuine straight through ${a.genuine.instant}/${a.genuine.n}, fraud caught ${a.fraud.held + a.fraud.warned}/${a.fraud.n}`);
});

check('a first name alone matches the one payee who has it', () => {
  const items = evaluateItems(
    [{ rowId: 'x', name: 'Maria', receiver: 'maria.lopez.pay@gmail.com', receiverSource: 'request', amount: 4800, currency: 'USD', wallet: 'PAYPAL', note: '', sourceQuote: 'Maria $4,800 maria.lopez.pay@gmail.com' }],
    { rules: SEED_RULES, payees: PAYEES, history, email: { provided: false, urgencyPhrases: [] }, source: 'Maria $4,800 maria.lopez.pay@gmail.com' },
  );
  assert.equal(items[0].payeeId, 'maria');
  assert.equal(items[0].state, 'held');
});

check('a big jump below the 2x rule is a warning, not a hold', () => {
  const items = evaluateItems(
    [{ rowId: 't', name: 'Tom Becker', receiver: PAYEES.find((p) => p.id === 'tom')!.email, receiverSource: 'on_file', amount: 1100, currency: 'USD', wallet: 'PAYPAL', note: '', sourceQuote: 'Tom Becker $1,100' }],
    { rules: SEED_RULES, payees: PAYEES, history, email: { provided: true, urgencyPhrases: [] }, source: 'Tom Becker $1,100' },
  );
  assert.equal(items[0].state, 'warn');
  assert.ok(items[0].findings.some((f) => f.code === 'AMOUNT_OUTLIER' && f.severity === 'warn'));
});

check('scenario library: each scenario gives the result its card promises', () => {
  const states = (id: string) => {
    const items = review(SCENARIOS.find((s) => s.id === id)!.text);
    return items.map((i) => `${i.name.split(' ')[0]}:${i.state}`).join(' ');
  };
  assert.equal(states('hacked-boss'), 'Priya:clear James:clear Aisha:clear Diego:held Maria:clear');
  assert.equal(states('hacked-payee'), 'Priya:clear James:clear Aisha:clear Diego:clear Maria:held');
  assert.equal(states('ghost'), 'Priya:clear James:clear Aisha:clear Diego:clear Maria:clear Alex:held');
  assert.equal(states('inflated'), 'Priya:clear James:held Aisha:clear Diego:clear Maria:clear');
  assert.equal(states('paid-twice'), 'Priya:clear James:clear Aisha:clear Maria:clear Diego:clear Maria:warn');
});
