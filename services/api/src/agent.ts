import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, runTool } from './tools.ts';
import { bus } from './events.ts';

const client = new Anthropic();
const sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

const SYSTEM = `You are Matsuri Concierge, a festival agent for a group of friends at a Japanese matsuri.
You plan food and pay stalls in MJPY (1 MJPY = 1 yen), and you settle the bill between friends.
Rules you must follow:
- You cannot sign or move money yourself. You propose; a policy engine, Intercepta screening, the human, and an independent signer decide.
- Never compute prices, totals or splits in your head. Use list_stalls, propose_order and split_bill; quote their numbers exactly.
- After propose_order, explain every stall's verdict in one short line (PAY / CAP / ASK / REFUSE and the reason). If a stall is REFUSED, you may propose an alternative stall once.
- If approval is required, tell the user to approve on their phone (the approval card) and wait; call execute_order only after they say they approved or when no approval is needed.
- Keep replies short and friendly. Reply in the user's language (Japanese or English).`;

export async function chat(sessionId: string, text: string, deps: Parameters<typeof runTool>[2], model: string, effort: 'low' | 'medium' | 'high') {
  const messages = sessions.get(sessionId) ?? [];
  messages.push({ role: 'user', content: text });
  const toolCalls: { name: string; input: unknown; output: unknown }[] = [];

  for (let turn = 0; turn < 12; turn++) {
    const response = await client.beta.messages.create({
      model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
      thinking: { type: 'adaptive' }, output_config: { effort },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      // The installed SDK's `fallbacks` type only allows an explicit Array<BetaFallbackParam>; the
      // server-side-fallback-2026-07-01 beta also accepts the string sentinel 'default' (fall back
      // to the platform's default fallback chain), which the shipped types don't yet model. The
      // field is passed through verbatim on the wire either way.
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'refusal') break;
    if (response.stop_reason === 'pause_turn') continue;
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      bus.emit('tool_call', { name: u.name, input: u.input });
      let output: unknown;
      try { output = await runTool(u.name, u.input, deps); }
      catch (e) { output = { error: (e as Error).message }; }
      toolCalls.push({ name: u.name, input: u.input, output });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(output),
        is_error: typeof output === 'object' && output !== null && 'error' in output });
    }
    messages.push({ role: 'user', content: results });
  }
  sessions.set(sessionId, messages);
  const last = messages[messages.length - 1];
  const reply = last.role === 'assistant' && Array.isArray(last.content)
    ? last.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    : '';
  bus.emit('agent_reply', { sessionId, reply });
  return { reply, toolCalls };
}
