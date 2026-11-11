// Preflight's AI team inside AG Studio's Agent Framework.
//
//   Preflight Analyst (primary, ours) - answers questions about the batch, the cases and the rules
//     with Preflight's own tools, and proposes rules (the owner confirms them; the AI can't).
//     For anything on the dashboard itself it delegates to:
//   AG Studio's built-in agents (lead, data, page, planning, widget) - build and edit widgets.
//
// Every agent talks to the model through the boilerplate's OpenAI adapter, which posts to this
// app's /api/ai proxy, so the key stays on the server.

import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgAiTool } from 'ag-studio';
import { openaiAdapter } from '../dashboard/studio/openai-adapter';
import { actions, currentReview, preflightStore } from './client-store';

type Json = Record<string, unknown>;

/** A client-side tool: Studio's loop calls `execute` in the browser with the model's arguments. */
function tool(name: string, description: string, properties: Json, run: (args: Json) => Promise<unknown> | unknown): AgAiTool {
  const parameters = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
  return {
    name,
    description,
    kind: 'client',
    schema: () => ({ name, description, parameters }),
    async execute(call, ctx) {
      try {
        return ctx.success(JSON.stringify(await run(call.args)));
      } catch (e) {
        return ctx.error(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function batchOverview() {
  const review = currentReview(preflightStore.get());
  if (!review) return { batch: null, note: 'No payment request has been checked yet.' };
  return {
    source: review.source,
    sender: review.email.provided ? { from: review.email.from, replyTo: review.email.replyTo ?? null, lookalikeOf: review.email.lookalikeOf ?? null } : 'headers not provided',
    rows: review.items.map((i) => ({
      payee: i.name,
      amount: usd(i.amount),
      send_to: i.receiver,
      wallet: i.wallet,
      preflight_state: i.state,
      paypal_status: i.paypal?.status ?? null,
      signals: i.findings.map((f) => `${f.severity}: ${f.message}`),
      investigator_verdict: i.investigation?.verdict ?? null,
    })),
  };
}

function caseFor(payee: string) {
  const review = currentReview(preflightStore.get());
  const item = review?.items.find((i) => i.name.toLowerCase().includes(payee.toLowerCase()));
  if (!item) return { found: false };
  preflightStore.select(item.rowId); // show it in the Case file widget too
  return {
    found: true,
    payee: item.name,
    amount: usd(item.amount),
    send_to: item.receiver,
    state: item.state,
    signals: item.findings.map((f) => ({ severity: f.severity, detail: f.message })),
    baseline: item.baseline ? { usual: usd(item.baseline.median), range: `${usd(item.baseline.min)}-${usd(item.baseline.max)}`, payouts: item.baseline.count } : null,
    investigation: item.investigation ?? null,
    next_steps:
      item.state === 'held'
        ? 'Held. A confirmation went to the email on file; the owner can also release after the cooling-off period and a call to the number on file.'
        : item.state === 'warn'
          ? 'Sends with the batch once the owner acknowledges the warning.'
          : item.state,
  };
}

const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: 'Why is Maria held?', prompt: "Why is Maria's payout held, and what should I do?" },
  { label: 'Summarise this batch', prompt: 'Summarise this batch: what is safe to send, what is held, and why.' },
  { label: 'Chart held dollars', prompt: 'Add a chart to the Risk Control Room showing held and stopped dollars by main reason.' },
  { label: 'Suggest a rule', prompt: 'Suggest one more safety rule for us and add it for me to confirm.' },
];

export function buildPreflightAi(models: string[]): AgAiHarnessSetup {
  const adapter = openaiAdapter({ endpoint: '/api/ai', model: models[0] });

  const preflightTools = [
    tool('get_batch_overview', 'The payout batch Preflight checked most recently: every row with its state, PayPal status, signals and investigator verdict.', {}, batchOverview),
    tool(
      'get_payout_case',
      "One payout's full case: signals, the payee's usual amounts, the investigator's evidence and the next steps. Also selects it in the Case file widget.",
      { payee: { type: 'string', description: 'Payee name or part of it' } },
      (a) => caseFor(String(a.payee)),
    ),
    tool('list_rules', "The owner's safety rules: their wording, what the engine checks, whether confirmed, and their backtest on past payouts.", {}, () =>
      (preflightStore.get().snapshot?.rules ?? []).map((r) => ({ text: r.text, checks: r.readBack, confirmed: r.confirmed, backtest: r.backtest })),
    ),
    tool(
      'propose_rule',
      'Add a new safety rule in plain English. It is compiled, backtested and added UNCONFIRMED; only the owner can switch it on in the Rules widget.',
      { text: { type: 'string', description: 'The rule in plain English, with any numbers' } },
      async (a) => {
        const ok = await actions.addRule(String(a.text));
        const s = preflightStore.get();
        if (!ok) return { added: false, problem: s.error };
        const rule = s.snapshot?.rules.at(-1);
        return { added: true, checks: rule?.readBack, backtest: rule?.backtest, note: 'Unconfirmed: ask the owner to confirm it in the Rules widget.' };
      },
    ),
    tool('run_safety_test', 'Replay 500 synthetic payouts (genuine and fraudulent) through the current rules and report friction and catch rate. Synthetic data.', {}, async () => actions.evaluate()),
  ];

  return ({ api }) =>
    createAiHarness(api, ({ builtIn, tools }) => ({
      agents: [
        directLlmRunner({
          id: 'preflight',
          name: 'Preflight Analyst',
          description: 'Explains payout holds, cases and rules for the business owner.',
          instructions: () =>
            'You are Preflight Analyst, helping a small-business owner check PayPal and Venmo payouts before they are sent. ' +
            'Use your tools for facts about the batch, cases and rules; never state an amount, email or status a tool did not return. ' +
            'You cannot send, release or stop money and must not say you did: the owner does that in the Payout review widget. ' +
            'Rules you propose stay unconfirmed until the owner confirms them. Keep answers short and plain. ' +
            'For anything about building or changing dashboard widgets, charts or pages, delegate to the lead agent.',
          tools: () => [...preflightTools, tools.delegateTo(['lead']), tools.renameThread()],
          maxTurns: 12,
          adapter,
        }),
        directLlmRunner({ ...builtIn.lead, adapter }),
        directLlmRunner({ ...builtIn.data, adapter }),
        directLlmRunner({ ...builtIn.page, adapter }),
        directLlmRunner({ ...builtIn.planning, adapter }),
        directLlmRunner({ ...builtIn.widget, adapter }),
      ],
      primary: 'preflight',
      promptStarters: PROMPT_STARTERS,
      models: models.length > 1 ? models.map((id) => ({ id, label: id })) : undefined,
    }));
}
