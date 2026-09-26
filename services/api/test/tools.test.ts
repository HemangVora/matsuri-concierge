import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, validateInput, isToolError } from '../src/tools.ts';
import { validateChatBody } from '../src/validateChat.ts';

test('every tool has a strict object schema', () => {
  for (const t of TOOLS) {
    assert.equal((t.input_schema as any).type, 'object', t.name);
    assert.equal((t.input_schema as any).additionalProperties, false, t.name);
  }
});

test('propose_order rejects malformed input before touching money', () => {
  assert.equal(validateInput('propose_order', { items: [{ itemId: 1, quantity: 2 }] }).ok, true);
  assert.equal(validateInput('propose_order', { items: [{ itemId: '1', quantity: 2 }] }).ok, false);
  assert.equal(validateInput('propose_order', { items: [] }).ok, false);
  assert.equal(validateInput('split_bill', { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 100 }], memo: 'x' }).ok, true);
  assert.equal(validateInput('split_bill', { participants: ['You'], payments: [], memo: 'x', extra: 1 }).ok, false);
});

test('isToolError: an error key is always an error, regardless of tool', () => {
  assert.equal(isToolError('list_stalls', { error: 'boom' }), true);
  assert.equal(isToolError('propose_order', { error: 'boom' }), true);
});

test('isToolError: execute_order surfaces failed/refused/held as errors', () => {
  assert.equal(isToolError('execute_order', { status: 'failed', reason: 'signer offline' }), true);
  assert.equal(isToolError('execute_order', { status: 'refused' }), true);
  assert.equal(isToolError('execute_order', { status: 'held' }), true);
});

test('isToolError: execute_order success-shaped statuses are not errors', () => {
  assert.equal(isToolError('execute_order', { status: 'executed', txHashes: ['0x1'] }), false);
  assert.equal(isToolError('execute_order', { status: 'awaiting_approval' }), false);
});

test('isToolError: execute_order "executing" (lost the claim race to a concurrent call) is not an error', () => {
  assert.equal(isToolError('execute_order', { status: 'executing' }), false);
});

test('isToolError: propose_order reporting a refused proposal is a valid answer, not an error', () => {
  assert.equal(isToolError('propose_order', { status: 'refused', totalYen: 0 }), false);
});

test('isToolError: non-object output is never an error', () => {
  assert.equal(isToolError('execute_order', 'oops'), false);
  assert.equal(isToolError('execute_order', null), false);
  assert.equal(isToolError('execute_order', undefined), false);
});

test('validateChatBody accepts a well-formed body', () => {
  const v = validateChatBody({ sessionId: 's1', text: 'hi' });
  assert.deepEqual(v, { ok: true, body: { sessionId: 's1', text: 'hi' } });
});

test('validateChatBody rejects a missing, empty or oversized sessionId', () => {
  assert.equal(validateChatBody({ text: 'hi' }).ok, false);
  assert.equal(validateChatBody({ sessionId: '', text: 'hi' }).ok, false);
  assert.equal(validateChatBody({ sessionId: 1, text: 'hi' }).ok, false);
  assert.equal(validateChatBody({ sessionId: 'x'.repeat(129), text: 'hi' }).ok, false);
  assert.equal(validateChatBody({ sessionId: 'x'.repeat(128), text: 'hi' }).ok, true);
});

test('validateChatBody rejects a missing, empty or oversized text', () => {
  assert.equal(validateChatBody({ sessionId: 's1' }).ok, false);
  assert.equal(validateChatBody({ sessionId: 's1', text: '' }).ok, false);
  assert.equal(validateChatBody({ sessionId: 's1', text: 42 }).ok, false);
  assert.equal(validateChatBody({ sessionId: 's1', text: 'x'.repeat(4001) }).ok, false);
  assert.equal(validateChatBody({ sessionId: 's1', text: 'x'.repeat(4000) }).ok, true);
});

test('validateChatBody rejects a non-object body', () => {
  assert.equal(validateChatBody(null).ok, false);
  assert.equal(validateChatBody('hi').ok, false);
  assert.equal(validateChatBody(undefined).ok, false);
});
