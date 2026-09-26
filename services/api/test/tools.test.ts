import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, validateInput } from '../src/tools.ts';

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
