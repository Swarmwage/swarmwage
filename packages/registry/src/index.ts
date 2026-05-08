// Swarmwage Registry — canonical hub
// License: BUSL-1.1
//
// Exposes the protocol endpoints for search, listings, rating, reputation,
// receipts, claim, and telemetry. v0.0.1 ships an in-memory store;
// production swaps in Supabase.

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";

const { app } = createApp();

// Skip starting the HTTP server when imported as a library (tests). The
// `start` and `dev` package scripts run via tsx without setting this flag,
// so production behavior is unchanged.
if (process.env.SWARMWAGE_REGISTRY_NO_LISTEN !== "1") {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, (info) => {
    process.stderr.write(
      `swarmwage-registry v0.0.1 listening on http://localhost:${info.port}\n`,
    );
  });
}

export { app };
export { createApp } from "./app.js";
