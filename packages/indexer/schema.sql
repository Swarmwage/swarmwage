-- Swarmwage Indexer — Postgres schema
-- License: BUSL-1.1
-- Apply on Supabase: paste in SQL Editor or use `supabase db push`

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  recipient_agent_id TEXT,
  -- Attribution for known external (non-Swarmwage) recipients, e.g. addresses
  -- harvested from a public x402 catalog. Orthogonal to recipient_agent_id.
  recipient_source TEXT,
  recipient_label TEXT,
  value_usdc_atomic BIGINT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transactions_block_log_unique UNIQUE (chain_id, block_number, log_index)
);

-- Additive migration for databases created before external attribution.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_source TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_label TEXT;

CREATE INDEX IF NOT EXISTS transactions_recipient_agent_ts_idx
  ON transactions(recipient_agent_id, ts DESC)
  WHERE recipient_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_to_address_ts_idx
  ON transactions(to_address, ts DESC);

CREATE INDEX IF NOT EXISTS transactions_recipient_source_ts_idx
  ON transactions(recipient_source, ts DESC)
  WHERE recipient_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_block_log_idx
  ON transactions(block_number, log_index);

CREATE INDEX IF NOT EXISTS transactions_ts_idx
  ON transactions(ts DESC);

CREATE TABLE IF NOT EXISTS indexer_state (
  chain_id INTEGER PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
