// Swarmwage Facilitator — request / response types aligned with x402 v1
// License: BUSL-1.1
//
// We re-use the canonical zod schemas published by the upstream `x402`
// package (v1.2.x). Doing so guarantees that any client built on the x402
// SDK — Coinbase reference clients, downstream third parties, our own
// `@swarmwage/agent-sdk` — can talk to this facilitator without protocol
// drift. If the upstream schemas evolve, we follow them.

import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  SettleResponseSchema,
  SupportedPaymentKindsResponseSchema,
  VerifyResponseSchema,
  x402Versions,
} from "x402/types";
import { z } from "zod";

export {
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  SettleResponseSchema,
  SupportedPaymentKindsResponseSchema,
  VerifyResponseSchema,
  x402Versions,
};

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

/**
 * Body of `POST /verify` and `POST /settle` per the x402 facilitator spec.
 */
export const FacilitatorRequestBodySchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});

export type FacilitatorRequestBody = z.infer<
  typeof FacilitatorRequestBodySchema
>;
