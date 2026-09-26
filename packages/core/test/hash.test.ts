import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashProposal } from '../src/hash.ts';

const tx = { to: '0x000000000000000000000000000000000000dEaD', data: '0x1234', value: '0' };

test('hash is stable and address-case insensitive', () => {
  const a = hashProposal(11155111, [tx]);
  const b = hashProposal(11155111, [{ ...tx, to: tx.to.toLowerCase() }]);
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test('hash changes with chainId, data, order', () => {
  const tx2 = { ...tx, data: '0x5678' };
  const base = hashProposal(11155111, [tx, tx2]);
  assert.notEqual(base, hashProposal(1, [tx, tx2]));
  assert.notEqual(base, hashProposal(11155111, [tx2, tx]));
  assert.notEqual(base, hashProposal(11155111, [tx, { ...tx2, data: '0x5679' }]));
});
