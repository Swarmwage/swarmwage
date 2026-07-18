// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage

import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';

export type WalletStore = Record<string, Hex>;

/**
 * Load wallets from `WALLETS_PATH`. The file is expected to be a JSON object
 * mapping agent_id → 0x-prefixed 32-byte private key.
 *
 * In production this file is mounted from a Docker secret or a tmpfs volume
 * decrypted at boot from `.wallets.json.enc` via `WALLET_PASSPHRASE`. It is
 * NEVER baked into an image and NEVER committed to git.
 */
export function loadWallets(path: string): WalletStore {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, string>;
  const out: WalletStore = {};
  for (const [id, key] of Object.entries(parsed)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(`Invalid private key for agent ${id}`);
    }
    out[id] = key as Hex;
  }
  if (Object.keys(out).length === 0) throw new Error('No wallets loaded');
  return out;
}
