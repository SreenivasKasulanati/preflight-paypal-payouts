// What the API routes call. Every state change goes through here and is written to the audit log.

import { randomBytes, randomInt } from 'node:crypto';
import { compileRule } from './compile';
import { emailEvidence, parseEml } from './email';
import { extractRows } from './extract';
import { investigate, investigateWithRules } from './investigate';
import { cancelItem, createBatch, getBatch, payoutsMode, walletFor } from './payouts';
import { backtest, evaluateItems, senderSuspicious, usdText } from './rules';
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

/** Holds of the row's own, beyond the batch-wide suspicious-sender hold. */
const ownHold = (item: ReviewItem) => item.findings.some((f) => f.severity === 'hold' && f.code !== 'SENDER_UNVERIFIED');

function holdDetails(item: ReviewItem) {
  if (!ownHold(item)) return; // held only by the batch: confirming the batch releases it
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
    senderSuspicious: senderSuspicious(email),
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
  // Rows held only by the batch-wide sender hold need no case of their own: the banner explains them.
  await Promise.all(
    items
      .filter((i) => i.state === 'held' && ownHold(i))
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
  const [checked] = evaluateItems([updated], {
    rules: s.rules, payees: s.payees, history: s.history, email: review.email, source, senderConfirmed: !!review.senderConfirmedAt,
  });
  // The old case no longer matches the edited row, so it's rebuilt from the new findings (no AI call).
  // A second payout to the same person in this batch stays flagged after an edit.
  const dup = item.findings.find((f) => f.code === 'DUPLICATE_IN_BATCH');
  if (dup && !checked.findings.some((f) => f.code === 'DUPLICATE_IN_BATCH')) {
    checked.findings.push(dup);
    if (checked.state === 'clear') checked.state = 'warn';
  }
  Object.assign(item, checked, { investigation: checked.state === 'clear' ? undefined : investigateWithRules(checked) });
  if (item.state === 'held' && !item.verifyToken) holdDetails(item);
  if (!ownHold(item)) Object.assign(item, { coolingUntil: undefined, verifyToken: undefined, verificationDraft: undefined, phoneCode: undefined });
  log({ reviewId: review.id, rowId, action: 'row_edited', detail: JSON.stringify(patch) });
  return item;
}

/**
 * The owner confirmed the batch with the real sender through a trusted channel (a call, in person).
 * The batch-wide hold lifts; rows with holds of their own (Maria) stay held.
 */
export function confirmSender(reviewId: string, confirmed: boolean) {
  const review = store().reviews.find((r) => r.id === reviewId);
  if (!review) throw new PreflightError('Unknown review');
  if (!review.senderSuspicious) throw new PreflightError('This batch has no sender warning.');
  if (!confirmed) throw new PreflightError('Tick that you confirmed the batch with the real sender first.');
  review.senderConfirmedAt = new Date().toISOString();
  for (const item of review.items) {
    if (item.state !== 'held' && item.state !== 'warn' && item.state !== 'clear') continue;
    item.findings = item.findings.filter((f) => f.code !== 'SENDER_UNVERIFIED');
    item.state = item.findings.some((f) => f.severity === 'hold') ? 'held' : item.findings.some((f) => f.severity === 'warn') ? 'warn' : 'clear';
    if (item.state !== 'held') item.investigation = item.state === 'clear' ? undefined : investigateWithRules(item);
  }
  log({ reviewId, action: 'batch_confirmed_with_sender', detail: 'owner confirmed through a trusted channel; batch-wide hold lifted' });
  return review;
}

/**
 * The owner checked with the real sender and they did not send this request: every row that
 * hasn't gone out is stopped as fraud, including the normal-looking ones (they came from the
 * same fake email). Real payouts to those people go through a genuine request.
 */
export function rejectSender(reviewId: string) {
  const review = store().reviews.find((r) => r.id === reviewId);
  if (!review) throw new PreflightError('Unknown review');
  if (!review.senderSuspicious) throw new PreflightError('This batch has no sender warning.');
  if (review.senderConfirmedAt) throw new PreflightError('This batch was already confirmed with the sender.');
  let stopped = 0;
  for (const item of review.items) {
    if (item.state === 'sent' || item.state === 'denied') continue;
    Object.assign(item, { state: 'denied', verifyToken: undefined, phoneCode: undefined, coolingUntil: undefined });
    stopped++;
  }
  review.senderRejectedAt = new Date().toISOString();
  log({ reviewId, action: 'batch_rejected_fake_sender', detail: `the real sender did not send it; ${stopped} payouts stopped, nothing sent` });
  return review;
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
    if (answer === 'no') {
      Object.assign(item, { state: 'denied', verifyToken: undefined, phoneCode: undefined });
      log({ reviewId: review.id, rowId: item.rowId, action: 'payee_denied', detail: `${item.name} said they did not request ${item.receiver}` });
      return { item, review };
    }
    const payee = s.payees.find((p) => p.id === item.payeeId);
    // New payout details: a "Yes" from the mailbox isn't enough, because the mailbox may be what's
    // hacked. A code goes by text to the phone on file, and only the code releases the payout.
    if (payee && payee.email.toLowerCase() !== item.receiver.toLowerCase()) {
      if (!item.phoneCode) {
        item.phoneCode = String(randomInt(100000, 1000000));
        item.phoneCodeTries = 0;
        log({ reviewId: review.id, rowId: item.rowId, action: 'code_texted', detail: `email said yes; code texted to ${payee.phoneOnFile}` });
      }
      return { item, review, needsCode: true };
    }
    return { item, review, ...(await releaseVerified(review, item)) };
  }
  throw new PreflightError('This link is not valid or has expired.');
}

