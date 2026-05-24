// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage

import type { CompoundTemplate } from '@swarmwage/tournament-shared';

export interface BuyerEnv {
  buyerId: string;
  walletSvcUrl: string;
  anthropicApiKey: string;
  registryUrl: string;
  rpcUrl: string;
  tickIntervalMs: number;
  tournamentStartIso: string;
  tournamentEndIso: string;
  maxApiUsd: number;
  memoryDir: string;
  /** Minimum USDC balance below which the buyer stops issuing new hires. */
  stopBalanceUsdc: number;
}

export interface RecentHire {
  ts: string;
  template: string;
  topic: string;
  seller_id?: string;
  price_usdc?: string;
  ok: boolean;
  error?: string;
}

export interface DecisionInput {
  buyerId: string;
  balanceUsdc: number;
  hoursRemaining: number;
  hoursElapsed: number;
  recentHires: RecentHire[];
  /** Aggregate seller stats from registry, for the LLM to pick the best vendor. */
  marketSummary: MarketSummary;
}

export interface MarketSummary {
  /** Per-template: how many distinct sellers currently advertise it. */
  template_listings: Record<string, number>;
  /** Per-template: cheapest current price observed. */
  template_min_price_usdc: Record<string, string | null>;
}

export type DecisionAction =
  | { type: 'hire'; template: string; topic: string; max_price_usdc: string; rationale: string }
  | { type: 'wait'; rationale: string };

export interface BuyerState {
  ticks: number;
  cumulativeApiUsd: number;
  recentHires: RecentHire[];
}

export interface PickedSeller {
  agent_id: string;
  endpoint: string;
  price_usdc: string;
}

export interface ResolvedTemplate {
  template: CompoundTemplate;
  topic: string;
}
