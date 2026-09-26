const MAX_SESSION_ID_LEN = 128;
const MAX_TEXT_LEN = 4000;

export type ChatBody = { sessionId: string; text: string };
export type ValidateChatResult = { ok: true; body: ChatBody } | { ok: false; error: string };

// A pure runtime guard for POST /api/chat's body: sessionId and text arrive over the wire as
// `unknown` (a `c.req.json<T>()` generic only casts the type, it never validates it), so this is
// the one place that stands between an arbitrary request body and the agent loop / session map.
export function validateChatBody(body: unknown): ValidateChatResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Body must be an object' };
  const { sessionId, text } = body as { sessionId?: unknown; text?: unknown };
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LEN) {
    return { ok: false, error: `sessionId must be a non-empty string of at most ${MAX_SESSION_ID_LEN} characters` };
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) {
    return { ok: false, error: `text must be a non-empty string of at most ${MAX_TEXT_LEN} characters` };
  }
  return { ok: true, body: { sessionId, text } };
}
