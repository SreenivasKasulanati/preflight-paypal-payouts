// Turns a payment request (email, pasted text or CSV) into payout rows. CSV is parsed with code;
// free text goes to the AI. Either way every row is then checked against the source text in
// rules.ts (extractionVerified), so a misread amount or email is held, not paid.

import { aiAvailable, list, num, obj, oneOf, str, structured } from './llm';
import { matchPayee } from './rules';
import type { Payee, RequestRow, Wallet } from './types';

const id = () => Math.random().toString(36).slice(2, 10);

export function parseCsv(text: string, payees: Payee[]): RequestRow[] | null {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  if (col('name') === -1 || col('amount') === -1) return null;
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const name = cells[col('name')];
    const given = col('email') >= 0 ? cells[col('email')] : '';
    const onFile = matchPayee({ name, receiver: given }, payees);
    const wallet = (col('wallet') >= 0 ? cells[col('wallet')]?.toUpperCase() : '') as Wallet;
    return {
      rowId: id(),
      name,
      receiver: given || onFile?.email || '',
      receiverSource: given ? 'request' : 'on_file',
      amount: Number(cells[col('amount')].replace(/[$,]/g, '')),
      currency: 'USD',
      wallet: wallet === 'VENMO' ? 'VENMO' : (onFile?.wallet ?? 'PAYPAL'),
      note: col('note') >= 0 ? cells[col('note')] ?? '' : '',
      sourceQuote: line,
    } satisfies RequestRow;
  });
}

/** A basic line parser for when no AI key is configured: "Name $1,200 (Venmo)" style lines only. */
export function parseLines(text: string, payees: Payee[]): RequestRow[] {
  const rows: RequestRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*•]?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s*[:\-–]?\s*\$([\d,]+(?:\.\d{2})?)(.*)$/);
    if (!m) continue;
    const email = m[3].match(/[^\s()<>]+@[^\s()<>]+/)?.[0];
    const onFile = matchPayee({ name: m[1], receiver: email ?? '' }, payees);
    rows.push({
      rowId: id(),
      name: m[1],
      receiver: email ?? onFile?.email ?? '',
      receiverSource: email ? 'request' : 'on_file',
      amount: Number(m[2].replace(/,/g, '')),
      currency: 'USD',
      wallet: /venmo/i.test(m[3]) ? 'VENMO' : (onFile?.wallet ?? 'PAYPAL'),
      note: '',
      sourceQuote: line.trim(),
    });
  }
  // Sentences like "Maria switched accounts. Send her $4,800 to new@mail.com": a known payee's first
  // name, then an amount and an email in the same or the next sentence.
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  sentences.forEach((sentence, i) => {
    const pair = `${sentences[i - 1] ?? ''} ${sentence}`;
    const amount = sentence.match(/\$([\d,]+(?:\.\d{2})?)/)?.[1];
    const email = sentence.match(/[^\s()<>,]+@[^\s()<>,]+\.[a-z]{2,}/i)?.[0];
    if (!amount || !email) return;
    // The payee named last before this sentence's amount is the one it refers to.
    const before = pair.slice(0, pair.lastIndexOf(sentence) + sentence.indexOf('$'));
    const payee = payees
      .map((p) => ({ p, at: before.search(new RegExp(`\\b${p.name.split(' ')[0]}\\b`)) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => b.at - a.at)[0]?.p;
    if (!payee || rows.some((r) => r.name === payee.name)) return;
    rows.push({
      rowId: id(),
      name: payee.name,
      receiver: email,
      receiverSource: 'request',
      amount: Number(amount.replace(/,/g, '')),
      currency: 'USD',
      wallet: /venmo/i.test(sentence) ? 'VENMO' : payee.wallet,
      note: '',
      sourceQuote: pair.trim(),
    });
  });
  return rows;
}

type AiRow = { name: string; email: string | null; amount: number; wallet: 'PAYPAL' | 'VENMO' | 'UNSPECIFIED'; note: string; source_quote: string };

export async function extractWithAi(body: string, payees: Payee[]): Promise<RequestRow[]> {
  const { value } = await structured<{ rows: AiRow[] }>({
    name: 'payout_rows',
    instructions:
      'You read payment requests sent to a small business and list every payout the request asks for. ' +
      'Copy names, amounts and email addresses exactly as written. Use null for email when the request does not give one. ' +
      'Never invent a payout, an amount or an email. source_quote must be the exact sentence or line the row came from. ' +
      'Do not judge whether a request is legitimate; that is checked elsewhere. ' +
      `Known payees: ${payees.map((p) => p.name).join(', ')}. When the request refers to one of them by first name only, use their full name from this list.`,
    input: body,
    schema: obj({
      rows: list(
        obj({
          name: str('Payee full name as written'),
          email: { type: ['string', 'null'], description: 'Email exactly as written, or null' },
          amount: num('Amount in USD as a number'),
          wallet: oneOf(['PAYPAL', 'VENMO', 'UNSPECIFIED']),
          note: str('Short purpose, or empty string'),
          source_quote: str('Exact text the row came from'),
        }),
      ),
    }),
  });
  return value.rows.map((r) => {
    const onFile = matchPayee({ name: r.name, receiver: r.email ?? '' }, payees);
    return {
      rowId: id(),
      name: onFile?.name ?? r.name,
      receiver: r.email ?? onFile?.email ?? '',
      receiverSource: r.email ? 'request' : 'on_file',
      amount: r.amount,
      currency: 'USD',
      wallet: r.wallet === 'UNSPECIFIED' ? (onFile?.wallet ?? 'PAYPAL') : r.wallet,
      note: r.note,
      sourceQuote: r.source_quote,
    };
  });
}

export async function extractRows(body: string, payees: Payee[]) {
  const csv = parseCsv(body, payees);
  if (csv) return { rows: csv, by: 'parser' as const };
  if (aiAvailable()) {
    try {
      return { rows: await extractWithAi(body, payees), by: 'ai' as const };
    } catch (e) {
      // OpenAI down or rate-limited: fall back to the code parser rather than block the owner.
      // Every row is still checked against the source text, so nothing unverified can be paid.
      console.error('[preflight] AI extraction failed, using the parser', e);
      return { rows: parseLines(body, payees), by: 'parser' as const, aiError: e instanceof Error ? e.message.slice(0, 160) : String(e) };
    }
  }
  return { rows: parseLines(body, payees), by: 'parser' as const };
}
