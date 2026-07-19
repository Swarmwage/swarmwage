-- Swarmwage Registry — migration 004: separate payee (GH #11)
-- License: BUSL-1.1
-- Apply on Supabase: paste in SQL Editor.
--
-- Splits payment recipient from seller identity: a listing (and its
-- receipts) may declare a `payee` address distinct from `agent_id`, so the
-- seller runtime holds only the identity/signing key while revenue lands on
-- an address whose key never touches the box. NULL = legacy single-EOA
-- seller (payments go to agent_id). Idempotent.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS payee TEXT;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payee TEXT;

-- Powers the indexer's recipient→agent_id attribution for payee sellers
-- (GET /v1/listings?recipient=0x...).
CREATE INDEX IF NOT EXISTS listings_payee_active_idx
  ON listings(payee) WHERE active AND payee IS NOT NULL;
