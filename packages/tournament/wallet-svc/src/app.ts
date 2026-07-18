// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// wallet-svc HTTP app factory. Separated from index.ts so the auth boundary is
// unit-testable without disk I/O or a live listener (via `app.request(...)`).
//
// Auth boundary: every `/wallets/:id/*` route requires a bearer token bound to
// exactly that `:id`. Per-wallet caps remain a *secondary* limiter, not the
// authorization boundary — a compromised agent can no longer sign for another.

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
import type { Caps } from './caps.js';
import type { WalletStore } from './wallets.js';
import type { CapLedger } from './cap-ledger.js';
import { requireWalletToken, requireOrchestratorToken } from './auth.js';
import { reverseTokens, type TokenStore } from './tokens.js';

/** USDC contract on Base mainnet (FiatTokenV2.2). */
const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const balanceOfAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Minimal ledger surface the app needs — lets tests pass a fake. */
export type LedgerLike = Pick<CapLedger, 'usage' | 'record'>;

export interface AppDeps {
  wallets: WalletStore;
  caps: Caps;
  ledger: LedgerLike;
  /** When true, `/wallets/:id/*` and `/internal/*` require bearer auth. */
  authEnabled: boolean;
  /** Per-agent bearer tokens (required when authEnabled). */
  tokens?: TokenStore;
  /** Token for `/internal/*` fleet-wide reads (orchestrator). */
  orchestratorToken?: string | null;
}

export function createApp(deps: AppDeps) {
  const { wallets, caps, ledger, authEnabled } = deps;
  const baseRpc = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
  });

  const tokenToAgent = authEnabled
    ? reverseTokens(deps.tokens ?? {})
    : new Map<string, string>();

  function httpError(status: number, error: string, extra?: Record<string, unknown>) {
    return new Response(JSON.stringify({ error, ...extra }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function accountFor(agentId: string) {
    const key = wallets[agentId];
    if (!key) throw httpError(404, 'unknown_agent');
    return privateKeyToAccount(key as Hex);
  }

  function capFor(agentId: string) {
    return caps[agentId] ?? caps.default;
  }

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

  // Aggregate liveness only — deliberately NO wallet-id enumeration (the old
  // `agents: [...]` list was free reconnaissance for an attacker on the
  // internal network).
  app.get('/health', (c) =>
    c.json({ ok: true, agentCount: Object.keys(wallets).length, version: '0.0.1' }),
  );

  // Auth boundary. Registered before the routes below so it applies to them.
  // No-op only when authEnabled is false (LOCAL DEV / tests).
  if (authEnabled) {
    app.use('/wallets/:id/*', requireWalletToken(tokenToAgent));
    app.use('/internal/*', requireOrchestratorToken(deps.orchestratorToken ?? null));
  }

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
    return c.json({ agent_id: id, ledger: ledger.usage(id), caps: capFor(id) });
  });

  /**
   * Generic eth_personalSign — used by `wallet.signMessage({ message: { raw } })`
   * which is how the SDK signs receipts and listings (canonical-JSON-keccak256
   * hash → personal_sign).
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
   * value-per-day cap on those.
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
   * Guarded by the orchestrator token; this endpoint MUST also be bound to the
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

  return app;
}
