// Preflight's API. One route file dispatches on the path to keep the surface easy to read:
//   GET  /api/preflight/state                 everything the UI shows
//   GET  /api/preflight/inbox                 the simulated payee inbox (verification messages)
//   POST /api/preflight/reviews               { text }  -> extract + check + investigate
//   POST /api/preflight/reviews/:id/send      send clear + acknowledged rows as one PayPal batch
//   POST /api/preflight/reviews/:id/refresh   re-read PayPal payout statuses
//   POST /api/preflight/items/:rowId          { action: edit|ack|release|cancel|pullback, ... }
//   POST /api/preflight/rules                 { text }  -> compile + backtest (unconfirmed)
//   POST /api/preflight/rules/:id             { confirmed } | { delete: true }
//   POST /api/preflight/verify                { token, answer: yes|no }
//   POST /api/preflight/eval                  run the synthetic evaluation
//   POST /api/preflight/reset                 back to the seed data

import { rateLimited } from '@/lib/rate-limit';
import { runEvaluation } from '@/lib/preflight/evaluate';
import { snapshot, inbox } from '@/lib/preflight/snapshot';
import {
  PreflightError, acknowledge, answerVerification, confirmRule, createReview, deleteRule, editItem,
  ownerCancel, ownerRelease, proposeRule, pullBack, refreshReview, sendReview,
} from '@/lib/preflight/service';
import { resetStore } from '@/lib/preflight/store';

type Ctx = { params: Promise<{ path: string[] }> };

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET(_request: Request, ctx: Ctx) {
  const [first] = (await ctx.params).path;
  if (first === 'state') return json(snapshot());
  if (first === 'inbox') return json(inbox());
  return fail('Not found', 404);
}

export async function POST(request: Request, ctx: Ctx) {
  const [first, id, verb] = (await ctx.params).path;
  const b = await body(request);
  try {
    switch (first) {
      case 'reviews': {
        if (!id) {
          if (rateLimited(request, 'preflight-ai', 10)) return fail('Too many requests. Wait a minute.', 429);
          const text = String(b.text ?? '');
          if (!text.trim()) return fail('Paste or upload a payment request first.');
          if (text.length > 50_000) return fail('That request is too long for the demo (50,000 characters max).');
          await createReview({ text });
        } else if (verb === 'send') await sendReview(id);
        else if (verb === 'refresh') await refreshReview(id);
        else return fail('Not found', 404);
        return json(snapshot());
      }
      case 'items': {
        if (!id) return fail('Missing row id');
        const action = String(b.action);
        if (action === 'edit') {
          const patch: Record<string, unknown> = {};
          if (typeof b.amount === 'number' && b.amount > 0) patch.amount = Math.round(b.amount * 100) / 100;
          if (typeof b.receiver === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.receiver)) patch.receiver = b.receiver.trim();
          if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
          if (Object.keys(patch).length === 0) return fail('Nothing valid to change (amount must be positive, email must look like an email).');
          editItem(id, patch);
        } else if (action === 'ack') acknowledge(id);
        else if (action === 'release') await ownerRelease(id, b.calledPayee === true);
        else if (action === 'cancel') ownerCancel(id);
        else if (action === 'pullback') await pullBack(id);
        else return fail(`Unknown action ${action}`);
        return json(snapshot());
      }
      case 'rules': {
        if (!id) {
          if (rateLimited(request, 'preflight-ai', 10)) return fail('Too many requests. Wait a minute.', 429);
          const text = String(b.text ?? '').trim();
          if (!text) return fail('Write a rule first.');
          const result = await proposeRule(text.slice(0, 500));
          if (!result.ok) return json({ ...snapshot(), problem: result.problem });
          return json(snapshot());
        }
        if (b.delete === true) deleteRule(id);
        else confirmRule(id, b.confirmed === true);
        return json(snapshot());
      }
      case 'verify': {
        const answer = b.answer === 'yes' ? 'yes' : b.answer === 'no' ? 'no' : null;
        if (!answer || typeof b.token !== 'string') return fail('Missing answer');
        const { item } = await answerVerification(b.token, answer);
        return json({ ok: true, state: item.state, paypalStatus: item.paypal?.status ?? null, name: item.name });
      }
      case 'eval':
        return json(runEvaluation());
      case 'reset':
        resetStore();
        return json(snapshot());
      default:
        return fail('Not found', 404);
    }
  } catch (e) {
    if (e instanceof PreflightError) return fail(e.message);
    console.error('[preflight]', e);
    return fail(e instanceof Error ? e.message : 'Something went wrong', 500);
  }
}
