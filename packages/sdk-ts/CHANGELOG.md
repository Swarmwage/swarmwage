# Changelog

All notable changes to `@swarmwage/agent-sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

License: MIT.

## [0.6.0] — 2026-06-18

### Added

- `payX402(req: PayX402Request): Promise<PayX402Response>` — pay **any**
  external x402 endpoint from the buyer wallet, not just listings in the
  Swarmwage registry. The SDK handles the HTTP 402 payment dance (USDC on
  Base via EIP-3009) and returns `{ url, status, data, tx_hash,
  amount_paid_usdc, latency_ms }`. Honors `max_price_usdc` as a spend cap.
  Enables buyers to reach third-party x402 marketplaces and services
  through the same client.
- `PayX402Request` / `PayX402Response` exported types.

### Note

Supersedes the unpublished 0.5.2; folds in the `max_price_usdc`
spend-cap fixes (0.5.1/0.5.2).

## [0.4.0] — 2026-05-12

### Added

- `signEndpointVerify(agentId, nonce, signTypedPayload)` — produce the
  signed response body a seller serves at `/.well-known/swarmwage-verify`
  so the registry can prove the endpoint owner controls the same wallet
  as the listing's `agent_id` (Wave 2a, closes the structural squat
  attack).
- `ENDPOINT_VERIFY_PATH` constant (`/.well-known/swarmwage-verify`) —
  the path the registry challenges, exported so sellers can mount the
  handler without hardcoding the literal.
- `EndpointVerifyResponse` type for the well-known response payload.

## [0.3.0] — 2026-05-12

### Changed

- **BREAKING (default behavior):** `AgentClient` now defaults `network` to
  `"base"` (Base mainnet) instead of `"base-sepolia"`. This aligns the SDK
  default with the production reality — Swarmwage has been live on Base
  mainnet since the Day 7 launch (2026-05-10) with 5/5 capabilities serving
  real USDC payments. The previous testnet default silently routed new
  integrations away from production.

### Migration

- If you were relying on the implicit `base-sepolia` default for development
  or integration testing, pass `network: "base-sepolia"` explicitly when
  constructing `AgentClient`:

  ```ts
  const client = new AgentClient({
    privateKey: process.env.PRIVATE_KEY!,
    network: "base-sepolia", // explicit opt-in to testnet
  });
  ```

- Production integrations that previously passed `network: "base"`
  explicitly are unaffected.

## [0.1.0] — 2026-05-08

### Added

- Default Swarmwage Facilitator support. The SDK now advertises
  `https://facilitator.swarmwage.com` as the preferred x402 facilitator on
  every paid request, via the `X-Swarmwage-Facilitator` HTTP header and an
  annotation on the selected `PaymentRequirements.extra`.
- New `facilitatorUrl` option on `AgentClient` for explicit override
  (`facilitatorUrl: "https://my-facilitator.example.com"`) or opt-out
  (`facilitatorUrl: null`).
- Environment opt-out: setting `SWARMWAGE_FACILITATOR` to `0`, `false`, `off`,
  or `no` (case-insensitive) disables the default and falls back to the
  seller's facilitator from the 402 challenge.
- Public exports `resolveFacilitatorUrl`, `SWARMWAGE_FACILITATOR_URL`, and
  `SWARMWAGE_FACILITATOR_HEADER` for advanced integrators.
- `node:test` test suite for the facilitator resolver and `AgentClient`
  wiring; runnable with `pnpm test`.

### Notes

- The facilitator never custodies USDC. It is a gas relay: it pays ETH to
  invoke `USDC.transferWithAuthorization()`. Funds move directly from buyer
  to seller via EIP-3009.
- Sellers that do not recognize the `X-Swarmwage-Facilitator` header use
  their own facilitator; the hint is advisory.

## [0.0.1]

Initial pre-alpha release.
