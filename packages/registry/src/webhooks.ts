// Swarmwage Registry — outbound webhook dispatcher
// License: BUSL-1.1
//
// Fires HMAC-signed POST requests to receivers configured via env when
// notable registry events occur. Today: `receipt.created` after a receipt
// is successfully persisted via POST /v1/receipts.
//
// Generic by design: any registry operator can plug a receiver (analytics
// pipeline, billing, internal dashboards, third-party indexer) without
// running their own follower. Best-effort: fire-and-forget, per-receiver
// timeout, never blocks the response to the receipt submitter, never
// throws into the caller.
//
// Wire format:
//   POST <receiver_url>
//   Content-Type: application/json
//   X-Webhook-Event: receipt.created
//   X-Webhook-Signature: sha256=<hex>   ← HMAC-SHA256 of the body with secret
//   X-Webhook-Timestamp: <unix ms>      ← optional replay protection
//
// Body is JSON. Receivers should verify the signature before processing.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookReceiver {
  url: string;
}

export interface WebhookDispatcherConfig {
  receivers: WebhookReceiver[];
  secret: string;
  timeoutMs?: number;
}

export interface ReceiptCreatedEvent {
  event: "receipt.created";
  receipt_id: string;
  protocol_version: string;
  hire_id: string;
  agent_id: string;
  /** Settled payment recipient when split from agent_id (GH #11). */
  payee?: string;
  buyer: string;
  capability: string;
  capability_version?: string;
  amount_usdc_atomic: string;
  network: "base" | "base-sepolia";
  tx_hash: `0x${string}`;
  completed_at: string;
  verification_all_passed: boolean;
}

export type WebhookEvent = ReceiptCreatedEvent;

export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string | undefined | null,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signWebhookBody(secret, body);
  if (expected.length !== signatureHeader.length) return false;
  return timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}

export class WebhookDispatcher {
  private readonly receivers: WebhookReceiver[];
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(config: WebhookDispatcherConfig) {
    this.receivers = config.receivers;
    this.secret = config.secret;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  enabled(): boolean {
    return this.receivers.length > 0;
  }

  /**
   * Fire-and-forget dispatch. Resolves immediately to the caller; the
   * underlying POSTs run in the background. Errors are logged, never
   * thrown. Use `dispatch()` if you need to await all receivers.
   */
  fire(event: WebhookEvent): void {
    if (!this.enabled()) return;
    void this.dispatch(event).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[webhook] unexpected dispatch error: ${msg}`);
    });
  }

  async dispatch(event: WebhookEvent): Promise<void> {
    if (!this.enabled()) return;
    const body = JSON.stringify(event);
    const signature = signWebhookBody(this.secret, body);
    const ts = Date.now().toString();

    await Promise.all(
      this.receivers.map((r) => this.deliver(r, body, signature, ts, event.event)),
    );
  }

  private async deliver(
    receiver: WebhookReceiver,
    body: string,
    signature: string,
    timestamp: string,
    eventName: string,
  ): Promise<void> {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(receiver.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": eventName,
          "X-Webhook-Signature": signature,
          "X-Webhook-Timestamp": timestamp,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(
          `[webhook] ${receiver.url} responded ${res.status} for ${eventName}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[webhook] ${receiver.url} failed for ${eventName}: ${msg}`);
    } finally {
      clearTimeout(handle);
    }
  }
}

export function parseReceiverUrls(raw: string | undefined): WebhookReceiver[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((url) => ({ url }));
}
