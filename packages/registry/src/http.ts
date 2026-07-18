// Swarmwage Registry — shared HTTP helpers
// License: BUSL-1.1

import type { Context } from "hono";

/**
 * Parse the request body as JSON without letting a malformed body escape as
 * an unhandled throw (which Hono surfaces as HTTP 500). Returns the parsed
 * body, or `undefined` when the body is not valid JSON — callers respond
 * with a 400 in that case.
 */
export async function readJsonBody(c: Context): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** The uniform 400 response for a body that failed `readJsonBody`. */
export function invalidJsonResponse(c: Context): Response {
  return c.json({ error: "Invalid JSON body" }, 400);
}
