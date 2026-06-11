// Swarmwage Registry — POST /v1/receipts (Layer 3 — seller-submitted)
// License: BUSL-1.1

import type { Context } from "hono";
import { z } from "zod";

import type { AgentId, CapabilityId, Hex } from "@swarmwage/agent-sdk";

import type { ReceiptRecord, RegistryStore } from "../store/types.js";
import { verifyTypedPayload } from "../auth.js";
import { invalidJsonResponse, readJsonBody } from "../http.js";
import type { WebhookDispatcher } from "../webhooks.js";

const ReceiptSchema = z.object({
  protocol_version: z.string().min(1),
  hire_id: z.string().min(1).max(128),
  agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  buyer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  capability: z.string().min(1),
  capability_version: z.string().optional(),
  amount_usdc_atomic: z.string().regex(/^\d+$/),
  network: z.enum(["base", "base-sepolia"]),
  tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  completed_at: z
    .string()
    .refine(
      (s) => !Number.isNaN(Date.parse(s)),
      "completed_at must be a valid ISO 8601 timestamp",
    ),
  verification: z.object({
    all_passed: z.boolean(),
    checks: z.record(z.boolean()),
  }),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SubmitReceiptDeps {
  store: RegistryStore;
  webhookDispatcher: WebhookDispatcher | undefined;
}

// Receipts — Layer 3 of the 4-layer data capture model.
//
// TRUST MODEL (v0.3, Day-7 launch posture):
// The receipt's seller signature is verified, but the registry does NOT
// currently cross-check `tx_hash` / `amount_usdc_atomic` against indexed
// on-chain Transfer events. A malicious seller could submit signed
// receipts for transactions they did not receive. This is acceptable for
// bootstrap because reputation is a network signal — sellers caught
// submitting fake receipts forfeit it.
//
// PLANNED (Phase 1.4): a reconciliation job that reads `transactions`
// (L2, indexed) and flags receipts whose tx_hash is not present, whose
// recipient differs from `agent_id`, or whose value mismatches
// `amount_usdc_atomic`. Receipts so flagged are excluded from public
// reputation aggregates. See SPEC.md §10 for the full trust model.
export function createSubmitReceiptHandler(deps: SubmitReceiptDeps) {
  const { store, webhookDispatcher } = deps;
  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    }
    const parsed = ReceiptSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: "Invalid receipt", issues: parsed.error.issues },
        400,
      );
    }

    // Self-hire / wash-trading block: a seller may not submit a receipt
    // claiming they served themselves. Otherwise a single wallet could
    // inflate its own last_30d_hire_count and reputation by hiring itself
    // (transferWithAuthorization buyer→seller with the same address is a
    // no-op on the USDC contract — zero economic cost, full reputation gain).
    if (
      parsed.data.agent_id.toLowerCase() === parsed.data.buyer.toLowerCase()
    ) {
      return c.json(
        {
          ok: false,
          error: "Self-hire is not allowed: buyer and agent_id must differ",
        },
        400,
      );
    }

    const completedAtMs = Date.parse(parsed.data.completed_at);
    const ageMs = Date.now() - completedAtMs;
    if (ageMs > RECEIPT_MAX_AGE_MS) {
      return c.json(
        { ok: false, error: "Receipt completed_at is older than 24h" },
        400,
      );
    }
    if (ageMs < -5 * 60 * 1000) {
      return c.json(
        { ok: false, error: "Receipt completed_at is in the future" },
        400,
      );
    }

    const { signature, verification, ...rest } = parsed.data;

    // Canonical payload mirrors `wallet.signTypedPayload` in @swarmwage/agent-sdk
    // and the existing `/v1/listings` verification path: alphabetical keys,
    // signature excluded.
    const canonicalPayload = {
      ...rest,
      verification,
    };

    const signerAddr = parsed.data.agent_id as `0x${string}`;
    const valid = await verifyTypedPayload(
      signerAddr,
      canonicalPayload,
      signature as Hex,
    );
    if (!valid) {
      return c.json({ ok: false, error: "Invalid signature" }, 401);
    }

    // Auto-upsert: a brand-new seller may submit their first receipt before
    // any listing has been published. The signature gate above is the
    // authoritative ownership check.
    await store.upsertAgent(signerAddr.toLowerCase() as AgentId);

    const record: ReceiptRecord = {
      protocol_version: parsed.data.protocol_version,
      hire_id: parsed.data.hire_id,
      agent_id: signerAddr.toLowerCase() as AgentId,
      buyer: parsed.data.buyer.toLowerCase() as AgentId,
      capability: parsed.data.capability as CapabilityId,
      capability_version: parsed.data.capability_version,
      amount_usdc_atomic: parsed.data.amount_usdc_atomic,
      network: parsed.data.network,
      tx_hash: parsed.data.tx_hash as `0x${string}`,
      completed_at: parsed.data.completed_at,
      verification_all_passed: verification.all_passed,
      verification_checks: verification.checks,
      signature: signature as `0x${string}`,
    };

    const result = await store.appendReceipt(record);
    if (!result.inserted) {
      return c.json(
        { ok: false, error: "duplicate_hire_id", receipt_id: result.id },
        409,
      );
    }

    // Mirror the receipt into the `hires` table so the `reputation` view
    // (which reads from `hires`, not `receipts`) credits this hire. The
    // indexer was originally supposed to populate `hires` from on-chain
    // USDC transfers, but in practice it does not — keeping the two
    // tables in sync at receipt-submission time is the simpler invariant.
    // Errors are swallowed: the receipt is the source of truth, and a
    // follow-up backfill (`migrations/001_backfill_hires_from_receipts.sql`)
    // can reconcile if this call fails transiently.
    try {
      const priceUsdc = (
        Number(record.amount_usdc_atomic) / 1_000_000
      ).toString();
      await store.recordHire({
        receipt_id: result.id,
        buyer_id: record.buyer,
        seller_id: record.agent_id,
        capability: record.capability,
        tx_hash: record.tx_hash,
        price_paid_usdc: priceUsdc,
        verification_passed: record.verification_all_passed,
        latency_ms: undefined,
        completed_at: completedAtMs,
      });
    } catch (err) {
      console.warn(
        "[receipts] recordHire mirror failed (receipt persisted):",
        err instanceof Error ? err.message : err,
      );
    }

    // Notify configured webhook receivers. Fire-and-forget — the receipt
    // submitter does not wait on receiver latency, and receiver failures
    // do not propagate. Receivers verify integrity via X-Webhook-Signature.
    if (webhookDispatcher?.enabled()) {
      webhookDispatcher.fire({
        event: "receipt.created",
        receipt_id: result.id,
        protocol_version: record.protocol_version,
        hire_id: record.hire_id,
        agent_id: record.agent_id,
        buyer: record.buyer,
        capability: record.capability,
        capability_version: record.capability_version,
        amount_usdc_atomic: record.amount_usdc_atomic,
        network: record.network,
        tx_hash: record.tx_hash,
        completed_at: record.completed_at,
        verification_all_passed: record.verification_all_passed,
      });
    }

    return c.json({ ok: true, receipt_id: result.id });
  };
}
