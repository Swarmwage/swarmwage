// Swarmwage Registry — environment loader (zod-validated)
// License: BUSL-1.1

import { z } from "zod";

const EnvSchema = z
  .object({
    PORT: z
      .string()
      .optional()
      .transform((v) => (v ? Number.parseInt(v, 10) : 3000))
      .pipe(z.number().int().positive()),
    DATABASE_URL: z.string().url().optional(),
    // Comma-separated list of HTTPS endpoints to receive outbound webhook
    // notifications (e.g. `receipt.created`). Optional. When set, a non-empty
    // RECEIPT_WEBHOOK_SECRET is required for HMAC signing.
    RECEIPT_WEBHOOK_URLS: z.string().optional(),
    RECEIPT_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const hasUrls =
      typeof data.RECEIPT_WEBHOOK_URLS === "string" &&
      data.RECEIPT_WEBHOOK_URLS.trim().length > 0;
    const hasSecret =
      typeof data.RECEIPT_WEBHOOK_SECRET === "string" &&
      data.RECEIPT_WEBHOOK_SECRET.trim().length >= 16;
    if (hasUrls && !hasSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RECEIPT_WEBHOOK_SECRET"],
        message:
          "RECEIPT_WEBHOOK_SECRET (>=16 chars) is required when RECEIPT_WEBHOOK_URLS is set",
      });
    }
  });

export type RegistryEnv = {
  port: number;
  databaseUrl: string | undefined;
  receiptWebhookUrls: string | undefined;
  receiptWebhookSecret: string | undefined;
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
    receiptWebhookUrls: e.RECEIPT_WEBHOOK_URLS,
    receiptWebhookSecret: e.RECEIPT_WEBHOOK_SECRET,
  };
}
