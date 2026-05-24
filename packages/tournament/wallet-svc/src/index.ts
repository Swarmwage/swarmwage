// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// wallet-svc — sign-only sidecar for the agent tournament.
//
// Holds N agent private keys in memory and exposes generic signing
// primitives over HTTP on the internal Docker network only. Agents
// hold a remote-viem-account that forwards `signMessage` / `signTypedData`
// calls here. Keys are never returned over the wire and never logged.
//
// Per-wallet caps are enforced in a sliding-24h window:
//   - max sign requests per day
//   - max USDC value signed per day (parsed from TransferWithAuthorization
//     typed-data payloads on the USDC contract on Base)

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  isHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loadCaps, type Caps } from './caps.js';
import { loadWallets, type WalletStore } from './wallets.js';
import { CapLedger } from './cap-ledger.js';

const PORT = Number(process.env.PORT ?? 7000);
const WALLETS_PATH = process.env.WALLETS_PATH ?? '/secrets/wallets.json';
const CAPS_PATH = process.env.CAPS_PATH ?? '/secrets/caps.json';
const LEDGER_PATH = process.env.LEDGER_PATH ?? '/state/cap-ledger.json';

/** USDC contract on Base mainnet (FiatTokenV2.2). */
const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const wallets: WalletStore = loadWallets(WALLETS_PATH);
const caps: Caps = loadCaps(CAPS_PATH);
const ledger = new CapLedger(LEDGER_PATH);

const baseRpc = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
});

const balanceOfAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function accountFor(agentId: string) {
  const key = wallets[agentId];
  if (!key) throw httpError(404, 'unknown_agent');
  return privateKeyToAccount(key as Hex);
}

function capFor(agentId: string) {
  return caps[agentId] ?? caps.default;
}

function httpError(status: number, error: string, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Parse a typed-data payload to see if it's a USDC TransferWithAuthorization
 * on Base mainnet, and if so return the value (in 6-decimal base units).
 *
 * EIP-3009 typed-data payload shape from x402-sdk:
 * {
 *   domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fc...' },
 *   types: { ... },
 *   primaryType: 'TransferWithAuthorization',
 *   message: { from, to, value, validAfter, validBefore, nonce }
 * }
 */
function extractTransferValue(typedData: unknown): bigint | null {
  if (!typedData || typeof typedData !== 'object') return null;
  const td = typedData as {
    primaryType?: string;
    domain?: { chainId?: number | string; verifyingContract?: string };
    message?: { value?: string | number | bigint };
  };
  if (td.primaryType !== 'TransferWithAuthorization') return null;
  const chainId = Number(td.domain?.chainId);
  if (chainId !== 8453) return null; // not Base
  if (td.domain?.verifyingContract?.toLowerCase() !== USDC_BASE.toLowerCase()) return null;
  if (td.message?.value === undefined) return null;
  try {
    return BigInt(td.message.value as string | number | bigint);
  } catch {
    return null;
  }
}

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, agents: Object.keys(wallets).sort(), version: '0.0.1' }),
);

