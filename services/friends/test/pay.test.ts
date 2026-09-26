import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { yenToWei, type Deployments } from '@mc/core';
import { payFriendPayUrl } from '../src/pay.ts';

const deployments: Deployments = {
  chainId: 11155111,
  stablecoin: '0x1c7A95BE9B92b08E79bc906FF05E314f219a0bf3',
  voucher: '0xa94124E8149b7e09ec4AE0345C5ccD1e7eAd4aE2',
  settlement: '0x1804fd65F65AC75954724f6aB1385B97346B5a0E',
};
const organizer = '0x00000000000000000000000000000000000000ee';

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function validBody() {
  return {
    x402Version: 'mc-kanjo-1',
    error: 'Payment required',
    accepts: [{
      scheme: 'eip712-share', chainId: deployments.chainId, settlement: deployments.settlement,
      token: deployments.stablecoin, to: organizer, amount: yenToWei(1000).toString(), amountYen: 1000,
      billId: '0x' + '11'.repeat(32), deadline: Math.floor(Date.now() / 1000) + 3600, memo: 'dinner',
    }],
  };
}

// The critical fix from review round 1: a 302 from an allowed origin, handed back transparently
// because both fetches use redirect: 'manual', must be refused before the friend ever signs
// anything or makes a second (X-PAYMENT) request.
test('payFriendPayUrl: refuses a redirect from the allowed origin, without ever signing or retrying', async () => {
  let requests = 0;
  const { server, origin } = await listen((_req, res) => {
    requests++;
    res.writeHead(302, { Location: 'http://evil.example/402' });
    res.end();
  });
  try {
    const wallet = Wallet.createRandom();
    const result = await payFriendPayUrl({
      wallet, payUrl: `${origin}/kanjo/bills/1/pay?from=Aoi`, deployments, organizer, allowedOrigins: [origin],
    });
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /Redirect/);
    assert.equal(requests, 1); // never followed through to a second (X-PAYMENT) request
  } finally {
    server.close();
  }
});

test('payFriendPayUrl: refuses a redirect on the X-PAYMENT retry too, after a legitimate 402', async () => {
  let requests = 0;
  const { server, origin } = await listen((req, res) => {
    requests++;
    if (req.headers['x-payment']) {
      res.writeHead(302, { Location: 'http://evil.example/settled' });
      res.end();
      return;
    }
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify(validBody()));
  });
  try {
    const wallet = Wallet.createRandom();
    const result = await payFriendPayUrl({
      wallet, payUrl: `${origin}/kanjo/bills/1/pay?from=Aoi`, deployments, organizer, allowedOrigins: [origin],
    });
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /Redirect/);
    assert.equal(requests, 2); // the 402 fetch went through and was signed, but the retry's redirect was caught
  } finally {
    server.close();
  }
});

test('payFriendPayUrl: refuses a spoofed 402 whose accepts[0].to is not the organizer', async () => {
  const { server, origin } = await listen((_req, res) => {
    const body = validBody();
    body.accepts[0].to = '0x000000000000000000000000000000badc0de1';
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  try {
    const wallet = Wallet.createRandom();
    const result = await payFriendPayUrl({
      wallet, payUrl: `${origin}/kanjo/bills/1/pay?from=Aoi`, deployments, organizer, allowedOrigins: [origin],
    });
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /organizer/);
  } finally {
    server.close();
  }
});

test('payFriendPayUrl: refuses a payUrl outside the allowlist before ever fetching it', async () => {
  const wallet = Wallet.createRandom();
  const result = await payFriendPayUrl({
    wallet, payUrl: 'http://evil.example/kanjo/bills/1/pay', deployments, organizer, allowedOrigins: ['http://localhost:8787'],
  });
  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /not the api/);
});

test('payFriendPayUrl: a legitimate 402 (no redirect, correct terms) is signed and settled', async () => {
  let sawPaymentHeader = false;
  const { server, origin } = await listen((req, res) => {
    if (req.headers['x-payment']) {
      sawPaymentHeader = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ txHash: '0xsettled' }));
      return;
    }
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify(validBody()));
  });
  try {
    const wallet = Wallet.createRandom();
    const result = await payFriendPayUrl({
      wallet, payUrl: `${origin}/kanjo/bills/1/pay?from=Aoi`, deployments, organizer, allowedOrigins: [origin],
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { txHash: '0xsettled' });
    assert.ok(sawPaymentHeader);
  } finally {
    server.close();
  }
});
