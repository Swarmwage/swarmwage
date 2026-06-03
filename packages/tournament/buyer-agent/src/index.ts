// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Buyer-agent entry point. One container per external buyer (buyer_01,
// buyer_02). Tick loop: each TICK_INTERVAL_MS, ask Claude Haiku 4.5 what
// to demand, then execute the hire via the Swarmwage protocol.
//
// The buyer-agent has NO seller HTTP surface — it only initiates hires.
// Capital flows: BUYER -> compound broker (internal agent) -> sub-hired
// specialists (internal agents). The buyer's $10 is the only exogenous
// money entering the closed 10-agent economy.

// Allow .env files to populate process.env in local dev. In Docker compose,
// env is injected directly and the file is absent — `dotenv` is a no-op.
import 'dotenv/config';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { COMPOUND_TEMPLATES, templateByName } from '@swarmwage/tournament-shared';
import type { Address } from 'viem';
import { createRemoteAccount } from './remote-account.js';
import { decide } from './decide.js';
import {
  buildMarketSummary,
  fetchBalanceUsdc,
  hireCompound,
  pickSellerForTemplate,
} from './publish.js';
import type { BuyerEnv, BuyerState, RecentHire } from './types.js';
import { emitTick } from './emit-tick.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function parseEnv(): BuyerEnv {
  return {
    buyerId: required('BUYER_ID'),
    walletSvcUrl: required('WALLET_SVC_URL'),
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    registryUrl: process.env.REGISTRY_URL ?? 'https://api.swarmwage.com',
    rpcUrl: process.env.RPC_URL ?? 'https://mainnet.base.org',
    tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 5 * 60 * 1000),
    tournamentStartIso: required('TOURNAMENT_START_ISO'),
    tournamentEndIso: required('TOURNAMENT_END_ISO'),
    maxApiUsd: Number(process.env.MAX_API_USD ?? 1),
    memoryDir: process.env.MEMORY_DIR ?? '/agent/memory',
    stopBalanceUsdc: Number(process.env.STOP_BALANCE_USDC ?? 0.2),
  };
}

