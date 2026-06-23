// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Verifies the remote account forwards the per-wallet bearer token to wallet-svc
// (the 2b caller-side half of the auth boundary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAccount } from '../remote-account.js';

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ signature: '0xdeadbeef' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('forwards Authorization: Bearer <token> when configured', async () => {
  const { calls, fetchImpl } = captureFetch();
  const acct = createRemoteAccount({
    address: '0x0000000000000000000000000000000000000001',
    walletSvcUrl: 'http://wallet-svc:7000',
    agentId: 'agent_01',
    token: 'tok-agent-01-aaaaaaaa',
    fetchImpl,
  });
  await acct.signMessage({ message: 'hi' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer tok-agent-01-aaaaaaaa');
});

test('omits Authorization when no token is set', async () => {
  delete process.env.WALLET_SVC_TOKEN;
  const { calls, fetchImpl } = captureFetch();
  const acct = createRemoteAccount({
    address: '0x0000000000000000000000000000000000000001',
    walletSvcUrl: 'http://wallet-svc:7000',
    agentId: 'agent_01',
    fetchImpl,
  });
  await acct.signMessage({ message: 'hi' });
  assert.equal(calls[0].headers.authorization, undefined);
});
