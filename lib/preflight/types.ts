// Shared types for Preflight. Amounts are USD numbers in this demo.

export type Wallet = 'PAYPAL' | 'VENMO';

/** One payout Preflight has already seen go out (history used for baselines and backtests). */
export type PastPayout = {
  id: string;
  payeeId: string;
  date: string; // ISO date
  amount: number;
  receiver: string; // the email the money went to
  wallet: Wallet;
};

export type Payee = {
  id: string;
  name: string;
  /** The email on file: the trusted destination. */
  email: string;
  wallet: Wallet;
  /** A phone number on file, used for the owner's call-back step. Never taken from a request. */
  phoneOnFile: string;
  /** True once the payee has confirmed their current details through a trusted channel. */
  trusted: boolean;
};

/** A row the AI (or the CSV parser) pulled out of a payment request. */
export type RequestRow = {
  rowId: string;
  name: string;
  receiver: string;
  amount: number;
  currency: 'USD';
  wallet: Wallet;
  note: string;
  /** Where the email came from: written in the request, or filled in from the payee on file. */
  receiverSource: 'request' | 'on_file';
  /** The exact text the row came from, so the owner can check it. */
  sourceQuote: string;
};

export type RuleKind =
  | 'max_amount' // hold/warn any single payout above `limit`
  | 'vs_usual' // payout above `multiplier` x the payee's usual (median) amount
  | 'changed_destination' // receiver differs from the email on file, above `limit`
  | 'new_payee' // payee never paid before, above `limit`
  | 'duplicate' // same payee + same amount within `days`
  | 'batch_total'; // whole batch above `limit`

export type RuleAction = 'hold' | 'warn';

export type Rule = {
  id: string;
  /** What the owner typed. */
  text: string;
  kind: RuleKind;
  params: { limit?: number; multiplier?: number; days?: number };
  action: RuleAction;
  /** The compiled rule read back in plain words, for the owner to confirm. */
  readBack: string;
  confirmed: boolean;
  backtest?: Backtest;
};

export type Backtest = {
  pastPayouts: number;
  /** Payouts in the first two weeks of history are skipped: every payee is "new" there. */
  warmupSkipped: number;
  wouldHold: number;
  wouldWarn: number;
  examples: string[];
};

export type Severity = 'hold' | 'warn' | 'info';

export type Finding = {
  code:
    | 'RULE'
    | 'AMOUNT_OUTLIER'
    | 'UNVERIFIED_EXTRACTION'
    | 'UNKNOWN_PAYEE'
    | 'HEADER_REPLY_TO_MISMATCH'
    | 'HEADER_LOOKALIKE_DOMAIN'
    | 'HEADER_AUTH_FAIL'
    | 'URGENCY_LANGUAGE'
    | 'HEADERS_NOT_PROVIDED'
    | 'SENDER_UNVERIFIED'
    | 'DUPLICATE_IN_BATCH';
  severity: Severity;
  message: string;
  ruleId?: string;
};

export type Baseline = {
  count: number;
  median: number;
  /** Robust spread (median absolute deviation, scaled). 0 when history is too short. */
  spread: number;
  min: number;
  max: number;
  lastAmounts: number[];
  lastPaid?: string;
  /** Typical days between payouts (median gap). 0 when unknown. */
  usualGapDays: number;
};

export type Verdict = 'likely_fraud' | 'likely_genuine' | 'needs_human';

export type Investigation = {
  verdict: Verdict;
  summary: string;
  evidence: { source: string; fact: string }[];
  /** 'ai' when the model wrote it, 'rules' for the deterministic fallback. */
  by: 'ai' | 'rules';
};

/** PayPal's payout item statuses, as the Payouts API reports them. */
export type PayPalItemStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'UNCLAIMED'
  | 'RETURNED'
  | 'ONHOLD'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'DENIED'
  | 'CANCELED';

export type ItemState =
  | 'clear' // passed every check, ready to send
  | 'warn' // ready to send once the owner acknowledges the warning
  | 'held' // stopped: waiting for payee verification or owner release after cooling-off
  | 'denied' // the payee said "not me": treated as fraud, never sent
  | 'sent'; // handed to PayPal; see paypalStatus

export type ReviewItem = RequestRow & {
  payeeId?: string;
  state: ItemState;
  findings: Finding[];
  baseline?: Baseline;
  investigation?: Investigation;
  acknowledged: boolean;
  /** Set when held: earliest time the owner may release it without payee verification. */
  coolingUntil?: string;
  verifyToken?: string;
  verificationDraft?: string;
  /**
   * Step two of payee verification, only when the destination changed: a code texted to the phone on
   * file. An email "Yes" alone isn't enough, because the payee's mailbox may be the thing that's hacked.
   */
  phoneCode?: string;
  phoneCodeTries?: number;
  releasedBy?: 'payee' | 'owner';
  paypal?: {
    batchId: string;
    itemId?: string;
    status?: PayPalItemStatus;
    senderItemId: string;
    /** The wallet PayPal was actually asked to pay into (the sandbox has no Venmo, see payouts.ts). */
    walletSent: Wallet;
  };
};

export type EmailEvidence = {
  provided: boolean;
  from?: string;
  fromDomain?: string;
  replyTo?: string;
  replyToDomain?: string;
  subject?: string;
  auth?: { spf?: string; dkim?: string; dmarc?: string };
  urgencyPhrases: string[];
  lookalikeOf?: string;
};

export type Review = {
  id: string;
  createdAt: string;
  source: 'email' | 'text' | 'csv';
  extractedBy: 'ai' | 'parser';
  /** Set when the AI was asked but failed, so the UI can say why the parser was used. */
  aiNote?: string;
  email: EmailEvidence;
  /** The sender failed a check, so the whole batch is held until the owner confirms it elsewhere. */
  senderSuspicious: boolean;
  /** When the owner confirmed the batch with the real sender through a trusted channel. */
  senderConfirmedAt?: string;
  /** Set when the owner learned the sender was fake: every unsent row was stopped. */
  senderRejectedAt?: string;
  items: ReviewItem[];
};

export type AuditEvent = { at: string; reviewId?: string; rowId?: string; action: string; detail: string };
