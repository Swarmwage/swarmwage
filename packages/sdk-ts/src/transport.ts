// Swarmwage Agent SDK — HTTP transport
// Thin wrapper around fetch. The x402 dance (402 challenge → signed
// authorization → retry → settle) is delegated to `x402-fetch`'s
// `wrapFetchWithPayment`, which the AgentClient injects as `paidFetch`.
// License: MIT

import { SwarmwageError, TransportError } from "./errors.js";
import { SWARMWAGE_FACILITATOR_HEADER } from "./facilitator.js";
import { PROTOCOL_VERSION, type Hex } from "./types.js";

export interface TransportOptions {
  baseUrl?: string;
  /** Additional headers attached to every request. */
  headers?: Record<string, string>;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /**
   * fetch implementation that handles the x402 payment dance automatically
   * (typically `wrapFetchWithPayment(fetch, walletClient)` from `x402-fetch`).
   * Used only when the caller passes `paid: true`.
   */
  paidFetch?: typeof fetch;
  /**
   * Facilitator URL advertised to the seller via the
   * `X-Swarmwage-Facilitator` header on every request. Sellers that
   * recognize the header MAY route x402 `verify`/`settle` to this URL; the
   * value is advisory only. `null` disables the header (the seller falls
   * back to its own facilitator).
   */
  facilitatorUrl?: string | null;
}

export class Transport {
  constructor(private readonly opts: TransportOptions = {}) {}

  async json<T>(
    path: string,
    init?: RequestInit & {
      paid?: boolean;
      /**
       * Per-call override for the paid fetcher. When `paid: true`, this takes
       * precedence over the constructor's default `paidFetch`. Used by
       * `AgentClient.hire` to inject a per-hire `wrapFetchWithPayment` whose
       * `paymentRequirementsSelector` validates the seller's `payTo`.
       */
      paidFetch?: typeof fetch;
      /**
       * Called with the raw Response before the body is decoded. Use to read
       * response headers (e.g. `X-PAYMENT-RESPONSE` for x402 settlement info).
       * MUST NOT consume the body.
       */
      onResponse?: (res: Response) => void;
    },
  ): Promise<T> {
    const url = path.startsWith("http")
      ? path
      : `${this.opts.baseUrl ?? "https://api.swarmwage.com"}${path}`;

    const headers = new Headers(init?.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    headers.set("X-Swarmwage-Protocol", PROTOCOL_VERSION);
    if (this.opts.facilitatorUrl) {
      headers.set(SWARMWAGE_FACILITATOR_HEADER, this.opts.facilitatorUrl);
    }
    for (const [k, v] of Object.entries(this.opts.headers ?? {})) {
      if (!headers.has(k)) headers.set(k, v);
    }

    const fetcher = init?.paid
      ? init?.paidFetch ?? this.opts.paidFetch ?? globalThis.fetch
      : globalThis.fetch;

    const res = await fetchWithTimeout(
      url,
      { ...init, headers },
      this.opts.timeoutMs,
      fetcher,
    );
    init?.onResponse?.(res);
    return decode<T>(res);
  }
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
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    // Let SwarmwageError subclasses (e.g. SellerMismatchError thrown by the
    // x402 selector) propagate unwrapped — they carry intent the caller
    // needs to distinguish from a generic network error.
    if (err instanceof SwarmwageError) throw err;
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
