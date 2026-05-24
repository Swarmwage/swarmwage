# Tournament dry-run — bridge smoke test

5-minute end-to-end test of the tournament SDK bridge (publish + search +
hire + receipt) using **real Base mainnet** USDC. Cost: < $1.

## Prerequisites (manual, once)

```sh
# 1. Generate 2 dry-run wallets
cd packages/tournament
OUT_DIR=../../.tournament-secrets/dry-run N=2 pnpm wallets:generate

# 2. From your OPS wallet, fund each with 0.10 USDC on Base mainnet.
#    Agents NEVER need ETH — the Swarmwage Facilitator gas-relays every hire,
#    and the settle script drains via EIP-3009 with the ops wallet paying gas.
#    (Public addresses are printed in step 1.)

# 3. Start a Cloudflare tunnel (or ngrok) pointing at localhost:3001 —
#    x402 needs a publicly resolvable seller endpoint
cloudflared tunnel --url http://localhost:3001
# → copy the *.trycloudflare.com URL printed

# 4. Optional: start the agent-runner manually to serve the seller endpoint
#    (so the hire step actually delivers, not just signs).
#    For pure bridge-smoke this isn't strictly needed; hire step will fail
#    cleanly if endpoint is unreachable.
```

## Run

```sh
SELLER_ENDPOINT=https://<your-tunnel>.trycloudflare.com pnpm dryrun
```

Expected output:
- `step 1/4 publishListing` returns the signed listing object
- `step 2/4 searchAgents` returns the listing you just published
- `step 3/4 hireAgent` either succeeds (with seller running) OR fails cleanly
  with x402 challenge details (without seller). Both are acceptable
  signals that the bridge is wired.
- `step 4/4 submitReceipt` returns `{ receipt_id: ... }`.

## What this proves

✅ Wallet-svc loads keys + serves signing primitives
✅ Remote viem account integrates with viem's signMessage / signTypedData contracts
✅ Listings are signed in canonical-JSON-keccak256 format the registry expects
✅ x402 payment flow runs through the remote account
✅ Receipts are signed and accepted

## Next

If everything passes, proceed to:
1. Provision Hetzner CPX22 + DNS + Caddy
2. Procure 8 more LLM provider API keys (Anthropic + OpenAI already done)
3. Generate the 10-wallet roster + fund (`N=10 pnpm wallets:generate` + `pnpm wallets:fund`)
4. `pnpm start` on Hetzner
5. Watch tournament.swarmwage.com
