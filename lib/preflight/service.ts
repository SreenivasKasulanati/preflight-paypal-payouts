// What the API routes call. Every state change goes through here and is written to the audit log.

import { randomBytes } from 'node:crypto';
import { compileRule } from './compile';
import { emailEvidence, parseEml } from './email';
import { extractRows } from './extract';
import { investigate, investigateWithRules } from './investigate';
import { cancelItem, createBatch, getBatch, payoutsMode, walletFor } from './payouts';
import { backtest, evaluateItems, usdText } from './rules';
import { ORG } from './seed';
import { log, store } from './store';
import type { Review, ReviewItem, Rule } from './types';

const COOLING_MINUTES = Number(process.env.PREFLIGHT_COOLING_MINUTES ?? 10);
const newId = (n = 8) => randomBytes(n).toString('hex').slice(0, n);

export class PreflightError extends Error {}

function findItem(rowId: string): { review: Review; item: ReviewItem } {
  for (const review of store().reviews) {
    const item = review.items.find((i) => i.rowId === rowId);
    if (item) return { review, item };
  }
  throw new PreflightError('Unknown payout row');
}

const sentStatuses = () =>
  store().reviews.flatMap((r) => r.items.filter((i) => i.paypal).map((i) => ({ receiver: i.receiver, status: i.paypal?.status })));

function holdDetails(item: ReviewItem) {
  const s = store();
  const payee = s.payees.find((p) => p.id === item.payeeId);
  item.coolingUntil = new Date(Date.now() + COOLING_MINUTES * 60_000).toISOString();
  item.verifyToken = newId(16);
  // Verification always goes to the email on file, never to the address in the request.
  if (payee) {
    item.verificationDraft =
      `To: ${payee.email}\nSubject: Quick check before ${ORG.name} pays you\n\n` +
      `Hi ${payee.name.split(' ')[0]},\n\n${ORG.name} received a request to pay you ${usdText(item.amount)} ` +
      `to ${item.receiver}${item.receiver.toLowerCase() !== payee.email.toLowerCase() ? ' (a new address)' : ''}. ` +
      `Is this right?\n\nYes / No: {verify_link}\n\nIf you didn't ask for this, choose No. Nothing is sent until you answer.\n\n${ORG.owner}, ${ORG.name}`;
  }
}

/** Intake: text, an .eml, or CSV in; a checked review out. */
export async function createReview(input: { text: string }) {
  const s = store();
  const parsed = parseEml(input.text);
  const email = emailEvidence(parsed, ORG.domain);
  const extracted = await extractRows(parsed.body, s.payees);
  const { rows, by } = extracted;
  const aiError = 'aiError' in extracted ? extracted.aiError : undefined;
  if (rows.length === 0) throw new PreflightError('No payouts were found in that request.');
  const items = evaluateItems(rows, { rules: s.rules, payees: s.payees, history: s.history, email, source: parsed.body });
  const review: Review = {
    id: newId(),
    createdAt: new Date().toISOString(),
    source: parsed.hasHeaders ? 'email' : rows[0]?.sourceQuote.includes(',') ? 'csv' : 'text',
    extractedBy: by,
    ...(aiError && { aiNote: `AI was unavailable (${aiError.includes('429') ? 'OpenAI rate limit' : 'error'}), so the code parser read this request.` }),
    email,
    items,
  };
  for (const item of items) if (item.state === 'held') holdDetails(item);
  s.reviews.unshift(review);
  log({ reviewId: review.id, action: 'review_created', detail: `${items.length} rows (${by}); ${items.filter((i) => i.state === 'held').length} held` });

  // The AI investigates held rows only; a warning gets the rules summary, which keeps AI requests
  // (and rate limits) to what matters. Failures fall back to the rules summary too.
  for (const item of items) if (item.state === 'warn') item.investigation = investigateWithRules(item);
  await Promise.all(
    items
      .filter((i) => i.state === 'held')
      .map(async (item) => {
        try {
          item.investigation = await investigate({ item, payees: s.payees, history: s.history, email, sentStatuses: sentStatuses() });
        } catch (e) {
          console.error('[preflight] investigator failed, using rules summary', e);
          item.investigation = investigateWithRules(item);
        }
      }),
  );
  return review;
}

