// Swarmwage Registry — canonical hub
// License: BUSL-1.1
//
// Exposes the protocol endpoints for search, listings, rating, reputation,
// receipts, claim, and telemetry. v0.0.1 ships an in-memory store;
// production swaps in Supabase.

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { PostgresStore } from "./store/postgres.js";
import type { RegistryStore } from "./store/types.js";
import { parseReceiverUrls, WebhookDispatcher } from "./webhooks.js";

// Skip starting the HTTP server when imported as a library (tests). The
// `start` and `dev` package scripts run via tsx without setting this flag,
// so production behavior is unchanged.
const shouldListen = process.env.SWARMWAGE_REGISTRY_NO_LISTEN !== "1";

const env = loadEnv();
const store: RegistryStore | undefined = env.databaseUrl
  ? new PostgresStore({ connectionString: env.databaseUrl })
  : undefined;
const storeKind: "memory" | "postgres" = env.databaseUrl ? "postgres" : "memory";

const webhookReceivers = parseReceiverUrls(env.receiptWebhookUrls);
const webhookDispatcher =
  webhookReceivers.length > 0 && env.receiptWebhookSecret
    ? new WebhookDispatcher({
        receivers: webhookReceivers,
        secret: env.receiptWebhookSecret,
      })
    : undefined;

const { app } = createApp({ store, webhookDispatcher });

if (shouldListen) {
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    const hooks = webhookDispatcher?.enabled()
      ? ` webhooks=${webhookReceivers.length}`
      : "";
    process.stderr.write(
      `swarmwage-registry v0.0.1 listening on http://localhost:${info.port} (store=${storeKind})${hooks}\n`,
    );
  });
}

export { app };
export { createApp } from "./app.js";
