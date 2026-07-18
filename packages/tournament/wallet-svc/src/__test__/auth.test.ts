// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Auth-boundary tests for the wallet sidecar. Proves a bearer token is bound to
// exactly one wallet id and cannot sign for another — the P0 fix. Keys are
// generated at runtime (no private-key literals in source).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import { createApp, type LedgerLike } from '../app.js';
import type { Caps } from '../caps.js';
import type { WalletStore } from '../wallets.js';

const wallets: WalletStore = {
  agent_01: generatePrivateKey(),
  agent_02: generatePrivateKey(),
};
const TOKENS = { agent_01: 'tok-agent-01-aaaaaaaa', agent_02: 'tok-agent-02-bbbbbbbb' };
const ORCH_TOKEN = 'orchestrator-token-cccccccc';
const caps: Caps = { default: { maxSignsPerDay: 1000, maxValueUsdcPerDay: 10_000_000n } };

function fakeLedger(): LedgerLike {
  return { usage: () => ({ signs: 0, valueUsdc: 0n }), record: () => {} };
}

function appWithAuth() {
  return createApp({
    wallets,
    caps,
    ledger: fakeLedger(),
    tokens: TOKENS,
    orchestratorToken: ORCH_TOKEN,
    authEnabled: true,
  });
}

const signBody = JSON.stringify({ message: 'hello board' });
const hdr = (tok?: string) => ({
  'content-type': 'application/json',
  ...(tok ? { authorization: `Bearer ${tok}` } : {}),
});

test('signing without a token is rejected (401)', async () => {
  const res = await appWithAuth().request('/wallets/agent_01/sign-message', {
    method: 'POST',
    headers: hdr(),
    body: signBody,
  });
  assert.equal(res.status, 401);
});

test('a wallet token signs for its own wallet (200)', async () => {
  const res = await appWithAuth().request('/wallets/agent_01/sign-message', {
    method: 'POST',
    headers: hdr(TOKENS.agent_01),
    body: signBody,
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { signature: string };
  assert.match(json.signature, /^0x[0-9a-fA-F]+$/);
});

test('a wallet token CANNOT sign for another wallet (403)', async () => {
  const res = await appWithAuth().request('/wallets/agent_02/sign-message', {
    method: 'POST',
    headers: hdr(TOKENS.agent_01),
    body: signBody,
  });
  assert.equal(res.status, 403);
});

test('an unknown token is rejected (401)', async () => {
  const res = await appWithAuth().request('/wallets/agent_01/sign-message', {
    method: 'POST',
    headers: hdr('not-a-real-token'),
    body: signBody,
  });
  assert.equal(res.status, 401);
});

test('/health does not enumerate wallet ids', async () => {
  const res = await appWithAuth().request('/health');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes('agent_01') && !body.includes('agent_02'), 'health must not list wallet ids');
  assert.equal((JSON.parse(body) as { agentCount: number }).agentCount, 2);
});

test('/internal/snapshot requires the orchestrator token (401)', async () => {
  const res = await appWithAuth().request('/internal/snapshot');
  assert.equal(res.status, 401);
});

test('an agent token cannot reach /internal/snapshot (401)', async () => {
  const res = await appWithAuth().request('/internal/snapshot', { headers: hdr(TOKENS.agent_01) });
  assert.equal(res.status, 401);
});

test('dev mode (authEnabled=false) bypasses auth', async () => {
  const app = createApp({ wallets, caps, ledger: fakeLedger(), authEnabled: false });
  const res = await app.request('/wallets/agent_01/sign-message', {
    method: 'POST',
    headers: hdr(),
    body: signBody,
  });
  assert.equal(res.status, 200);
});