/** The owner edits a cell (amount, email, name): the row is re-checked on the spot. */
export function editItem(rowId: string, patch: Partial<Pick<ReviewItem, 'amount' | 'receiver' | 'name' | 'wallet'>>) {
  const s = store();
  const { review, item } = findItem(rowId);
  if (item.state === 'sent' || item.state === 'denied') throw new PreflightError('This row is already final.');
  const updated = { ...item, ...patch, receiverSource: patch.receiver ? ('request' as const) : item.receiverSource };
  // An owner edit is the owner's own data, so it counts as verified against the source.
  const source = `${updated.name} ${updated.receiver} ${updated.amount}`;
  const [checked] = evaluateItems([updated], { rules: s.rules, payees: s.payees, history: s.history, email: review.email, source });
  Object.assign(item, checked, { investigation: checked.state === 'clear' ? undefined : item.investigation });
  if (item.state === 'held' && !item.verifyToken) holdDetails(item);
  if (item.state !== 'held') Object.assign(item, { coolingUntil: undefined, verifyToken: undefined, verificationDraft: undefined });
  log({ reviewId: review.id, rowId, action: 'row_edited', detail: JSON.stringify(patch) });
  return item;
}

export function acknowledge(rowId: string) {
  const { review, item } = findItem(rowId);
  if (item.state !== 'warn') throw new PreflightError('Only warnings can be acknowledged.');
  item.acknowledged = true;
  log({ reviewId: review.id, rowId, action: 'warning_acknowledged', detail: item.findings.map((f) => f.message).join(' | ') });
  return item;
}

async function sendItems(review: Review, items: ReviewItem[], why: string) {
  if (items.length === 0) return;
  const s = store();
  const batchRef = `PF-${review.id}-${newId(6)}`;
  const outgoing = items.map((i) => ({ senderItemId: `${review.id}-${i.rowId}`, receiver: i.receiver, amount: i.amount, wallet: i.wallet, note: i.note }));
  const { batchId } = await createBatch(batchRef, outgoing);
  for (const i of items) {
    i.state = 'sent';
    i.paypal = { batchId, senderItemId: `${review.id}-${i.rowId}`, status: 'PENDING', walletSent: walletFor(i.wallet) };
    // Sent payouts join the history, so baselines learn from every clean payment.
    if (i.payeeId) {
      s.history.push({ id: `${review.id}-${i.rowId}`, payeeId: i.payeeId, date: new Date().toISOString(), amount: i.amount, receiver: i.receiver, wallet: i.wallet });
    }
  }
  const swapped = items.filter((i) => i.wallet !== walletFor(i.wallet)).length;
  log({
    reviewId: review.id,
    action: 'payout_batch_created',
    detail: `${batchId} (${payoutsMode()}): ${items.length} items, ${why}${swapped ? `; ${swapped} Venmo item(s) sent to the PayPal wallet because the sandbox has no Venmo` : ''}`,
  });
}

/** Sends every clear row and every acknowledged warning in one PayPal batch. Held rows stay put. */
export async function sendReview(reviewId: string) {
  const review = store().reviews.find((r) => r.id === reviewId);
  if (!review) throw new PreflightError('Unknown review');
  const ready = review.items.filter((i) => i.state === 'clear' || (i.state === 'warn' && i.acknowledged));
  if (ready.length === 0) throw new PreflightError('Nothing is ready to send. Acknowledge warnings first.');
  await sendItems(review, ready, 'approved by owner');
  await refreshReview(reviewId);
  return review;
}

export async function refreshReview(reviewId: string) {
  const review = store().reviews.find((r) => r.id === reviewId);
  if (!review) throw new PreflightError('Unknown review');
  const batchIds = [...new Set(review.items.map((i) => i.paypal?.batchId).filter((b): b is string => !!b))];
  for (const batchId of batchIds) {
    const batch = await getBatch(batchId);
    for (const result of batch.items) {
      const item = review.items.find((i) => i.paypal?.senderItemId === result.senderItemId);
      if (item?.paypal) Object.assign(item.paypal, { itemId: result.payoutItemId, status: result.status });
    }
  }
  return review;
}

