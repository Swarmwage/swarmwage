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
});

export type FacilitatorEnv = {
  port: number;
  network: FacilitatorNetwork;
  rpcUrl: string | undefined;
  gasPrivateKey: `0x${string}`;
  databaseUrl: string | undefined;
  logLevel: LogLevel;
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
  };
}
