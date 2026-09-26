import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';

const base = { kind: 'order' as const, status: 'proposed' as const, hash: '0x1', totalYen: 1200,
  requiresApproval: true, decision: {}, txs: [], meta: {} };

test('proposal round trip, approval, status', () => {
  const s = openStore(':memory:');
  s.insertProposal({ id: 'p1', ...base });
  s.setApproval('p1', { signature: '0xsig', totalYen: 1200, expiresAt: 9 });
  s.setStatus('p1', 'executed', ['0xtx']);
  const p = s.getProposal('p1')!;
  assert.deepEqual([p.status, p.txHashes, p.approval?.signature], ['executed', ['0xtx'], '0xsig']);
});

test('spentTodayYen counts only executed orders and transfers', () => {
  const s = openStore(':memory:');
  s.insertProposal({ id: 'a', ...base, totalYen: 600 }); s.setStatus('a', 'executed');
  s.insertProposal({ id: 'b', ...base, totalYen: 900 });
  s.insertProposal({ id: 'c', ...base, kind: 'settle', totalYen: 1100 }); s.setStatus('c', 'executed');
  assert.equal(s.spentTodayYen(), 600);
});

test('screening cache respects max age and share dedupe works once', () => {
  const s = openStore(':memory:');
  s.cacheScreening({ address: '0xAbC', ok: true, result: { toxicScore: 1, traits: [] }, fetchedAt: new Date().toISOString() });
  assert.equal(s.getScreening('0xabc', 60_000)?.ok, true);
  assert.equal(s.getScreening('0xabc', -1), null);
  assert.equal(s.markShare('bill', '0xF'), true);
  assert.equal(s.markShare('bill', '0xf'), false);
});
