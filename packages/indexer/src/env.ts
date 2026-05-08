// Swarmwage Indexer — environment loader (zod-validated)
// License: BUSL-1.1

import { z } from "zod";

const NetworkSchema = z.enum(["base", "base-sepolia"]);
export type IndexerNetwork = z.infer<typeof NetworkSchema>;

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3002))
    .pipe(z.number().int().positive()),
  NETWORK: NetworkSchema.default("base-sepolia"),
  RPC_URL: z.string().url().optional(),
  REGISTRY_URL: z.string().url().default("http://localhost:3010"),
  START_BLOCK: z
    .string()
    .optional()
    .transform((v) => (v ? BigInt(v) : undefined))
    .pipe(z.bigint().nonnegative().optional()),
  INDEX_INTERVAL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 60))
    .pipe(z.number().int().positive()),
  MAX_BLOCK_RANGE: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 2000))
    .pipe(z.number().int().positive()),
  CONFIRMATION_DEPTH: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 1))
    .pipe(z.number().int().nonnegative()),
  DATABASE_URL: z.string().url().optional(),
  LOG_LEVEL: LogLevelSchema.default("info"),
});

export type IndexerEnv = {
  port: number;
  network: IndexerNetwork;
  rpcUrl: string | undefined;
  registryUrl: string;
  startBlock: bigint | undefined;
  indexIntervalSeconds: number;
  maxBlockRange: number;
  confirmationDepth: number;
  databaseUrl: string | undefined;
  logLevel: LogLevel;
};

/**
 * Parse and validate environment variables. Throws a descriptive error if a
 * required variable is missing or malformed. Call once at boot.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): IndexerEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Swarmwage Indexer — invalid environment configuration:\n${issues}\n` +
        `See packages/indexer/.env.example for the expected variables.`,
    );
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    network: e.NETWORK,
    rpcUrl: e.RPC_URL,
    registryUrl: e.REGISTRY_URL,
    startBlock: e.START_BLOCK,
    indexIntervalSeconds: e.INDEX_INTERVAL_SECONDS,
    maxBlockRange: e.MAX_BLOCK_RANGE,
    confirmationDepth: e.CONFIRMATION_DEPTH,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
  };
}
