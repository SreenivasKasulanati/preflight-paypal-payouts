# Preflight for PayPal Payouts

**Every PayPal payout checked, explained, and stoppable before it leaves.**

Fake "please pay this new account" requests cost U.S. businesses billions a year (the FBI's 2025
IC3 report puts business email compromise at $3.05 billion). They work because nothing about the
payment looks wrong: the business approves it, so it goes through.

Preflight sits between *approve* and *send* for businesses that pay many people at once through
PayPal Payouts: agencies, marketplaces, creator platforms. Drop in a payment request (an email, a
list or a CSV). AI turns it into a payout batch. Rules the owner wrote in plain English, tested
against their own past payouts, check every row. Genuine payouts go out instantly through PayPal
(PayPal and Venmo wallets). Risky ones wait, with an AI-built case explaining why, until the real
payee confirms through a channel the request didn't come from.

> Built for the PayPal AI Hackathon 2026 on PayPal's official AG Studio boilerplate.

---

## The demo story

Brightline Studio pays six freelancers every Friday. This email arrives:

> **From:** Mark Ellis &lt;mark@brightline-stud**l**o.com&gt; · **Reply-To:** mark.ellis.ops@gmail.com
> "Please run this week's payouts… Also, Maria switched PayPal accounts. Send her $4,800 to
> maria.lopez.pay@gmail.com… Need it before noon!"

Because the **sender itself** fails the checks (lookalike domain, reply-to redirect, DMARC fail),
Preflight holds **the whole batch**: nothing in a fake email gets paid, not even the normal-looking
rows. Dana (the owner) confirms the request with Mark through a channel she already trusts (his
known phone number), ticks "I confirmed it with the real sender" and clicks **Confirm batch**.
Each row is then judged on its own:

| Payee | Result after Confirm batch | Why |
|---|---|---|
| Priya, James, Aisha (Venmo), Diego | **Clear**, sent instantly | Normal for each of them |
| Tom | **Warning** (one click) | Same $600 paid three days ago; usually paid weekly |
| Maria | **Held** | New email + 3.2x her usual, on a request whose sender failed every check |

The five payouts go out as one PayPal Payouts batch. Maria's $4,800 never reaches PayPal: a
one-click check goes to her **email on file**. "No, not me" stops it as fraud. Because her payout
details are new, a "Yes" alone sends nothing: a code is texted to her **phone on file**, and only that
code releases the payout and makes her new email trusted, so next week she goes straight through.

A genuine email from mark@brightline-studio.com passes the sender checks, so its normal rows are
sent at once with no batch confirmation. (Code: `senderSuspicious` in `lib/preflight/rules.ts`,
`confirmSender` in `lib/preflight/service.ts`, route `POST /api/preflight/reviews/{id}/confirm-sender`.)

### Fraud scenarios (one click each in the app)

Pick a scenario in **1 · Payment request**; the card says what happened, what to expect and what to
click next. Click **Reset demo** between scenarios. Every result below is asserted in `npm run test:engine`.

| Scenario | How the fake details got in | What Preflight does |
|---|---|---|
| **Fake sender** | A scammer emails as Mark from a lookalike domain | Whole batch held until the owner confirms with the real Mark |
| **Mark's mailbox hacked** | The scammer sends from Mark's real account, so sender checks pass, and changes Diego's PayPal | Diego held (new email); his check goes to his email on file, the real Diego says no |
| **Maria's mailbox hacked** | The scammer, as Maria, tells Mark "I changed my PayPal"; Mark forwards it in good faith | Maria held; the scammer can answer "Yes" from her mailbox, but nothing is sent without the code texted to her phone on file |
| **Ghost contractor** | A contractor nobody hired is slipped into the list | Held: new payee over $300, no email or phone on file to check with |
| **Inflated invoice** | James, usually $900, is listed at $3,000 | Held: over 2x his usual |
| **Paid twice** | Maria appears twice in one request | Second row warned: already in this batch |
| **Genuine / CSV** | Mark's real weekly email, or an export | Clear and sent straight away (CSV: Tom warned, paid 3 days ago) |

---

## How it works

