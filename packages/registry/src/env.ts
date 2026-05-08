// Swarmwage Registry — environment loader (zod-validated)
// License: BUSL-1.1

import { z } from "zod";

const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3000))
    .pipe(z.number().int().positive()),
  DATABASE_URL: z.string().url().optional(),
});

export type RegistryEnv = {
  port: number;
  databaseUrl: string | undefined;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): RegistryEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Swarmwage Registry — invalid environment configuration:\n${issues}\n` +
        `See packages/registry/.env.example for the expected variables.`,
    );
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
  };
}
