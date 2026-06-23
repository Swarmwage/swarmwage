// Swarmwage Agent SDK — public exports
// Protocol: swarmwage/v0.1
// License: MIT
//
// Spec: https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md

export { AgentClient, type AgentClientOptions } from "./client.js";
export { createWallet, type AgentWallet, type WalletConfig } from "./wallet.js";
export { canonicalize, CanonicalizationError } from "./canonical.js";
export {
  createBudgetState,
  assertCanSpend,
  recordSpend,
  isExpired as isBudgetExpired,
  remaining as remainingBudget,
  type BudgetState,
} from "./budget.js";
export { verify, registerVerifier, getVerifier, type Verifier } from "./verification.js";
export { createTelemetry, DEFAULT_TELEMETRY_URL } from "./telemetry.js";
export {
  submitReceipt,
  signReceipt,
  isReceiptsEnabled,
  DEFAULT_REGISTRY_URL,
  type ReceiptPayload,
  type ReceiptNetwork,
  type SubmitReceiptOptions,
  type SubmitReceiptResult,
} from "./receipts.js";
export {
  resolveFacilitatorUrl,
  SWARMWAGE_FACILITATOR_URL,
  SWARMWAGE_FACILITATOR_HEADER,
  type FacilitatorResolverInput,
} from "./facilitator.js";
export {
  ENDPOINT_VERIFY_PATH,
  signEndpointVerify,
  type EndpointVerifyResponse,
} from "./endpoint-verify.js";

export {
  PROTOCOL_VERSION,
  type ProtocolVersion,
  type AgentId,
  type CapabilityId,
  type UsdcAmount,
  type Hex,
  type Listing,
  type Reputation,
  type SearchRequest,
  type SearchResponse,
  type SearchResultEntry,
  type BudgetToken,
  type HireRequest,
  type HireResponse,
  type AsyncHireResponse,
  type JobStatus,
  type PayX402Request,
  type PayX402Response,
  type Receipt,
  type RatingRequest,
  type Stars,
  type SubmittedReceipt,
  type VerificationCheck,
  type VerificationResult,
} from "./types.js";

export {
  SwarmwageError,
  TransportError,
  BudgetExceededError,
  BudgetExpiredError,
  VerificationFailedError,
  HireRefusedError,
  InvalidProtocolVersionError,
  PaymentFailedError,
  InsufficientFundsError,
  SellerMismatchError,
} from "./errors.js";
