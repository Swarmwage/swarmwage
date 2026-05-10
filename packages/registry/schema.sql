-- Swarmwage Registry — Postgres schema
-- License: BUSL-1.1
-- Apply on Supabase: paste in SQL Editor or use `supabase db push`

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  claimed_by_handle TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  price_usdc TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC',
  chain TEXT NOT NULL DEFAULT 'base',
  max_latency_ms INTEGER NOT NULL,
  first_call_free BOOLEAN NOT NULL DEFAULT FALSE,
  endpoint TEXT NOT NULL,
  signature TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, capability)
);
CREATE INDEX IF NOT EXISTS listings_capability_active_idx
  ON listings(capability) WHERE active;

CREATE TABLE IF NOT EXISTS hires (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id TEXT UNIQUE NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  price_paid_usdc TEXT NOT NULL,
  verification_passed BOOLEAN NOT NULL,
  latency_ms INTEGER,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hires_seller_idx ON hires(seller_id);
CREATE INDEX IF NOT EXISTS hires_buyer_idx ON hires(buyer_id);
CREATE INDEX IF NOT EXISTS hires_completed_at_idx ON hires(completed_at DESC);

-- Note on receipt_id: stored as opaque TEXT (currently the rating_token is
-- reused as a placeholder receipt_id). No FK to hires/receipts because
-- cross-correlation is application-side via the indexer joining
-- facilitator_logs + receipts on (payer, recipient, amount, ts).
CREATE TABLE IF NOT EXISTS ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_token TEXT UNIQUE NOT NULL,
  receipt_id TEXT NOT NULL,
  rater_id TEXT NOT NULL,
  rated_id TEXT NOT NULL,
  stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  latency_ms INTEGER,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ratings_rated_idx ON ratings(rated_id);

CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  x_handle TEXT NOT NULL,
  verification_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

-- Seller-submitted receipts (Layer 3 of 4-layer data capture).
-- Each row is a signed attestation by the seller that a hire happened.
-- Idempotent on (hire_id, agent_id) so retries don't duplicate.
-- The on-chain indexer (Layer 2) cross-correlates `tx_hash` with USDC
-- Transfer events; no on-chain check is performed here at write time.
CREATE TABLE IF NOT EXISTS receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_version TEXT NOT NULL,
  hire_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  buyer TEXT NOT NULL,
  capability TEXT NOT NULL,
  capability_version TEXT,
  amount_usdc_atomic TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('base', 'base-sepolia')),
  tx_hash TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  verification_all_passed BOOLEAN NOT NULL,
  verification_checks JSONB NOT NULL,
  signature TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(hire_id, agent_id)
);
CREATE INDEX IF NOT EXISTS receipts_agent_ts_idx
  ON receipts(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS receipts_capability_ts_idx
  ON receipts(capability, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_tx_hash_idx
  ON receipts(tx_hash);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL,
  sdk_version TEXT,
  agent_id TEXT,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS telemetry_ts_idx ON telemetry_events(ts DESC);

-- Reputation view (computed on-the-fly; promote to materialized view at scale)
CREATE OR REPLACE VIEW reputation AS
SELECT
  a.agent_id,
  a.claimed_by_handle IS NOT NULL AS claimed,
  COALESCE(
    (SELECT COUNT(*) FILTER (WHERE verification_passed)::FLOAT
       / NULLIF(COUNT(*), 0)
     FROM hires h WHERE h.seller_id = a.agent_id),
    1.0
  ) AS success_rate,
  COALESCE(
    (SELECT AVG(latency_ms) FROM hires h WHERE h.seller_id = a.agent_id),
    0
  ) AS avg_latency_ms,
  COALESCE(
    (SELECT COUNT(*) FROM hires h
     WHERE h.seller_id = a.agent_id
       AND h.completed_at > NOW() - INTERVAL '30 days'),
    0
  ) AS last_30d_hire_count,
  COALESCE(
    (SELECT SUM(price_paid_usdc::NUMERIC)::TEXT FROM hires h
     WHERE h.seller_id = a.agent_id
       AND h.completed_at > NOW() - INTERVAL '24 hours'),
    '0.00'
  ) AS last_24h_volume_usdc,
  COALESCE(
    (SELECT COUNT(*) FROM ratings r WHERE r.rated_id = a.agent_id),
    0
  ) AS total_ratings,
  COALESCE(
    (SELECT AVG(stars) FROM ratings r WHERE r.rated_id = a.agent_id),
    0
  ) AS avg_stars
FROM agents a;
