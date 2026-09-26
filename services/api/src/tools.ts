import type Anthropic from '@anthropic-ai/sdk';
import type { Mb } from './multibaas.ts';
import { execute, proposeOrder } from './proposals.ts';
import { createBill, type KanjoDeps } from './kanjo.ts';
import { ledger, rescreen } from './ledger.ts';
import { quickScan } from '@mc/core';

type Tool = Anthropic.Beta.BetaTool;
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

export const TOOLS: Tool[] = [
  { name: 'list_stalls', description: 'List festival food stalls with item, price in yen, stock and payout address, read live from chain via MultiBaas.',
    input_schema: obj({}, []) },
  { name: 'propose_order', description: 'Propose buying vouchers. Returns the missing-layer verdict per stall (PAY/CAP/ASK/REFUSE with reasons), total yen and whether a human approval is needed. Does not move money.',
    input_schema: obj({ items: { type: 'array', minItems: 1, items: obj({ itemId: { type: 'integer' }, quantity: { type: 'integer' } }, ['itemId', 'quantity']) } }, ['items']) },
  { name: 'execute_order', description: 'Ask the independent signer to execute a proposal. Returns executed, awaiting_approval, refused, held or failed with a reason. You cannot sign.',
    input_schema: obj({ proposalId: { type: 'string' } }, ['proposalId']) },
  { name: 'split_bill', description: 'Split the evening between friends. participants must include "You" (the organizer). payments lists who paid how much in whole yen. Creates payment requests to friends and payouts from you, each screened.',
    input_schema: obj({ participants: { type: 'array', minItems: 2, items: { type: 'string' } },
      payments: { type: 'array', items: obj({ name: { type: 'string' }, amountYen: { type: 'integer' } }, ['name', 'amountYen']) },
      memo: { type: 'string' } }, ['participants', 'payments', 'memo']) },
  { name: 'ledger', description: 'On-chain purchases and settlements (MultiBaas event queries) plus the decision log with verdicts and reasons.',
    input_schema: obj({}, []) },
  { name: 'rescreen_counterparties', description: 'Re-screen every stall already paid with Intercepta and report score changes.',
    input_schema: obj({}, []) },
];

export function validateInput(name: string, input: unknown): { ok: true } | { ok: false; reason: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, reason: `Unknown tool ${name}` };
  const check = (schema: any, value: any, path: string): string | null => {
    if (schema.type === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      for (const k of Object.keys(value)) if (!(k in schema.properties)) return `${path}.${k} is not allowed`;
      for (const k of schema.required ?? []) if (!(k in value)) return `${path}.${k} is required`;
      for (const [k, s] of Object.entries(schema.properties)) if (k in value) { const e = check(s, value[k], `${path}.${k}`); if (e) return e; }
      return null;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
      for (let i = 0; i < value.length; i++) { const e = check(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
    if (schema.type === 'integer') return Number.isInteger(value) ? null : `${path} must be an integer`;
    if (schema.type === 'string') return typeof value === 'string' ? null : `${path} must be a string`;
    return null;
  };
  const err = check(tool.input_schema, input, 'input');
  return err ? { ok: false, reason: err } : { ok: true };
}

// Whether a tool's output should be reported to Claude as a tool_result error (is_error: true).
// An `error` key always means the call itself failed. Beyond that, only execute_order's terminal
// non-success statuses ('failed' | 'refused' | 'held') are errors — those are the signer/policy
// refusing to move money on a call the model explicitly asked to execute, and the model must not
// mistake that for a success. propose_order (and other tools) can legitimately report a 'refused'
// or 'held' status as a normal, informative answer — e.g. a fully-refused order is exactly what the
// model should explain to the user, not something to treat as a broken tool call.
export function isToolError(name: string, output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false;
  if ('error' in output) return true;
  if (name === 'execute_order' && 'status' in output) {
    const status = (output as { status?: unknown }).status;
    return status === 'failed' || status === 'refused' || status === 'held';
  }
  return false;
}

export async function runTool(name: string, input: unknown, d: KanjoDeps & { mbFull: Mb; interceptaKey: string }) {
  const v = validateInput(name, input);
  if (!v.ok) return { error: v.reason };
  const args = input as any;
  switch (name) {
    case 'list_stalls': return d.mbFull.readStalls();
    case 'propose_order': return proposeOrder(d, args.items);
    case 'execute_order': return execute(d, args.proposalId);
    case 'split_bill': return createBill(d, args);
    case 'ledger': return ledger(d.mbFull, d.store);
    case 'rescreen_counterparties': return rescreen(d.mbFull, d.store, (a) => quickScan(a, { apiKey: d.interceptaKey }));
    default: return { error: `Unknown tool ${name}` };
  }
}