/** Step two: the code texted to the phone on file. Three wrong codes stop the payout as fraud. */
export async function answerCode(token: string, code: string) {
  const s = store();
  for (const review of s.reviews) {
    const item = review.items.find((i) => i.verifyToken === token);
    if (!item) continue;
    if (item.state !== 'held' || !item.phoneCode) throw new PreflightError('No code is waiting for this payout.');
    if (code.trim() !== item.phoneCode) {
      item.phoneCodeTries = (item.phoneCodeTries ?? 0) + 1;
      if (item.phoneCodeTries >= 3) {
        Object.assign(item, { state: 'denied', verifyToken: undefined, phoneCode: undefined });
        log({ reviewId: review.id, rowId: item.rowId, action: 'code_failed', detail: '3 wrong codes: stopped as fraud' });
        throw new PreflightError('Three wrong codes. The payout is stopped as fraud and nothing was sent.');
      }
      throw new PreflightError(`That code is wrong. ${3 - item.phoneCodeTries} tries left.`);
    }
    log({ reviewId: review.id, rowId: item.rowId, action: 'code_confirmed', detail: 'code from the phone on file matched' });
    return { item, review, ...(await releaseVerified(review, item)) };
  }
  throw new PreflightError('This link is not valid or has expired.');
}

async function releaseVerified(review: Review, item: ReviewItem) {
  const payee = store().payees.find((p) => p.id === item.payeeId);
  if (payee) {
    // Verified once: the new details become the trusted ones, so next time goes straight through.
    payee.email = item.receiver;
    payee.wallet = item.wallet;
    payee.trusted = true;
  }
  Object.assign(item, { releasedBy: 'payee', verifyToken: undefined, phoneCode: undefined });
  log({ reviewId: review.id, rowId: item.rowId, action: 'payee_verified', detail: `${item.name} confirmed ${item.receiver}` });
  await sendItems(review, [item], 'verified by payee');
  await refreshReview(review.id);
  return { sent: true };
}

/** The owner releases a held row after the cooling-off period, having called the number on file. */
export async function ownerRelease(rowId: string, calledPayee: boolean) {
  const { review, item } = findItem(rowId);
  if (item.state !== 'held') throw new PreflightError('Only held rows can be released.');
  if (!ownHold(item)) throw new PreflightError('Confirm the batch with the real sender first (the red banner above the grid).');
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
