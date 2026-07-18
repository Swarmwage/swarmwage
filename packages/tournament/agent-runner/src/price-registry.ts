// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// In-process record of THIS agent's published listing prices.
//
// The seller-side x402 paywall (see index.ts) must charge the *authoritative*
// price the agent advertised for a capability — never a price supplied by the
// buyer. Listings are published from two places (the compound bootstrap and
// the LLM's `publish_listing` tool) at runtime-chosen prices, so we cannot use
// a static route→price map. Instead, every successful publish records the
// price here, and the hire route reads it back when building the 402 challenge.

export interface ListedPrice {
  /** Decimal USDC string, e.g. "0.05". */
  price_usdc: string;
  first_call_free: boolean;
}

const prices = new Map<string, ListedPrice>();

/** Record (or overwrite) the price this agent advertises for `capability`. */
export function recordListedPrice(
  capability: string,
  price_usdc: string,
  first_call_free = false,
): void {
  prices.set(capability, { price_usdc, first_call_free });
}

/** Authoritative price for `capability`, or undefined if not currently listed. */
export function getListedPrice(capability: string): ListedPrice | undefined {
  return prices.get(capability);
}
