// Swarmwage Facilitator — environment loader (zod-validated)
// License: BUSL-1.1

import { z } from "zod";

const NetworkSchema = z.enum(["base", "base-sepolia"]);
export type FacilitatorNetwork = z.infer<typeof NetworkSchema>;

const HexPrivateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte hex string");

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// Wei amount as a decimal string. Accepts the literal "0" (disables the
// guard for that dimension) plus any positive integer. Returned as bigint
// because USDC + ETH amounts overflow JS Number above 2^53.
const WeiAmountSchema = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer in wei (decimal string)")
  .transform((v) => BigInt(v));

// Defaults sized for a Day-7 mainnet bankroll. Operators can raise or
// lower via env. The hourly cap defaults are intentionally generous
// relative to expected legitimate traffic — the goal is to bound the
// worst-case loss, not to throttle normal use.
//
// Reference for sizing: a typical USDC.transferWithAuthorization on
// Base costs ~75–100k gas. At 0.1 gwei (Base typical) a single settle
// burns ~10^13 wei. The reserve default below leaves ~500 settles of
// headroom above the floor — enough lead time for an operator to
// receive a low-balance alert and top-up before the kill-switch trips.
// The hourly cap allows ~2,000 settles before refusal.
const DEFAULT_MIN_GAS_RESERVE_WEI = 5_000_000_000_000_000n; // 0.005 ETH
const DEFAULT_MAX_GAS_PER_HOUR_WEI = 20_000_000_000_000_000n; // 0.02 ETH

// Comma-separated list of IPs whose `X-Forwarded-For` / `X-Real-IP`
// headers the rate limiter is allowed to trust. Empty (the default)
// means the limiter keys exclusively on the raw socket address — the
// safe posture when the facilitator is exposed directly without a
// reverse proxy. Production deploys behind Caddy on loopback should
// set `FACILITATOR_TRUSTED_PROXIES=127.0.0.1,::1`. See GH issue #7.
const TrustedProxiesSchema = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return new Set<string>();
    const entries = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return new Set<string>(entries);
  });

const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3001))
    .pipe(z.number().int().positive()),
  NETWORK: NetworkSchema.default("base-sepolia"),
  RPC_URL: z.string().url().optional(),
  FACILITATOR_GAS_PRIVATE_KEY: HexPrivateKeySchema,
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: LogLevelSchema.default("info"),
  MIN_GAS_RESERVE_WEI: WeiAmountSchema.optional(),
  MAX_GAS_PER_HOUR_WEI: WeiAmountSchema.optional(),
  FACILITATOR_TRUSTED_PROXIES: TrustedProxiesSchema,
});

export type FacilitatorEnv = {
  port: number;
  network: FacilitatorNetwork;
  rpcUrl: string | undefined;
  gasPrivateKey: `0x${string}`;
  databaseUrl: string | undefined;
  logLevel: LogLevel;
  minGasReserveWei: bigint;
  maxGasPerHourWei: bigint;
  trustedProxies: ReadonlySet<string>;
};

/**
 * Parse and validate environment variables. Throws a descriptive error if a
 * required variable is missing or malformed. Call once at boot.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): FacilitatorEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Swarmwage Facilitator — invalid environment configuration:\n${issues}\n` +
        `See packages/facilitator/.env.example for the expected variables.`,
    );
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    network: e.NETWORK,
    rpcUrl: e.RPC_URL,
    gasPrivateKey: e.FACILITATOR_GAS_PRIVATE_KEY as `0x${string}`,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    minGasReserveWei: e.MIN_GAS_RESERVE_WEI ?? DEFAULT_MIN_GAS_RESERVE_WEI,
    maxGasPerHourWei: e.MAX_GAS_PER_HOUR_WEI ?? DEFAULT_MAX_GAS_PER_HOUR_WEI,
    trustedProxies: e.FACILITATOR_TRUSTED_PROXIES,
  };
}
