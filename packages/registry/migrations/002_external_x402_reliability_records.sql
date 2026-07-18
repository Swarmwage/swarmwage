-- Swarmwage Registry — migration 002
-- License: BUSL-1.1
-- Apply on Supabase: paste into SQL Editor, or use `supabase db push`
--
-- Adds client-observed reliability evidence for third-party x402 services.
-- This table is deliberately separate from seller-signed receipts: external
-- records say "a Swarmwage client observed this endpoint behaving this way",
-- not "the seller signed a Swarmwage hire receipt".

CREATE TABLE IF NOT EXISTS external_x402_reliability_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL,
  trust_level TEXT NOT NULL CHECK (trust_level = 'client_observed'),
  buyer_agent_id TEXT,
  source TEXT,
  service_id TEXT,
  service_name TEXT,
  category TEXT,
  endpoint_description TEXT,
  pricing_scheme TEXT,
  url TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL CHECK (status BETWEEN 0 AND 599),
  amount_paid_usdc TEXT,
  tx_hash TEXT,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  request_hash TEXT,
  response_hash TEXT NOT NULL,
  verifier_kind TEXT NOT NULL CHECK (verifier_kind IN ('none','json','custom')),
  verifier_status TEXT NOT NULL CHECK (verifier_status IN ('unknown','pass','fail')),
  verifier_checks JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS external_x402_reliability_service_ts_idx
  ON external_x402_reliability_records(source, service_id, ts DESC);

CREATE INDEX IF NOT EXISTS external_x402_reliability_url_ts_idx
  ON external_x402_reliability_records(url, method, ts DESC);

CREATE INDEX IF NOT EXISTS external_x402_reliability_tx_hash_idx
  ON external_x402_reliability_records(tx_hash)
  WHERE tx_hash IS NOT NULL;
