// Swarmwage Agent SDK — HTTP transport
// Thin wrapper around fetch with x402 payment retry semantics.
// License: MIT

import { TransportError, PaymentFailedError } from "./errors.js";
import { PROTOCOL_VERSION, type Hex } from "./types.js";

export interface TransportOptions {
  baseUrl?: string;
  /** Additional headers attached to every request. */
  headers?: Record<string, string>;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export interface PaymentSigner {
  /**
   * Sign and produce an x402 payment authorization given the challenge headers.
   * Returns the value to put in the `X-PAYMENT` header on retry.
   */
  signPayment: (challenge: X402Challenge) => Promise<string>;
}

export interface X402Challenge {
  network: string;
  address: string;
  amount: string;
  capability_hash?: string;
}

export class Transport {
  constructor(private readonly opts: TransportOptions = {}) {}

  async json<T>(
    path: string,
    init?: RequestInit & { paymentSigner?: PaymentSigner },
  ): Promise<T> {
    const url = path.startsWith("http")
      ? path
      : `${this.opts.baseUrl ?? "https://api.swarmwage.com"}${path}`;

    const headers = new Headers(init?.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    headers.set("X-Swarmwage-Protocol", PROTOCOL_VERSION);
    for (const [k, v] of Object.entries(this.opts.headers ?? {})) {
      if (!headers.has(k)) headers.set(k, v);
    }

    const res = await fetchWithTimeout(url, { ...init, headers }, this.opts.timeoutMs);

    // x402 payment dance — only run if a signer is provided
    if (res.status === 402 && init?.paymentSigner) {
      const challenge = parseX402Challenge(res);
      const auth = await init.paymentSigner.signPayment(challenge);
      const retryHeaders = new Headers(headers);
      retryHeaders.set("X-PAYMENT", auth);

      const retry = await fetchWithTimeout(
        url,
        { ...init, headers: retryHeaders },
        this.opts.timeoutMs,
      );
      return decode<T>(retry);
    }

    return decode<T>(res);
  }
}

function parseX402Challenge(res: Response): X402Challenge {
  const network = res.headers.get("X-402-Network");
  const address = res.headers.get("X-402-Address");
  const amount = res.headers.get("X-402-Amount");
  if (!network || !address || !amount) {
    throw new PaymentFailedError("Malformed x402 challenge headers");
  }
  return {
    network,
    address,
    amount,
    capability_hash: res.headers.get("X-402-Capability-Hash") ?? undefined,
  };
}

async function decode<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TransportError(
      `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new TransportError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new TransportError(`Network error: ${(err as Error).message}`, undefined, err);
  } finally {
    clearTimeout(timer);
  }
}

// Re-exports kept narrow on purpose.
export type { Hex };
