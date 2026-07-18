// Swarmwage Registry — external x402 reliability aggregation
// License: BUSL-1.1

import type {
  ExternalX402ReliabilityRecord,
  ExternalX402ServiceReliability,
} from "./types.js";

export function aggregateExternalX402Group(
  records: Array<ExternalX402ReliabilityRecord & { id: string }>,
): ExternalX402ServiceReliability {
  const latest = records.reduce((a, b) => (b.ts > a.ts ? b : a));
  const final_status_counts: Record<string, number> = {};
  const verifier_counts = { unknown: 0, pass: 0, fail: 0 };
  let paid = 0;
  let ok = 0;
  let withTx = 0;
  const latencies: number[] = [];

  for (const record of records) {
    const status = String(record.status);
    final_status_counts[status] = (final_status_counts[status] ?? 0) + 1;
    verifier_counts[record.verifier_status] += 1;
    if (record.amount_paid_usdc) paid += 1;
    if (!record.error && record.status >= 200 && record.status < 400) ok += 1;
    if (record.tx_hash) withTx += 1;
    latencies.push(record.latency_ms);
  }
  latencies.sort((a, b) => a - b);

  return {
    trust_level: "client_observed",
    source: latest.source,
    service_id: latest.service_id,
    service_name: latest.service_name,
    category: latest.category,
    endpoint_description: latest.endpoint_description,
    pricing_scheme: latest.pricing_scheme,
    url: latest.url,
    method: latest.method,
    calls: records.length,
    paid_calls: paid,
    success_rate: ok / records.length,
    final_status_counts,
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    last_call_ts: latest.ts,
    verifier_counts,
    tx_hash_coverage: withTx / records.length,
  };
}

function percentile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const index = Math.ceil(values.length * percentile) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)] ?? null;
}