async function resolveAddress(env: BuyerEnv): Promise<Address> {
  const res = await fetch(
    `${env.walletSvcUrl.replace(/\/$/, '')}/wallets/${env.buyerId}/address`,
  );
  if (!res.ok) {
    throw new Error(`wallet-svc address lookup ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { address: Address };
  if (!data.address) throw new Error('wallet-svc returned no address');
  return data.address;
}

function appendTickLog(env: BuyerEnv, record: unknown): void {
  const path = `${env.memoryDir}/tick-log.jsonl`;
  try {
    appendFileSync(path, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error(`[${env.buyerId}] tick-log append failed:`, e);
  }
}

(async () => {
  const env = parseEnv();
  if (!existsSync(env.memoryDir)) mkdirSync(env.memoryDir, { recursive: true });

  const address = await resolveAddress(env);
  const account = createRemoteAccount({
    agentId: env.buyerId,
    walletSvcUrl: env.walletSvcUrl,
    address,
  });

  const startMs = new Date(env.tournamentStartIso).getTime();
  const endMs = new Date(env.tournamentEndIso).getTime();

  console.log(
    `[${env.buyerId}] online address=${address} registry=${env.registryUrl} tick=${env.tickIntervalMs}ms`,
  );

  const state: BuyerState = {
    ticks: 0,
    cumulativeApiUsd: 0,
    recentHires: [],
  };

  while (Date.now() < endMs) {
    if (state.cumulativeApiUsd >= env.maxApiUsd) {
      console.log(
        `[${env.buyerId}] API budget exhausted ($${state.cumulativeApiUsd.toFixed(3)} / $${env.maxApiUsd}) — going dormant`,
      );
      break;
    }

    state.ticks += 1;
    const tickStart = Date.now();
    const tickN = state.ticks;

    let balanceUsdc = 0;
    try {
      balanceUsdc = await fetchBalanceUsdc({
        walletSvcUrl: env.walletSvcUrl,
        buyerId: env.buyerId,
      });
    } catch (e) {
      console.error(`[${env.buyerId}] balance lookup failed:`, e);
      appendTickLog(env, {
        ts: new Date().toISOString(),
        tick: tickN,
        error: `balance: ${String(e)}`,
      });
      await sleep(env.tickIntervalMs);
      continue;
    }

    if (balanceUsdc < env.stopBalanceUsdc) {
      console.log(
        `[${env.buyerId}] balance ${balanceUsdc.toFixed(4)} below stop ${env.stopBalanceUsdc} — done`,
      );
      appendTickLog(env, {
        ts: new Date().toISOString(),
        tick: tickN,
        event: 'stop_low_balance',
        balance_usdc: balanceUsdc,
      });
      break;
    }

    const market = await buildMarketSummary({
      registryUrl: env.registryUrl,
      templates: COMPOUND_TEMPLATES,
    }).catch((e) => {
      console.error(`[${env.buyerId}] market summary failed:`, e);
      return {
        template_listings: {},
        template_min_price_usdc: {},
      };
    });

    const hoursElapsed = Math.max(0, (tickStart - startMs) / 3_600_000);
    const hoursRemaining = Math.max(0, (endMs - tickStart) / 3_600_000);

    let decideRes;
    try {
      decideRes = await decide({
        apiKey: env.anthropicApiKey,
        buyerId: env.buyerId,
        input: {
          buyerId: env.buyerId,
          balanceUsdc,
          hoursElapsed,
          hoursRemaining,
          recentHires: state.recentHires.slice(-10),
          marketSummary: market,
        },
      });
    } catch (e) {
      console.error(`[${env.buyerId}] decide failed:`, e);
      appendTickLog(env, {
        ts: new Date().toISOString(),
        tick: tickN,
        error: `decide: ${String(e)}`,
      });
      await sleep(env.tickIntervalMs);
      continue;
    }

    state.cumulativeApiUsd += decideRes.usdSpent;
    const action = decideRes.action;

    if (action.type === 'wait') {
      appendTickLog(env, {
        ts: new Date().toISOString(),
        tick: tickN,
        action: 'wait',
        balance_usdc: balanceUsdc,
        api_usd_cum: state.cumulativeApiUsd,
        rationale: action.rationale,
      });
      console.log(`[${env.buyerId}] tick ${tickN} WAIT — ${action.rationale}`);
      emitTick({
        agent_id: env.buyerId,
        tick: tickN,
        action: 'wait',
        rationale: action.rationale,
        detail: { balance_usdc: balanceUsdc },
      });
      await sleep(remaining(env.tickIntervalMs, tickStart));
      continue;
    }

    const tpl = templateByName(action.template);
    if (!tpl) {
      const fail: RecentHire = {
        ts: new Date().toISOString(),
        template: action.template,
        topic: action.topic,
        ok: false,
        error: 'unknown_template',
      };
      state.recentHires.push(fail);
      appendTickLog(env, { tick: tickN, action: 'hire', ...fail });
      await sleep(remaining(env.tickIntervalMs, tickStart));
      continue;
    }

    const seller = await pickSellerForTemplate({
      registryUrl: env.registryUrl,
      template: tpl,
      max_price_usdc: action.max_price_usdc,
    }).catch((e) => {
      console.error(`[${env.buyerId}] seller pick failed:`, e);
      return null;
    });

    if (!seller) {
      const fail: RecentHire = {
        ts: new Date().toISOString(),
        template: action.template,
        topic: action.topic,
        ok: false,
        error: 'no_seller',
      };
      state.recentHires.push(fail);
      appendTickLog(env, { tick: tickN, action: 'hire', ...fail });
      console.log(
        `[${env.buyerId}] tick ${tickN} no seller for ${action.template} @ ${action.max_price_usdc}`,
      );
      await sleep(remaining(env.tickIntervalMs, tickStart));
      continue;
    }

    try {
      const result = await hireCompound({
        account,
        rpcUrl: env.rpcUrl,
        seller,
        template: tpl,
        topic: action.topic,
        max_price_usdc: action.max_price_usdc,
      });
      const ok: RecentHire = {
        ts: new Date().toISOString(),
        template: action.template,
        topic: action.topic,
        seller_id: seller.agent_id,
        price_usdc: seller.price_usdc,
        ok: true,
      };
      state.recentHires.push(ok);
      appendTickLog(env, {
        tick: tickN,
        action: 'hire',
        ...ok,
        api_usd_cum: state.cumulativeApiUsd,
        balance_usdc_before: balanceUsdc,
        result_preview: previewResult(result),
        rationale: action.rationale,
      });
      console.log(
        `[${env.buyerId}] tick ${tickN} HIRE ${action.template} seller=${seller.agent_id} price=${seller.price_usdc} cap=${action.max_price_usdc}`,
      );
      emitTick({
        agent_id: env.buyerId,
        tick: tickN,
        action: 'hire',
        rationale: action.rationale,
        detail: {
          template: action.template,
          topic: action.topic,
          seller_id: seller.agent_id,
          price_usdc: seller.price_usdc,
        },
      });
    } catch (e) {
      const fail: RecentHire = {
        ts: new Date().toISOString(),
        template: action.template,
        topic: action.topic,
        seller_id: seller.agent_id,
        price_usdc: seller.price_usdc,
        ok: false,
        error: String(e).slice(0, 200),
      };
      state.recentHires.push(fail);
      appendTickLog(env, { tick: tickN, action: 'hire', ...fail });
      console.error(`[${env.buyerId}] tick ${tickN} HIRE failed:`, e);
    }

    // Keep recentHires bounded
    if (state.recentHires.length > 50) {
      state.recentHires = state.recentHires.slice(-50);
    }

    await sleep(remaining(env.tickIntervalMs, tickStart));
  }

  console.log(
    `[${env.buyerId}] tournament ended ticks=${state.ticks} api_spend=$${state.cumulativeApiUsd.toFixed(3)}`,
  );
})().catch((e) => {
  console.error('[buyer-agent] fatal:', e);
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function remaining(intervalMs: number, tickStart: number): number {
  return Math.max(0, intervalMs - (Date.now() - tickStart));
}

function previewResult(r: unknown): unknown {
  if (typeof r !== 'object' || r === null) return r;
  const s = JSON.stringify(r);
  if (s.length <= 400) return r;
  return { preview: s.slice(0, 400) };
}