/** The payee's answer, from the link sent to the email on file. */
export async function answerVerification(token: string, answer: 'yes' | 'no') {
  const s = store();
  for (const review of s.reviews) {
    const item = review.items.find((i) => i.verifyToken === token);
    if (!item) continue;
    if (item.state !== 'held') throw new PreflightError('This request was already answered.');
    item.verifyToken = undefined;
    if (answer === 'no') {
      item.state = 'denied';
      log({ reviewId: review.id, rowId: item.rowId, action: 'payee_denied', detail: `${item.name} said they did not request ${item.receiver}` });
      return { item, review };
    }
    const payee = s.payees.find((p) => p.id === item.payeeId);
    if (payee) {
      // Verified once: the new details become the trusted ones, so next time goes straight through.
      payee.email = item.receiver;
      payee.wallet = item.wallet;
      payee.trusted = true;
    }
    item.releasedBy = 'payee';
    log({ reviewId: review.id, rowId: item.rowId, action: 'payee_verified', detail: `${item.name} confirmed ${item.receiver}` });
    await sendItems(review, [item], 'verified by payee');
    await refreshReview(review.id);
    return { item, review };
  }
  throw new PreflightError('This link is not valid or has expired.');
}

/** The owner releases a held row after the cooling-off period, having called the number on file. */
export async function ownerRelease(rowId: string, calledPayee: boolean) {
  const { review, item } = findItem(rowId);
  if (item.state !== 'held') throw new PreflightError('Only held rows can be released.');
  if (!calledPayee) throw new PreflightError('Confirm you called the payee on the number on file first.');
  if (item.coolingUntil && Date.parse(item.coolingUntil) > Date.now()) {
    throw new PreflightError(`Cooling-off ends at ${new Date(item.coolingUntil).toLocaleTimeString('en-US')}. Payee verification can release it sooner.`);
  }
  item.releasedBy = 'owner';
  item.verifyToken = undefined;
  log({ reviewId: review.id, rowId, action: 'owner_released', detail: 'after cooling-off, call-back confirmed' });
  await sendItems(review, [item], 'released by owner after call-back');
  await refreshReview(review.id);
  return item;
}

export function ownerCancel(rowId: string) {
  const { review, item } = findItem(rowId);
  if (item.state === 'sent') throw new PreflightError('Already sent. Use "Pull back" if PayPal shows it unclaimed.');
  item.state = 'denied';
  item.verifyToken = undefined;
  log({ reviewId: review.id, rowId, action: 'owner_cancelled', detail: 'stopped before sending' });
  return item;
}

/** Pulls back a sent payout that nobody has claimed yet (PayPal only allows this while UNCLAIMED). */
export async function pullBack(rowId: string) {
  const { review, item } = findItem(rowId);
  await refreshReview(review.id);
  if (!item.paypal?.itemId || item.paypal.status !== 'UNCLAIMED') {
    throw new PreflightError(`PayPal only allows cancelling unclaimed payouts; this one is ${item.paypal?.status ?? 'not sent'}.`);
  }
  try {
    item.paypal.status = await cancelItem(item.paypal.itemId);
  } catch (e) {
    // Before reporting failure, read what PayPal actually holds: the cancel may have gone through.
    await refreshReview(review.id);
    if (item.paypal.status !== 'RETURNED') {
      log({ reviewId: review.id, rowId, action: 'pull_back_failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      throw new PreflightError(`PayPal couldn't cancel it just now (status is still ${item.paypal.status}). It is still unclaimed, so try Pull back again in a minute.`);
    }
  }
  log({ reviewId: review.id, rowId, action: 'payout_pulled_back', detail: `${item.paypal.itemId} -> ${item.paypal.status}` });
  return item;
}

// --- Rules --------------------------------------------------------------------------------------

export async function proposeRule(text: string) {
  const s = store();
  const compiled = await compileRule(text);
  if (!compiled.ok) return { ok: false as const, problem: compiled.problem };
  const rule: Rule = { ...compiled.rule, id: `r${newId(4)}`, confirmed: false };
  rule.backtest = backtest(rule, s.payees, s.history);
  s.rules.push(rule);
  log({ action: 'rule_proposed', detail: `${rule.readBack} (${compiled.by})` });
  return { ok: true as const, rule };
}

export function confirmRule(id: string, confirmed: boolean) {
  const rule = store().rules.find((r) => r.id === id);
  if (!rule) throw new PreflightError('Unknown rule');
  rule.confirmed = confirmed;
  log({ action: confirmed ? 'rule_confirmed' : 'rule_paused', detail: rule.readBack });
  return rule;
}

export function deleteRule(id: string) {
  const s = store();
  s.rules = s.rules.filter((r) => r.id !== id);
  log({ action: 'rule_deleted', detail: id });
}