app.get('/wallets/:id/address', (c) => {
  try {
    const acct = accountFor(c.req.param('id'));
    return c.json({ agent_id: c.req.param('id'), address: acct.address });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
});

app.get('/wallets/:id/balance', async (c) => {
  try {
    const acct = accountFor(c.req.param('id'));
    const bal = await baseRpc.readContract({
      address: USDC_BASE,
      abi: balanceOfAbi,
      functionName: 'balanceOf',
      args: [acct.address],
    });
    return c.json({
      agent_id: c.req.param('id'),
      address: acct.address,
      usdc_raw: bal.toString(),
      usdc: Number(bal) / 1e6,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return c.json({ error: 'balance_lookup_failed', detail: String(e) }, 502);
  }
});

app.get('/wallets/:id/ledger', (c) => {
  const id = c.req.param('id');
  return c.json({
    agent_id: id,
    ledger: ledger.usage(id),
    caps: capFor(id),
  });
});

/**
 * Generic eth_personalSign — used by `wallet.signMessage({ message: { raw } })`
 * which is how the SDK signs receipts and listings (canonical-JSON-keccak256
 * hash → personal_sign).
 *
 * Body: { message: string | { raw: 0x-hex } }
 */
app.post('/wallets/:id/sign-message', async (c) => {
  const id = c.req.param('id');
  try {
    const acct = accountFor(id);
    const limit = capFor(id);
    const used = ledger.usage(id);
    if (used.signs >= limit.maxSignsPerDay) {
      return httpError(429, 'cap_exceeded', { kind: 'signs', used: used.signs, limit: limit.maxSignsPerDay });
    }
    const body = (await c.req.json()) as { message: string | { raw: Hex } };
    if (!body || !body.message) return httpError(400, 'missing_message');
    if (typeof body.message === 'object' && 'raw' in body.message && !isHex(body.message.raw)) {
      return httpError(400, 'raw_must_be_hex');
    }
    const signature = await acct.signMessage({ message: body.message });
    ledger.record(id, { signs: 1, valueUsdc: 0n, kind: 'message' });
    return c.json({ agent_id: id, signer: acct.address, signature });
  } catch (e) {
    if (e instanceof Response) return e;
    return c.json({ error: 'sign_failed', detail: String(e) }, 500);
  }
});

/**
 * Generic EIP-712 signTypedData. The sidecar parses the payload to detect
 * USDC TransferWithAuthorization on Base and enforces the per-wallet
 * value-per-day cap on those. Other typed-data shapes are signed without
 * value-cap accounting (but still subject to the per-day signs cap).
 *
 * Body: { domain, types, primaryType, message }
 */
app.post('/wallets/:id/sign-typed-data', async (c) => {
  const id = c.req.param('id');
  try {
    const acct = accountFor(id);
    const limit = capFor(id);
    const used = ledger.usage(id);
    if (used.signs >= limit.maxSignsPerDay) {
      return httpError(429, 'cap_exceeded', { kind: 'signs', used: used.signs, limit: limit.maxSignsPerDay });
    }

    const typedData = await c.req.json();
    const transferValue = extractTransferValue(typedData);

    if (transferValue !== null) {
      // Outbound USDC. Enforce value cap.
      const proposed = used.valueUsdc + transferValue;
      if (proposed > limit.maxValueUsdcPerDay) {
        return httpError(429, 'cap_exceeded', {
          kind: 'value',
          used: used.valueUsdc.toString(),
          requested: transferValue.toString(),
          limit: limit.maxValueUsdcPerDay.toString(),
        });
      }
    }

    const signature = await acct.signTypedData(typedData);

    ledger.record(id, {
      signs: 1,
      valueUsdc: transferValue ?? 0n,
      kind: transferValue !== null ? 'transfer-authorization' : 'typed-data',
    });

    return c.json({
      agent_id: id,
      signer: acct.address,
      signature,
      value_usdc_atomic: transferValue?.toString() ?? null,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return c.json({ error: 'sign_failed', detail: String(e) }, 500);
  }
});

/**
 * Orchestrator-only: snapshot of every wallet's USDC balance + ledger state.
 * Used by the leaderboard backend; this endpoint MUST be bound to the
 * internal docker network only (no public exposure).
 */
app.get('/internal/snapshot', async (c) => {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(wallets)) {
    try {
      const acct = accountFor(id);
      const bal = await baseRpc.readContract({
        address: USDC_BASE,
        abi: balanceOfAbi,
        functionName: 'balanceOf',
        args: [acct.address],
      });
      out[id] = {
        address: acct.address,
        usdc_raw: bal.toString(),
        usdc: Number(bal) / 1e6,
        ledger: ledger.usage(id),
      };
    } catch (e) {
      out[id] = { error: String(e) };
    }
  }
  return c.json({ as_of: new Date().toISOString(), wallets: out });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[wallet-svc] listening on :${info.port} — ${Object.keys(wallets).length} wallets`,
  );
});
