// AG Studio data sources for Preflight: payouts under review, the findings behind each one, the
// payout history that baselines are built from, and the payee list.

import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat } from 'ag-studio';
import type { Snapshot } from '@/lib/preflight/snapshot';

type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean];
const fields = (specs: FieldSpec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({ id, name, format, ...(hide && { hide }) }));

export function buildPreflightData(snap: Snapshot): AgDataSourcesDefinition {
  const dates = snap.tables.history.map((h) => h.date.slice(0, 10)).sort();
  const today = new Date().toISOString().slice(0, 10);
  return {
    description:
      `Preflight payout safety data for ${snap.org.name}, a design agency that pays freelancers weekly through PayPal Payouts (PayPal and Venmo wallets). ` +
      'payouts are the rows Preflight checked; state is Clear, Warning, Held, Stopped (fraud stopped, never sent) or Sent; paypalStatus is the PayPal Payouts item status. ' +
      'findings are the reasons behind each state. history is every payout already sent, used for baselines. All amounts are USD.',
    sources: [
      {
        id: 'payouts',
        name: 'Payouts Under Review',
        description: 'One row per payout Preflight checked. reason is the main hold or warning message.',
        data: snap.tables.payouts,
        fields: fields([
          ['id', 'Payout ID', 'textFormat', true],
          ['reviewId', 'Review ID', 'textFormat', true],
          ['rowId', 'Row ID', 'textFormat', true],
          ['createdAt', 'Checked At', 'dateTimeFormat'],
          ['payee', 'Payee', 'textFormat'],
          ['receiver', 'Send To', 'textFormat'],
          ['wallet', 'Wallet', 'textFormat'],
          ['amount', 'Amount', 'currencyFormat'],
          ['state', 'Preflight State', 'textFormat'],
          ['paypalStatus', 'PayPal Status', 'textFormat'],
          ['reason', 'Main Reason', 'textFormat'],
          ['holdCount', 'Hold Signals', 'integerFormat'],
          ['warnCount', 'Warning Signals', 'integerFormat'],
          ['verdict', 'Investigator Verdict', 'textFormat'],
          ['releasedBy', 'Released By', 'textFormat'],
        ]),
      },
      {
        id: 'findings',
        name: 'Findings',
        description: 'Every signal behind a payout state. severity is Hold, Warn or Note; rule is the owner rule that fired, or Built-in check.',
        data: snap.tables.findings,
        fields: fields([
          ['id', 'Finding ID', 'textFormat', true],
          ['payoutId', 'Payout ID', 'textFormat', true],
          ['payee', 'Finding Payee', 'textFormat'],
          ['code', 'Signal', 'textFormat'],
          ['severity', 'Severity', 'textFormat'],
          ['rule', 'Rule', 'textFormat'],
          ['message', 'Detail', 'textFormat'],
        ]),
      },
      {
        id: 'history',
        name: 'Payout History',
        description: 'Payouts already sent to each payee: the data behind each payee\'s usual amount.',
        data: snap.tables.history,
        fields: fields([
          ['id', 'History ID', 'textFormat', true],
          ['payee', 'History Payee', 'textFormat'],
          ['date', 'Paid On', 'dateTimeFormat'],
          ['amount', 'Paid Amount', 'currencyFormat'],
          ['receiver', 'Paid To', 'textFormat'],
          ['wallet', 'Paid Wallet', 'textFormat'],
        ]),
      },
      {
        id: 'payees',
        name: 'Payees',
        description: 'The payee list: email on file, wallet, whether verified (trusted) and their usual (median) amount.',
        data: snap.tables.payees,
        fields: fields([
          ['id', 'Payee ID', 'textFormat', true],
          ['payee', 'Payee Name', 'textFormat'],
          ['email', 'Email On File', 'textFormat'],
          ['wallet', 'Payee Wallet', 'textFormat'],
          ['trusted', 'Trusted', 'booleanFormat'],
          ['usualAmount', 'Usual Amount', 'currencyFormat'],
          ['payouts', 'Past Payouts', 'integerFormat'],
        ]),
      },
    ],
    relationships: [
      { id: 'finding-payout', source: { tableId: 'findings', fieldId: 'payoutId' }, target: { tableId: 'payouts', fieldId: 'id' }, type: 'many-to-one' },
      { id: 'history-calendar', source: { tableId: 'history', fieldId: 'date' }, target: { calendarId: 'calendar' }, truncate: 'day' },
    ],
    calendars: [
      {
        id: 'calendar',
        label: 'Calendar',
        range: { from: { type: 'date', value: dates[0] ?? today }, to: { type: 'date', value: today } },
        fragments: ['year', 'quarter', 'month', 'week', 'day'],
      },
    ],
  };
}
