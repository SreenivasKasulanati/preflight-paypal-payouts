// Reads a raw email (.eml text) with plain code. Every header signal here comes from the message
// itself; when no headers are present we say so rather than guess.

import type { EmailEvidence } from './types';

const URGENCY = [
  'urgent', 'asap', 'right away', 'immediately', 'before noon', 'by end of day', 'today only',
  'confidential', 'keep this between us', 'don\'t call', 'do not call', 'wire it now', 'need it now',
];

export type ParsedEmail = { headers: Record<string, string>; body: string; hasHeaders: boolean };

export function parseEml(raw: string): ParsedEmail {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? '' : text.slice(0, split);
  // Headers exist only if the first lines look like "Name: value" and include From.
  const looksLikeHeaders = /^[A-Za-z-]+:\s/.test(head) && /^from:/im.test(head);
  if (!looksLikeHeaders) return { headers: {}, body: text.trim(), hasHeaders: false };

  const headers: Record<string, string> = {};
  let last = '';
  for (const line of head.split('\n')) {
    if (/^\s/.test(line) && last) {
      headers[last] += ' ' + line.trim(); // folded header continuation
      continue;
    }
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) {
      last = m[1].toLowerCase();
      headers[last] = headers[last] ? `${headers[last]}, ${m[2]}` : m[2];
    }
  }
  return { headers, body: text.slice(split + 2).trim(), hasHeaders: true };
}

const addressOf = (v?: string) => v?.match(/<([^>]+)>/)?.[1] ?? v?.match(/[^\s<>"]+@[^\s<>"]+/)?.[0];
const domainOf = (addr?: string) => addr?.split('@')[1]?.toLowerCase().replace(/[>\s]/g, '');

// Characters scammers swap to make a domain look right at a glance.
const CONFUSABLE: [RegExp, string][] = [
  [/rn/g, 'm'], [/vv/g, 'w'], [/0/g, 'o'], [/1/g, 'l'], [/l/g, 'i'], [/5/g, 's'], [/-/g, ''],
];
const skeleton = (d: string) => CONFUSABLE.reduce((s, [re, to]) => s.replace(re, to), d.toLowerCase());

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** True when `domain` is not `real` but looks like it (one or two edits, or the same after swaps). */
export function isLookalike(domain: string, real: string) {
  if (domain === real) return false;
  return editDistance(domain, real) <= 2 || skeleton(domain) === skeleton(real);
}

export function urgencyPhrases(body: string) {
  const lower = body.toLowerCase();
  return URGENCY.filter((p) => lower.includes(p));
}

export function emailEvidence(parsed: ParsedEmail, orgDomain: string): EmailEvidence {
  const urgency = urgencyPhrases(`${parsed.headers.subject ?? ''}\n${parsed.body}`);
  if (!parsed.hasHeaders) return { provided: false, urgencyPhrases: urgency };

  const from = addressOf(parsed.headers.from);
  const replyTo = addressOf(parsed.headers['reply-to']);
  const fromDomain = domainOf(from);
  const auth = parsed.headers['authentication-results'] ?? '';
  const pick = (k: string) => auth.match(new RegExp(`${k}=([a-z]+)`, 'i'))?.[1]?.toLowerCase();
  return {
    provided: true,
    from,
    fromDomain,
    replyTo,
    replyToDomain: domainOf(replyTo),
    subject: parsed.headers.subject,
    auth: auth ? { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') } : undefined,
    urgencyPhrases: urgency,
    lookalikeOf: fromDomain && isLookalike(fromDomain, orgDomain) ? orgDomain : undefined,
  };
}
