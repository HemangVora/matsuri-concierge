import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../src/risk.ts';

const cfg = { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['sanction_address', 'known_scammer'] };
const ok = (toxicScore: number, traits: any[] = []) => ({ address: '0xa', ok: true, result: { toxicScore, traits }, fetchedAt: 'now' });

test('clean address pays', () => assert.equal(assessRisk(ok(3), cfg).action, 'PAY'));
test('score bands map to CAP / ASK / REFUSE', () => {
  assert.equal(assessRisk(ok(15), cfg).action, 'CAP');
  assert.equal(assessRisk(ok(40), cfg).action, 'ASK');
  assert.equal(assessRisk(ok(70), cfg).action, 'REFUSE');
});
test('a hard trait refuses even at a low score and carries the description', () => {
  const r = assessRisk(ok(5, [{ risk: 90, name: 'sanction_address', txsCount: 1, description: 'Sanctioned by OFAC' }]), cfg);
  assert.deepEqual([r.action, r.reasons], ['REFUSE', ['Sanctioned by OFAC']]);
});
test('screening failure fails closed to ASK', () => {
  const r = assessRisk({ address: '0xa', ok: false, error: 'HTTP 503', fetchedAt: 'now' }, cfg);
  assert.equal(r.action, 'ASK');
  assert.match(r.reasons[0], /HTTP 503/);
});
