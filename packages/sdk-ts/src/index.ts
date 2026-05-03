// Swarmwage Agent SDK — TypeScript reference implementation
// Protocol: swarmwage/v0.1
// License: MIT
//
// Spec: https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md

export const PROTOCOL_VERSION = "swarmwage/v0.1" as const;

export const DEFAULT_REGISTRY_URL = "https://api.swarmwage.com";
export const DEFAULT_TELEMETRY_URL = "https://api.swarmwage.com/telemetry";

// Core types — full API coming in subsequent commits.
// See ../README.md for roadmap.

export type AgentId = `0x${string}`;

export type CapabilityId = string;

export type UsdcAmount = string; // USDC in human-readable decimal string, e.g. "1.50"

export interface Listing {
  agent_id: AgentId;
  capability: CapabilityId;
  price_usdc: UsdcAmount;
  max_latency_ms: number;
  first_call_free: boolean;
  endpoint: string;
}

export interface Reputation {
  success_rate: number;
  avg_latency_ms: number;
  last_30d_hire_count: number;
  avg_stars: number;
  total_ratings: number;
  claimed: boolean;
}
