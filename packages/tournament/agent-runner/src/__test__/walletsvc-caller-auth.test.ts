// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Static guard for the wallet-svc auth boundary (caller side). Scans every
// runtime caller package for a fetch to a `/wallets/:id/*` or
// `/internal/snapshot` URL and fails if the call site has no Authorization /
// token wiring near it. This is the cheap check that catches the *class* of
// miss (a new caller path added without a bearer) that per-function unit tests
// keep walking past.
//
// remote-account.ts is excluded: its signing fetches funnel through a shared
// `call()` helper that injects the bearer, and that path is covered directly by
// remote-account.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOURNAMENT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CALLER_DIRS = ['agent-runner/src', 'buyer-agent/src', 'orchestrator/src'];
const NEEDLES = ['/wallets/', '/internal/snapshot'];
const AUTH = /authorization|Bearer|WALLET_SVC_TOKEN|ORCHESTRATOR_TOKEN/i;
const WINDOW = 400; // chars either side of the URL literal

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__test__') continue;
      out.push(...tsFiles(p));
    } else if (e.name.endsWith('.ts') && e.name !== 'remote-account.ts') {
      out.push(p);
    }
  }
  return out;
}

test('every wallet-svc caller fetch carries an Authorization/token', () => {
  const violations: string[] = [];
  let matched = 0;
  for (const rel of CALLER_DIRS) {
    for (const file of tsFiles(join(TOURNAMENT_ROOT, rel))) {
      const src = readFileSync(file, 'utf-8');
      for (const needle of NEEDLES) {
        let i = src.indexOf(needle);
        while (i !== -1) {
          matched += 1;
          const win = src.slice(Math.max(0, i - WINDOW), i + WINDOW);
          if (!AUTH.test(win)) {
            violations.push(`${basename(file)} @ "${needle}": ${src.slice(i, i + 60)}`);
          }
          i = src.indexOf(needle, i + 1);
        }
      }
    }
  }
  // Guard the guard: if the scan matched nothing, the paths are wrong, not clean.
  assert.ok(matched >= 4, `scanner found only ${matched} wallet-svc call sites — paths likely broken`);
  assert.deepEqual(violations, [], `unauthenticated wallet-svc caller(s):\n${violations.join('\n')}`);
});
