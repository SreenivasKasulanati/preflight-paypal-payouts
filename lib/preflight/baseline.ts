// Per-payee behaviour baselines: plain statistics, no AI. Medians and median absolute deviation
// are used instead of mean/stdev so one unusual week doesn't distort "normal".

import type { Baseline, PastPayout } from './types';

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function baselineFor(history: PastPayout[], payeeId: string): Baseline {
  const rows = history.filter((h) => h.payeeId === payeeId).sort((a, b) => a.date.localeCompare(b.date));
  const amounts = rows.map((r) => r.amount);
  const med = median(amounts);
  // 1.4826 scales MAD to be comparable with a standard deviation for normal data.
  const spread = amounts.length >= 4 ? 1.4826 * median(amounts.map((a) => Math.abs(a - med))) : 0;
  const gaps = rows.slice(1).map((r, i) => (Date.parse(r.date) - Date.parse(rows[i].date)) / 86_400_000);
  return {
    usualGapDays: gaps.length >= 3 ? median(gaps) : 0,
    count: rows.length,
    median: med,
    spread,
    min: amounts.length ? Math.min(...amounts) : 0,
    max: amounts.length ? Math.max(...amounts) : 0,
    lastAmounts: amounts.slice(-10),
    lastPaid: rows.at(-1)?.date,
  };
}

/**
 * How unusual an amount is for this payee, as a robust z-score. Spread has a floor of 5% of the
 * median so a payee paid the exact same amount every week isn't flagged for a $1 change.
 */
export function outlierScore(b: Baseline, amount: number): number {
  if (b.count < 4 || b.median <= 0) return 0;
  const spread = Math.max(b.spread, b.median * 0.05);
  return (amount - b.median) / spread;
}
