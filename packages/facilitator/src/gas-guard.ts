// Swarmwage Facilitator — gas budget kill-switch
// License: BUSL-1.1
//
// Defends the gas bankroll against drain attacks that bypass the per-IP
// and per-buyer-address rate limiters. Two independent guards:
//
//   1. Reserve floor — refuse /settle when the gas wallet balance has
//      fallen below MIN_GAS_RESERVE_WEI. Prevents the wallet from being
//      drained to zero in the operator's absence; the operator must
//      top-up before service resumes. Backstop for the "many distinct
//      buyer addresses, each well within the address rate limit" attack.
//
//   2. Hourly spend cap — refuse /settle when total gas spent in the
//      trailing hour has exceeded MAX_GAS_PER_HOUR_WEI. Caps the
//      worst-case bankroll loss per hour at a fixed amount. Bounds the
//      blast radius of any unforeseen vulnerability that lets an
//      adversary turn auth submission into gas burn.
//
// State is in-memory and per-process. Multi-replica deployments behind
// a load balancer experience an effective cap of `cap × replicas`
// — acceptable at Day-7 scale, swap for a Redis/Postgres-backed counter
// when traffic justifies it. Both guards err on the side of refusal:
// false positives cost a 503 to a buyer; false negatives drain real
// money.

export interface GasGuardOptions {
  /** Refuse /settle when gas wallet balance falls below this many wei. */
  minReserveWei: bigint;
  /** Refuse /settle when trailing-hour spend exceeds this many wei. */
  maxPerHourWei: bigint;
  /** Sliding window length in milliseconds. Defaults to 1 hour. */
  windowMs?: number;
}

export type ReserveDecision =
  | { allowed: true }
  | { allowed: false; minReserveWei: bigint; balanceWei: bigint };

export type HourlyDecision =
  | { allowed: true; spentWei: bigint; capWei: bigint }
  | {
      allowed: false;
      spentWei: bigint;
      capWei: bigint;
      retryAfterSec: number;
    };

interface SpendEvent {
  ts: number;
  gasWei: bigint;
}

export class GasGuard {
  private readonly minReserveWei: bigint;
  private readonly maxPerHourWei: bigint;
  private readonly windowMs: number;
  private readonly events: SpendEvent[] = [];

  constructor(opts: GasGuardOptions) {
    if (opts.minReserveWei < 0n) {
      throw new Error("GasGuard: minReserveWei must be non-negative");
    }
    if (opts.maxPerHourWei < 0n) {
      throw new Error("GasGuard: maxPerHourWei must be non-negative");
    }
    const windowMs = opts.windowMs ?? 3_600_000;
    if (windowMs < 1 || !Number.isFinite(windowMs)) {
      throw new Error("GasGuard: windowMs must be a positive integer");
    }
    this.minReserveWei = opts.minReserveWei;
    this.maxPerHourWei = opts.maxPerHourWei;
    this.windowMs = Math.floor(windowMs);
  }

  /**
   * Sync. Decides whether the trailing-hour spend allowance is exhausted.
   * Call BEFORE the balance RPC so that an exhausted bankroll short-circuits
   * without an extra round-trip. A cap of 0n disables the guard.
   */
  hourlyAllowance(): HourlyDecision {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.pruneOlderThan(cutoff);

    let spentWei = 0n;
    for (const ev of this.events) {
      spentWei += ev.gasWei;
    }

    // capWei === 0n means the operator has explicitly disabled the cap.
    if (this.maxPerHourWei === 0n || spentWei < this.maxPerHourWei) {
      return { allowed: true, spentWei, capWei: this.maxPerHourWei };
    }

    // Suggest the time until the oldest event in the window falls out.
    // This is a lower bound on when the cap will free up — actual
    // recovery depends on whether subsequent settles add new spend.
    const oldest = this.events[0];
    const retryAfterMs = oldest
      ? Math.max(1_000, oldest.ts + this.windowMs - now)
      : 60_000;
    return {
      allowed: false,
      spentWei,
      capWei: this.maxPerHourWei,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
    };
  }

  /**
   * Sync. Decides whether the gas wallet balance is above the reserve
   * floor. Call AFTER the balance RPC. Reserve breach is a hard stop:
   * the operator must top-up the wallet before service resumes.
   */
  reserveCheck(currentBalanceWei: bigint): ReserveDecision {
    if (currentBalanceWei >= this.minReserveWei) {
      return { allowed: true };
    }
    return {
      allowed: false,
      minReserveWei: this.minReserveWei,
      balanceWei: currentBalanceWei,
    };
  }

  /**
   * Record a confirmed gas spend. Invoke after every broadcast that
   * burned gas — both successful settlements AND on-chain reverts —
   * because both consume real ETH from the bankroll.
   */
  record(gasWei: bigint): void {
    if (gasWei <= 0n) return;
    this.events.push({ ts: Date.now(), gasWei });
  }

  /** Trailing-hour spend in wei. Test-only / observability. */
  currentSpendWei(): bigint {
    const cutoff = Date.now() - this.windowMs;
    let total = 0n;
    for (const ev of this.events) {
      if (ev.ts > cutoff) total += ev.gasWei;
    }
    return total;
  }

  /** Number of spend events currently tracked. Test-only. */
  size(): number {
    return this.events.length;
  }

  /** Prune events whose timestamps are at or before the cutoff. */
  private pruneOlderThan(cutoff: number): void {
    while (this.events.length > 0 && this.events[0]!.ts <= cutoff) {
      this.events.shift();
    }
  }
}
