-- Swarmwage Registry — migration 001
-- License: BUSL-1.1
-- Apply on Supabase: paste into SQL Editor, or use `supabase db push`
--
-- Background
-- ----------
-- The original architecture comment in `store/types.ts` said:
--   "Hires (written by indexer in production; insertable here for tests)"
-- — but the indexer service does not, in practice, write to `hires`. It is
-- a read-only Base USDC transfer observer.
--
-- Meanwhile, sellers submit signed receipts via `POST /v1/receipts` which
-- land in the `receipts` table (Layer 3 data capture). The `reputation`
-- view at `schema.sql` lines 116-150 reads exclusively from `hires`, so
-- every aggregate (`last_30d_hire_count`, `success_rate`, `avg_latency_ms`,
-- `last_24h_volume_usdc`) is zero or default even when real receipts exist.
--
-- Two-part fix
-- ------------
-- A. (this file) — backfill `hires` from existing `receipts`, idempotent
--    via ON CONFLICT (receipt_id) DO NOTHING so re-running is safe.
-- B. (`packages/registry/src/app.ts`) — extend `POST /v1/receipts` so every
--    new receipt also writes a row to `hires` immediately. This keeps the
--    two tables in sync going forward without resurrecting the indexer's
--    historical responsibility.
--
-- The `hires` table is retained because it carries fields (`latency_ms`,
-- `price_paid_usdc` already in USDC units, `created_at`) that downstream
-- analytics use and that we do not want to recompute from `receipts` at
-- query time. `latency_ms` is left NULL for backfilled rows; seller-side
-- latency is not currently included in the receipt schema. Future work:
-- extend ReceiptRecord with `latency_ms` and update the receipt handler
-- to pass it through.

INSERT INTO hires (
  receipt_id,
  buyer_id,
  seller_id,
  capability,
  tx_hash,
  price_paid_usdc,
  verification_passed,
  latency_ms,
  completed_at
)
SELECT
  r.id::text                                                AS receipt_id,
  r.buyer                                                   AS buyer_id,
  r.agent_id                                                AS seller_id,
  r.capability,
  r.tx_hash,
  (r.amount_usdc_atomic::NUMERIC / 1000000)::TEXT           AS price_paid_usdc,
  r.verification_all_passed                                 AS verification_passed,
  NULL                                                      AS latency_ms,
  r.completed_at
FROM receipts r
ON CONFLICT (receipt_id) DO NOTHING;

-- Verify post-apply (expected: every seller with at least one receipt now
-- shows a matching hires_count >= 1):
--
--   SELECT
--     a.agent_id,
--     (SELECT COUNT(*) FROM receipts r WHERE r.agent_id = a.agent_id) AS receipts,
--     (SELECT COUNT(*) FROM hires h    WHERE h.seller_id = a.agent_id) AS hires,
--     (SELECT last_30d_hire_count FROM reputation WHERE agent_id = a.agent_id)
--       AS last_30d_hire_count
--   FROM agents a
--   ORDER BY receipts DESC;
--
-- Then via curl from any client:
--   curl -X POST https://api.swarmwage.com/v1/search \
--     -H "Content-Type: application/json" \
--     -d '{"capability":"chart.generate.from-data","match":"exact"}' \
--     | jq '.agents[0].reputation.last_30d_hire_count'
-- Expected: integer >= 1 (was 0 before this migration + code change).