```
 payment request (.eml / text / CSV)
        │
        ▼
 ┌──────────────┐   AI extracts rows ──► every amount/name/email must appear verbatim in the source
 │  Extract      │   (CSV and simple lists are parsed in code)
 └──────┬───────┘
        ▼
 ┌──────────────┐   owner's plain-English rules, compiled by AI into 6 fixed check types,
 │  Rules engine │   read back + backtested on past payouts before the owner confirms them
 │ (no AI)       │ + per-payee baselines (median / MAD)  + sender checks (headers parsed in code)
 └──────┬───────┘
        ▼             clear ──► PayPal Payouts batch (PAYPAL or VENMO wallet) ──► live statuses
   clear / warn / held
        │             held  ──► AI investigator builds a case (tool calls, cited evidence)
        ▼                       verification to the email on file (+ a code to the phone on file
                                when the details are new), cooling-off before owner release
   AG Studio: Review page (custom widgets) + Risk Control Room (Studio widgets + AI agents)
```

**The safety boundary:** AI reads, writes rules and explains. It never decides. Only the
deterministic rules engine sets a payout's state, and only the owner's click (or the payee's own
confirmation) sends money.

### Not hurting genuine users
- Only risky rows wait; clean rows are sent immediately (unless the request's sender is suspicious, which holds the batch until one owner confirmation). Warnings never block, they only need a click.
- Baselines learn from every sent payout, so a real raise stops being unusual.
- A payee verifies once; their new details are trusted from then on.
- The scoreboard shows the share of payouts that went straight through, so a business can see if its rules are too strict.

---

## PayPal integration

| What | API |
|---|---|
| Send a batch (PayPal and Venmo wallets) | `POST /v1/payments/payouts` (`recipient_wallet: PAYPAL / VENMO`; Venmo isn't available in the sandbox, see below) |
| Live item statuses (SUCCESS, UNCLAIMED, RETURNED…) | `GET /v1/payments/payouts/{batch_id}` |
| Pull back a payout nobody has claimed | `POST /v1/payments/payouts-item/{id}/cancel` (PayPal allows this only while UNCLAIMED) |
| OAuth, retries | `lib/paypal.ts` (from the boilerplate) |

`sender_batch_id` is unique per batch, so a double-click can't double-pay. Code: `lib/preflight/payouts.ts`.

In our sandbox tests, PayPal answered `payouts-item/{id}/cancel` with `INTERNAL_SERVICE_ERROR` (500).
Preflight retries, re-reads the item's real status, and only reports RETURNED when PayPal does; otherwise
it says the payout is still unclaimed. PayPal also returns unclaimed payouts automatically after 30 days.

## AI: tools used and how

All model calls go through the OpenAI Responses API from the server (`lib/preflight/llm.ts`) or
through the boilerplate's `/api/ai` proxy for AG Studio's agents, so the key never reaches the browser.

| Where | What the AI does | Guardrail |
|---|---|---|
| Extractor (`extract.ts`) | Reads a free-text request into payout rows (JSON schema, strict) | Each row's amount and name/email must appear verbatim in the source, or the row is held |
| Rule compiler (`compile.ts`) | Maps "hold anyone getting more than 2x their usual" to one of six check types | Unsupported rules are refused, not approximated; read back + backtest + owner confirms |
| Investigator (`investigate.ts`) | Calls 4 tools (payee profile, payout history, sender check, PayPal statuses) and writes a verdict | Evidence citing a tool it never called is dropped; verdict is advice only |
| Preflight Analyst (`app/preflight/preflight-ai.ts`) | AG Studio agent answering questions about the batch, cases and rules; proposes rules | Can't send or release money; proposed rules stay unconfirmed |
| AG Studio's built-in agents | Build and edit Risk Control Room widgets when the Analyst delegates | Studio's own tools |

With no AI key, Preflight still runs (code-only parser, pattern-based rules, rules-based case
summaries) and labels itself **AI off**. If the AI fails mid-run (for example an OpenAI rate limit),
each step falls back the same way and the batch says so. To keep requests low, only held rows get
the AI investigator, which gathers its evidence in one parallel round of tool calls.

The chat is a pop-up: the **Ask Preflight AI** button (bottom right) opens it, minimise keeps the
conversation, close ends it. It runs on the same AG Studio agent harness as Studio's own AI panel
(still available in **Edit layout**), so the Preflight Analyst can hand chart requests to Studio's agents.

## AG Studio

- **Review page:** six custom widgets registered with `createWidgets`: scoreboard, payout review
  grid (AG Grid with inline editing that re-checks the row, history mini-charts, signal chips,
  live PayPal status cells that flash on change, pinned totals), case file, sender check, rules and
  backtests, and the safety test. Themed from the boilerplate's PayPal tokens.
- **Risk Control Room:** Studio's own charts and grids over Preflight's data sources (payouts,
  findings, history, payees, with a relationship and a calendar), editable in **Edit layout**.
- **Agent Framework:** a custom primary agent (`directLlmRunner`) with Preflight tools, delegating
  to Studio's built-in lead/data/page/planning/widget agents.

---

## Run it locally

Requires Node.js 20.9+.

```bash
npm install
cp env.example .env.local      # Windows PowerShell: Copy-Item env.example .env.local
npm run dev                    # http://localhost:3000
npm run test:engine            # engine checks, no keys needed
```

Everything in `.env.local` is optional: with no keys, Preflight runs with a **labelled payout
simulator** and **AI off**, so you can try the whole flow first.

### PayPal sandbox setup (5 minutes)
1. [developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox) → Apps & Credentials → Sandbox → create an app. Put its Client ID and Secret in `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET`.
2. Pick an email domain only you use and set it as `PREFLIGHT_PAYEE_DOMAIN` (sandbox addresses look
   shared across developers, so `@example.com` ones may already belong to someone else's sandbox).
   Then Sandbox → Accounts → create **Personal** accounts with these emails, so the demo's payouts complete as SUCCESS:
   `priya.nayar@<domain>`, `james.chen@<domain>`, `tom.becker@<domain>`, `aisha.khan@<domain>`, `diego.ruiz@<domain>`, `maria.lopez@<domain>`.
   Payouts to any other address come back **UNCLAIMED**, which is how the "Pull back" button can be tried.
3. Make sure the sandbox **Business** account has a balance.

Venmo: the PayPal sandbox rejects `recipient_wallet: VENMO` ("Recipient wallet not supported in
sandbox"). So in the sandbox, Venmo rows are sent to the PayPal wallet and labelled
"Venmo → PayPal (sandbox)" in the grid, the case file and the audit log. Live sends would use
`recipient_wallet: VENMO` with the payee's email, phone or Venmo handle (`lib/preflight/payouts.ts`).

### Deploy on Render
`render.yaml` defines one free web service. Create a Blueprint from the repo and enter the secrets.
On the free plan the service sleeps after 15 minutes idle (first load takes about a minute) and its
memory resets on restart; Preflight reseeds its demo data on start, and **Reset demo** does the same.
AI routes are rate-limited (`AI_RATE_PER_MINUTE`, `AI_DAILY_LIMIT`) because the demo is public.

---

## Synthetic safety test

`Risk Control Room → Run the safety test` (or `runEvaluation()` in `lib/preflight/evaluate.ts`)
replays 500 generated payouts with known labels through the seeded rules. Seed 20261112:

- **Genuine (457):** 353 straight through (77%), 44 warned (one click, never a wait), 60 held. Every hold was an email change, an unusually large one-off job or a large first payout to a new contractor, each resolved by one payee confirmation.
- **Fraud (43):** 41 held, 1 warned, **1 missed**: an inflated amount to a real payee's real email (insider-style) that stayed within their normal range.

This is synthetic data and measures the payout rules only (no email headers). It is not a claim
about real-world fraud rates.

## Limitations (honest list)
- Verification emails are shown in a simulated inbox; email delivery isn't wired up.
- Verification texts are simulated like the emails (the code is shown on a phone card); SMS delivery isn't wired up.
- A payee whose mailbox **and** phone are both taken over could still pass verification. That takes two separate takeovers, and every release is in the audit log.
- State is in memory (demo). A real deployment needs a database and webhooks (`PAYMENT.PAYOUTS-ITEM.*`) instead of polling.
- Live Payouts requires PayPal to enable Payouts on the business account.

## Project map
```
lib/preflight/      engine: types, seed, baseline, email, rules, extract, compile, investigate,
                    payouts (PayPal), service, store, snapshot, evaluate, llm
app/api/preflight/  the API
app/preflight/      the UI: host page, AG Studio widgets, data sources, report, theme, AI agents
scripts/            engine checks
```

MIT licensed. See `LICENSE`.
