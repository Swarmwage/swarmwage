// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Route Node's global `fetch` (undici) through the egress proxy.
//
// WHY THIS EXISTS: the tournament agent containers sit on a Docker `internal`
// network with NO direct outbound (and no public DNS). All egress must go via
// the `egress-proxy` (Tinyproxy) allowlist. But Node's built-in fetch / the
// Vercel AI SDK do NOT honor HTTP_PROXY/HTTPS_PROXY env vars on their own, so
// without this every LLM call fails with `getaddrinfo EAI_AGAIN`.
//
// We install an undici EnvHttpProxyAgent as the global dispatcher. It reads
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY from the environment, so internal hosts
// listed in NO_PROXY (wallet-svc, leaderboard, orchestrator, localhost) are
// reached directly while everything else tunnels through the proxy.
//
// Import this module FIRST (before any module that may call fetch).

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '';

if (proxy) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[proxy] global dispatcher → ${proxy} (NO_PROXY=${process.env.NO_PROXY ?? ''})`);
  } catch (err) {
    console.error('[proxy] failed to install proxy dispatcher:', err);
  }
}
