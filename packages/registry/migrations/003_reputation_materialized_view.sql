-- Swarmwage Registry — migration 003
-- License: BUSL-1.1
-- Apply on Supabase: paste into SQL Editor, or use `supabase db push`
--
-- Promotes the `reputation` view to a MATERIALIZED VIEW. The plain view ran
-- 6 correlated subqueries per agent, and /v1/search JOINs every active
-- listing against it — O(listings × hires) per query, which pins the
-- connection pool under load. Materializing turns search into a plain
-- indexed join; the server refreshes the matview on an interval
-- (REFRESH MATERIALIZED VIEW CONCURRENTLY, which needs the unique index).
--
-- Reputation now lags reality by up to one refresh interval. That is fine —
-- it is a reputation surface, not a balance. Note: because /v1/search INNER
-- JOINs this, a brand-new seller is searchable only after the next refresh.

DROP VIEW IF EXISTS reputation;

CREATE MATERIALIZED VIEW IF NOT EXISTS reputation AS
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

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY (non-blocking refresh).
CREATE UNIQUE INDEX IF NOT EXISTS reputation_agent_id_idx
  ON reputation(agent_id);
