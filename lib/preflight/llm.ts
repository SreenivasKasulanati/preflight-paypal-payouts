// Server-side calls to the OpenAI Responses API, used by the extractor, the rule compiler and the
// investigator. The key comes from lib/ai.ts and never reaches the browser.

import { aiModels, openAiKey } from '../ai';

type JsonSchema = Record<string, unknown>;

export type ToolDef = {
  name: string;
  description: string;
  parameters: JsonSchema;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

type OutputItem =
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'message'; content: { type: string; text?: string }[] }
  | { type: string };

export const aiAvailable = () => Boolean(openAiKey());

async function call(body: Record<string, unknown>) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { id: string; output: OutputItem[] };
}

const textOf = (output: OutputItem[]) =>
  output
    .filter((o): o is Extract<OutputItem, { type: 'message' }> => o.type === 'message')
    .flatMap((m) => m.content.filter((c) => c.type === 'output_text').map((c) => c.text ?? ''))
    .join('');

/**
 * One structured answer, optionally after a few tool calls. Returns the parsed JSON and the names of
 * the tools the model actually called, so callers can reject evidence citing a tool it never used.
 */
export async function structured<T>(opts: {
  name: string;
  instructions: string;
  input: string;
  schema: JsonSchema;
  tools?: ToolDef[];
  maxSteps?: number;
}): Promise<{ value: T; toolsCalled: string[]; toolLog: { name: string; args: unknown; result: unknown }[] }> {
  const tools = opts.tools ?? [];
  const toolLog: { name: string; args: unknown; result: unknown }[] = [];
  const base = {
    model: aiModels()[0],
    instructions: opts.instructions,
    max_output_tokens: 8000,
    text: { format: { type: 'json_schema', name: opts.name, schema: opts.schema, strict: true } },
    ...(tools.length && {
      tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true })),
    }),
  };

  let res = await call({ ...base, input: opts.input });
  for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
    const calls = res.output.filter((o): o is Extract<OutputItem, { type: 'function_call' }> => o.type === 'function_call');
    if (calls.length === 0) break;
    const outputs = [];
    for (const c of calls) {
      const tool = tools.find((t) => t.name === c.name);
      let result: unknown;
      try {
        const args = JSON.parse(c.arguments || '{}');
        result = tool ? await tool.run(args) : { error: `Unknown tool ${c.name}` };
        toolLog.push({ name: c.name, args, result });
      } catch (e) {
        result = { error: String(e) };
      }
      outputs.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
    }
    res = await call({ ...base, previous_response_id: res.id, input: outputs });
  }

  const text = textOf(res.output);
  if (!text) throw new Error('The model returned no answer.');
  return { value: JSON.parse(text) as T, toolsCalled: [...new Set(toolLog.map((t) => t.name))], toolLog };
}

// Strict-mode schema helpers: every property is required; optional values are nullable.
export const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const str = (description?: string): JsonSchema => ({ type: 'string', ...(description && { description }) });
export const num = (description?: string): JsonSchema => ({ type: 'number', ...(description && { description }) });
export const nullable = (s: JsonSchema): JsonSchema => ({ ...s, type: [s.type as string, 'null'] });
export const oneOf = (values: string[], description?: string): JsonSchema => ({
  type: 'string', enum: values, ...(description && { description }),
});
export const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
