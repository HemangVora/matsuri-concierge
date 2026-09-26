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

test('spentTodayYen anchors to the JST calendar day, not the process TZ', () => {
  const s = openStore(':memory:');
  // 05:00 JST on 26 Sep — must count as "today" when `now` is 09:30 JST on 26 Sep, even on a
  // TZ=UTC host where naive local-midnight math would wrongly treat it as still "yesterday".
  s.insertProposal({ id: 'jst-early', ...base, totalYen: 500, createdAt: '2026-09-25T20:00:00.000Z' });
  s.setStatus('jst-early', 'executed');
  // 23:59:59 JST on 25 Sep — must NOT count as "today" for that same `now`.
  s.insertProposal({ id: 'jst-late-prev-day', ...base, totalYen: 700, createdAt: '2026-09-25T14:59:59.000Z' });
  s.setStatus('jst-late-prev-day', 'executed');
  const now = new Date('2026-09-26T00:30:00.000Z'); // 09:30 JST on 26 Sep
  assert.equal(s.spentTodayYen(now), 500);
});

test('screening cache respects max age and share dedupe works once', () => {
  const s = openStore(':memory:');
  s.cacheScreening({ address: '0xAbC', ok: true, result: { toxicScore: 1, traits: [] }, fetchedAt: new Date().toISOString() });
  assert.equal(s.getScreening('0xabc', 60_000)?.ok, true);
  assert.equal(s.getScreening('0xabc', -1), null);
  assert.equal(s.markShare('bill', '0xF'), true);
  assert.equal(s.markShare('bill', '0xf'), false);
});
