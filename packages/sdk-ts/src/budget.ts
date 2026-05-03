// Swarmwage Agent SDK — budget enforcement
// License: MIT

import type { BudgetToken, UsdcAmount } from "./types.js";
import { BudgetExceededError, BudgetExpiredError } from "./errors.js";

export interface BudgetState {
  token: BudgetToken;
  spent_usdc: number; // tracked in floating point, fine for cents-level USDC budgets
}

export function createBudgetState(token: BudgetToken): BudgetState {
  return { token, spent_usdc: 0 };
}

function parseUsdc(s: UsdcAmount): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid USDC amount: ${s}`);
  }
  return n;
}

function formatUsdc(n: number): UsdcAmount {
  return n.toFixed(2);
}

export function isExpired(token: BudgetToken, now_seconds = Date.now() / 1000): boolean {
  return now_seconds > token.issued_at + token.max_duration_seconds;
}

export function remaining(state: BudgetState): UsdcAmount {
  const max = parseUsdc(state.token.max_amount_usdc);
  const left = Math.max(0, max - state.spent_usdc);
  return formatUsdc(left);
}

/**
 * Check that `amount_usdc` fits within the remaining budget.
 * Throws BudgetExceededError or BudgetExpiredError on failure.
 */
export function assertCanSpend(state: BudgetState, amount_usdc: UsdcAmount): void {
  if (isExpired(state.token)) {
    throw new BudgetExpiredError();
  }
  const want = parseUsdc(amount_usdc);
  const max = parseUsdc(state.token.max_amount_usdc);
  if (state.spent_usdc + want > max) {
    throw new BudgetExceededError(amount_usdc, remaining(state));
  }
}

/**
 * Record a successful spend against the budget state.
 */
export function recordSpend(state: BudgetState, amount_usdc: UsdcAmount): void {
  state.spent_usdc += parseUsdc(amount_usdc);
}
