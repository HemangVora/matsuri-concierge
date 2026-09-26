import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMb } from '../src/multibaas.ts';

test('reads stalls and composes an unsigned buy', { skip: process.env.LIVE !== '1' }, async () => {
  const mb = createMb(process.env.MB_BASE_URL!, process.env.MB_API_KEY!);
  const stalls = await mb.readStalls();
  assert.equal(stalls.length, 5);
  assert.equal(stalls[0].priceYen, 600);
  const tx = await mb.composeBuy(1, 1, process.env.AGENT_ADDRESS!);
  assert.match(tx.data, /^0x/);
});
