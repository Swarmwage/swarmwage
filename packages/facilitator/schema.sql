-- Swarmwage Facilitator — Postgres schema
-- License: BUSL-1.1
-- Apply on Supabase: paste in SQL Editor or use `supabase db push`

CREATE TABLE IF NOT EXISTS facilitator_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  route TEXT NOT NULL CHECK (route IN ('verify', 'settle')),
  network TEXT NOT NULL,
  agent_id TEXT,
  capability TEXT,
  payer_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  amount_usdc_atomic BIGINT NOT NULL,
  tx_hash TEXT,
  gas_eth_spent_wei BIGINT,
  latency_ms INTEGER NOT NULL,
  ok BOOLEAN NOT NULL,
  error TEXT,
  raw_request JSONB NOT NULL,
  raw_response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS facilitator_logs_ts_idx
  ON facilitator_logs(ts DESC);

CREATE INDEX IF NOT EXISTS facilitator_logs_recipient_ts_idx
  ON facilitator_logs(recipient_address, ts DESC);

CREATE INDEX IF NOT EXISTS facilitator_logs_payer_ts_idx
  ON facilitator_logs(payer_address, ts DESC);

CREATE INDEX IF NOT EXISTS facilitator_logs_route_ts_idx
  ON facilitator_logs(route, ts DESC);
