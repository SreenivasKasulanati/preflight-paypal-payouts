// PayPal Payouts: create a batch, read item statuses, cancel an unclaimed item.
// Docs: https://developer.paypal.com/api/payments.payouts-batch/v1/
// With no PayPal credentials (or PREFLIGHT_PAYPAL_MOCK=1) a clearly labelled simulator stands in,
// so the app can be tried without an account. The UI always shows which one is in use.

import { PayPalApiError, paypalConfigured, paypalGet, post } from '../paypal';
import { PAYEE_DOMAIN } from './seed';
import type { PayPalItemStatus, Wallet } from './types';

export const payoutsMode = () => (process.env.PREFLIGHT_PAYPAL_MOCK === '1' || !paypalConfigured() ? 'simulated' : 'sandbox');

/**
 * The PayPal sandbox rejects recipient_wallet VENMO ("Recipient wallet not supported in sandbox"),
 * so in the sandbox Venmo rows are sent to the PayPal wallet and labelled as such in the UI.
 * Live sends (not used in this demo) would keep VENMO.
 */
export const walletFor = (wallet: Wallet): Wallet => (wallet === 'VENMO' && payoutsMode() === 'sandbox' ? 'PAYPAL' : wallet);

export type OutgoingItem = { senderItemId: string; receiver: string; amount: number; wallet: Wallet; note: string };
export type ItemResult = { senderItemId: string; payoutItemId?: string; status?: PayPalItemStatus; error?: string };

// --- Simulator ---------------------------------------------------------------------------------
type SimItem = ItemResult & { receiver: string };
const simHost = globalThis as { __preflightSim?: Map<string, SimItem[]> };
const sim: Map<string, SimItem[]> = (simHost.__preflightSim ??= new Map<string, SimItem[]>());
// The demo's own payees have accounts; any other address is treated as having none yet.
const simStatus = (receiver: string): PayPalItemStatus => (receiver.toLowerCase().endsWith(`@${PAYEE_DOMAIN}`) ? 'SUCCESS' : 'UNCLAIMED');

// --- API -----------------------------------------------------------------------------------------

export async function createBatch(batchRef: string, items: OutgoingItem[]): Promise<{ batchId: string; status: string }> {
  if (payoutsMode() === 'simulated') {
    const batchId = `SIM-${batchRef}`;
    sim.set(batchId, items.map((i, n) => ({ senderItemId: i.senderItemId, receiver: i.receiver, payoutItemId: `SIMITEM${n}${batchRef}`.slice(0, 20), status: 'PENDING' })));
    return { batchId, status: 'PENDING' };
  }
  const res = await post<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
    '/v1/payments/payouts',
    {
      sender_batch_header: {
        sender_batch_id: batchRef, // PayPal rejects a repeated id for 30 days, which stops double-sends
        email_subject: 'You have a payout from Brightline Studio',
        email_message: 'Checked by Preflight before it was sent.',
      },
      items: items.map((i) => ({
        recipient_type: 'EMAIL', // the sandbox does not support PHONE
        receiver: i.receiver,
        amount: { value: i.amount.toFixed(2), currency: 'USD' },
        note: i.note || 'Payout from Brightline Studio',
        sender_item_id: i.senderItemId,
        recipient_wallet: walletFor(i.wallet),
      })),
    },
  );
  return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

export async function getBatch(batchId: string): Promise<{ status: string; items: ItemResult[] }> {
  if (payoutsMode() === 'simulated' || batchId.startsWith('SIM-')) {
    const items = sim.get(batchId) ?? [];
    for (const i of items) if (i.status === 'PENDING') i.status = simStatus(i.receiver); // settles on first read
    return { status: 'SUCCESS', items };
  }
  const res = await paypalGet<{
    batch_header: { batch_status: string };
    items?: { payout_item_id: string; transaction_status?: PayPalItemStatus; payout_item: { sender_item_id: string }; errors?: { name: string } }[];
  }>(`/v1/payments/payouts/${encodeURIComponent(batchId)}?page_size=1000`);
  return {
    status: res.batch_header.batch_status,
    items: (res.items ?? []).map((i) => ({
      senderItemId: i.payout_item.sender_item_id,
      payoutItemId: i.payout_item_id,
      status: i.transaction_status,
      error: i.errors?.name,
    })),
  };
}

/** Cancels a payout item. PayPal allows this only while the item is UNCLAIMED. */
export async function cancelItem(payoutItemId: string): Promise<PayPalItemStatus> {
  if (payoutsMode() === 'simulated' || payoutItemId.startsWith('SIMITEM')) {
    for (const items of sim.values()) {
      const i = items.find((x) => x.payoutItemId === payoutItemId);
      if (i) {
        if (i.status !== 'UNCLAIMED') throw new Error('Only UNCLAIMED payout items can be cancelled.');
        i.status = 'RETURNED';
        return 'RETURNED';
      }
    }
    throw new Error('Unknown payout item');
  }
  // The sandbox sometimes answers a valid cancel with a 500. Retry briefly; a repeat on an item that
  // was in fact cancelled comes back ITEM_ALREADY_CANCELLED, which means the money is returned.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await post<{ transaction_status: PayPalItemStatus }>(`/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`, {});
      return res.transaction_status;
    } catch (e) {
      if (e instanceof PayPalApiError && e.message.includes('ITEM_ALREADY_CANCELLED')) return 'RETURNED';
      if (!(e instanceof PayPalApiError) || e.status < 500 || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
