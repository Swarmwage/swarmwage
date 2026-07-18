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
    // Endpoint ownership proof (Wave 2a). At publish time the registry
    // GETs `<endpoint>/.well-known/swarmwage-verify?nonce=N` and verifies
    // the signed response against the listing's agent_id. Modes:
    //   off     — skip (Wave 1+1.5 already in production, this is opt-in)
    //   soft    — challenge, log on failure, accept the listing anyway
    //   enforce — challenge, reject on failure (HTTP 400)
    // Default `off` so existing tests + the test memory-store don't try
    // to fetch from non-existent endpoints. Production should run `soft`
    // until all sellers report green, then flip to `enforce`.
    ENDPOINT_VERIFY_MODE: z
      .enum(["off", "soft", "enforce"])
      .optional()
      .default("off"),
    // Wall-clock timeout for the verify GET. Sellers behind Caddy + ACME
    // typically respond in <100ms; 5s is generous and covers cold-start.
    ENDPOINT_VERIFY_TIMEOUT_MS: z
      .string()
      .optional()
      .transform((v) => (v ? Number.parseInt(v, 10) : 5000))
      .pipe(z.number().int().positive()),
    // Comma-separated IPs whose X-Forwarded-For / X-Real-IP headers the
    // rate limiter may trust. Empty (default) ⇒ key on the raw socket peer
    // only — the safe posture when exposed directly. Behind Caddy on
    // loopback set `REGISTRY_TRUSTED_PROXIES=127.0.0.1,::1`. Same class as
    // facilitator GH#7: without this an attacker rotates XFF to defeat the
    // per-IP flood guard.
    REGISTRY_TRUSTED_PROXIES: z
      .string()
      .optional()
      .transform((v) => {
        if (!v) return new Set<string>();
        return new Set<string>(
          v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        );
      }),
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

export type EndpointVerifyMode = "off" | "soft" | "enforce";

export type RegistryEnv = {
  port: number;
  databaseUrl: string | undefined;
  receiptWebhookUrls: string | undefined;
  receiptWebhookSecret: string | undefined;
  endpointVerifyMode: EndpointVerifyMode;
  endpointVerifyTimeoutMs: number;
  trustedProxies: ReadonlySet<string>;
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
    endpointVerifyMode: e.ENDPOINT_VERIFY_MODE,
    endpointVerifyTimeoutMs: e.ENDPOINT_VERIFY_TIMEOUT_MS,
    trustedProxies: e.REGISTRY_TRUSTED_PROXIES,
  };
}
