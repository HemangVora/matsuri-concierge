import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickScan } from '../src/intercepta.ts';

const addr = '0x0d775e010f0b6c32c9468d43ba599ef47d596e47';
const fakeFetch = (status: number, body: unknown) =>
  (async (url: string, init?: RequestInit) => {
    assert.match(String(url), /\/api\/public\/v2\/extension\/account\/0x0d77.*\/quick-scan$/);
    assert.equal((init?.headers as Record<string, string>)['X-API-KEY'], 'k');
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

test('parses a successful quick scan', async () => {
  const s = await quickScan(addr, { apiKey: 'k', fetchImpl: fakeFetch(200, { toxicScore: 88, traits: [{ risk: 90, name: 'known_scammer', txsCount: 3, description: 'Known scammer' }] }) });
  assert.equal(s.ok, true);
  assert.equal(s.result!.toxicScore, 88);
});

test('HTTP error, malformed body and network failure all return ok:false', async () => {
  assert.equal((await quickScan(addr, { apiKey: 'k', fetchImpl: fakeFetch(503, {}) })).ok, false);
  assert.equal((await quickScan(addr, { apiKey: 'k', fetchImpl: fakeFetch(200, { nope: 1 }) })).ok, false);
  const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  const s = await quickScan(addr, { apiKey: 'k', fetchImpl: boom });
  assert.deepEqual([s.ok, s.error], [false, 'ECONNRESET']);
});

test('missing api key is ok:false without calling the network', async () => {
  const s = await quickScan(addr, { apiKey: '', fetchImpl: (async () => { throw new Error('should not call'); }) as unknown as typeof fetch });
  assert.deepEqual([s.ok, s.error], [false, 'INTERCEPTA_API_KEY not set']);
});
