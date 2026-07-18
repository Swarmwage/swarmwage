// Swarmwage Agent SDK — telemetry
// Sends best-effort, fire-and-forget pings to the canonical hub.
// Default ON; opt out via env var AGENT_TELEMETRY=0.
// License: MIT

import type { AgentId, CapabilityId } from "./types.js";

export const DEFAULT_TELEMETRY_URL = "https://api.swarmwage.com/telemetry";

export interface TelemetryEvent {
  ts: number;
  sdk_version: string;
  agent_id: AgentId | null;
  event:
    | { kind: "search"; capability: CapabilityId; result_count: number }
    | { kind: "hire_attempt"; capability: CapabilityId; seller_id: AgentId | null }
    | {
        kind: "hire_complete";
        capability: CapabilityId;
        seller_id: AgentId;
        price_usdc: string;
        latency_ms: number;
        all_passed: boolean;
      }
    | { kind: "hire_failed"; capability: CapabilityId; reason: string }
    | (ExternalX402TelemetryBase & { kind: "x402_call" })
    | {
        kind: "x402_call_complete";
        url: string;
        method?: string;
        amount_usdc: string | null;
        latency_ms: number;
        status: number;
        tx_hash?: string;
        reliability_record_id?: string;
        source?: string;
        service_id?: string;
        service_name?: string;
        endpoint_description?: string;
        category?: string;
        pricing_scheme?: string;
      }
    | (ExternalX402TelemetryBase & { kind: "x402_call_failed"; reason: string })
    | { kind: "rate"; stars: number };
}

interface ExternalX402TelemetryBase {
  url: string;
  method?: string;
  max_price_usdc?: string;
  source?: string;
  service_id?: string;
  service_name?: string;
  endpoint_description?: string;
  category?: string;
  pricing_scheme?: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  url: string;
  agentId: AgentId | null;
}

export function createTelemetry(opts?: Partial<TelemetryConfig>): {
  send: (event: TelemetryEvent["event"]) => void;
} {
  const enabled =
    opts?.enabled ??
    (typeof process !== "undefined" && process.env?.AGENT_TELEMETRY !== "0");
  const url = opts?.url ?? DEFAULT_TELEMETRY_URL;
  const agentId = opts?.agentId ?? null;

  return {
    send(event) {
      if (!enabled) return;
      const payload: TelemetryEvent = {
        ts: Date.now(),
        sdk_version: "0.0.1",
        agent_id: agentId,
        event,
      };
      // Fire-and-forget. Do not block, do not throw.
      try {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          // Don't keep the process alive for telemetry
          keepalive: true,
        }).catch(() => {});
      } catch {
        // swallow
      }
    },
  };
}
