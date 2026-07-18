// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Bearer-token auth for the wallet sidecar. A token is bound to exactly one
// agent_id; a request to `/wallets/:id/*` must present that agent's token AND
// `:id` must match. This makes per-wallet caps a *secondary* limiter rather
// than the authorization boundary — a compromised agent container can no
// longer request signatures for another agent's wallet.

import type { MiddlewareHandler } from 'hono';

/** Parse a `Bearer <token>` Authorization header. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Require that the caller's bearer token is bound to the `:id` wallet it is
 * acting on. `tokenToAgent` maps token → owning agent_id.
 */
export function requireWalletToken(tokenToAgent: Map<string, string>): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'missing_bearer_token' }, 401);
    const owner = tokenToAgent.get(token);
    if (!owner) return c.json({ error: 'invalid_token' }, 401);
    if (owner !== c.req.param('id')) {
      return c.json({ error: 'token_wallet_mismatch' }, 403);
    }
    return next();
  };
}

/**
 * Require the orchestrator token for fleet-wide read routes (`/internal/*`),
 * which expose every wallet's state and must not be reachable by an agent token.
 */
export function requireOrchestratorToken(orchestratorToken: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (!orchestratorToken) {
      return c.json({ error: 'orchestrator_auth_unavailable' }, 503);
    }
    const token = extractBearer(c.req.header('authorization'));
    if (!token || token !== orchestratorToken) {
      return c.json({ error: 'invalid_orchestrator_token' }, 401);
    }
    return next();
  };
}
