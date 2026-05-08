// Swarmwage Agent SDK — facilitator resolver tests
// License: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveFacilitatorUrl,
  SWARMWAGE_FACILITATOR_URL,
  SWARMWAGE_FACILITATOR_HEADER,
} from "../facilitator.js";
import { AgentClient } from "../client.js";

// 32-byte zero-prefixed key, used purely to instantiate the wallet client in
// memory. No network calls are issued in these tests.
const TEST_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

describe("resolveFacilitatorUrl", () => {
  it("returns the canonical default when config and env are unset", () => {
    assert.equal(resolveFacilitatorUrl({}, {}), SWARMWAGE_FACILITATOR_URL);
    assert.equal(SWARMWAGE_FACILITATOR_URL, "https://facilitator.swarmwage.com");
  });

  it("returns the default when config.facilitatorUrl is undefined", () => {
    assert.equal(
      resolveFacilitatorUrl({ facilitatorUrl: undefined }, {}),
      SWARMWAGE_FACILITATOR_URL,
    );
  });

  it("opts out when config.facilitatorUrl is null", () => {
    assert.equal(resolveFacilitatorUrl({ facilitatorUrl: null }, {}), null);
  });

  it("opts out via env SWARMWAGE_FACILITATOR=0", () => {
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "0" }),
      null,
    );
  });

  it("opts out via env SWARMWAGE_FACILITATOR=false (case-insensitive)", () => {
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "False" }),
      null,
    );
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "FALSE" }),
      null,
    );
  });

  it("opts out via env SWARMWAGE_FACILITATOR=off", () => {
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "off" }),
      null,
    );
  });

  it("opts out via env SWARMWAGE_FACILITATOR=no", () => {
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "no" }),
      null,
    );
  });

  it("trims whitespace before parsing the env opt-out marker", () => {
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "  0  " }),
      null,
    );
  });

  it("treats env values like '1' or 'true' as ON (returns default)", () => {
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "1" }),
      SWARMWAGE_FACILITATOR_URL,
    );
    assert.equal(
      resolveFacilitatorUrl({}, { SWARMWAGE_FACILITATOR: "true" }),
      SWARMWAGE_FACILITATOR_URL,
    );
  });

  it("uses a custom string config override verbatim", () => {
    const custom = "https://my-facilitator.example.com";
    assert.equal(
      resolveFacilitatorUrl({ facilitatorUrl: custom }, {}),
      custom,
    );
  });

  it("trims whitespace from a custom string override", () => {
    assert.equal(
      resolveFacilitatorUrl(
        { facilitatorUrl: "  https://x.example.com  " },
        {},
      ),
      "https://x.example.com",
    );
  });

  it("treats an empty/whitespace-only string as the default", () => {
    assert.equal(
      resolveFacilitatorUrl({ facilitatorUrl: "" }, {}),
      SWARMWAGE_FACILITATOR_URL,
    );
    assert.equal(
      resolveFacilitatorUrl({ facilitatorUrl: "   " }, {}),
      SWARMWAGE_FACILITATOR_URL,
    );
  });

  it("env opt-out wins over a custom string override", () => {
    // Documented precedence: env opt-out is the kill switch and takes
    // priority over any in-code configuration.
    assert.equal(
      resolveFacilitatorUrl(
        { facilitatorUrl: "https://custom.example.com" },
        { SWARMWAGE_FACILITATOR: "0" },
      ),
      null,
    );
  });

  it("config.facilitatorUrl=null wins even when env is set to 1", () => {
    assert.equal(
      resolveFacilitatorUrl(
        { facilitatorUrl: null },
        { SWARMWAGE_FACILITATOR: "1" },
      ),
      null,
    );
  });

  it("exposes the canonical header name", () => {
    assert.equal(SWARMWAGE_FACILITATOR_HEADER, "X-Swarmwage-Facilitator");
  });
});

describe("AgentClient — facilitator wiring", () => {
  it("defaults to the canonical Swarmwage facilitator URL", () => {
    // Snapshot+restore env var so this test is order-independent.
    const prev = process.env.SWARMWAGE_FACILITATOR;
    delete process.env.SWARMWAGE_FACILITATOR;
    try {
      const client = new AgentClient({ privateKey: TEST_PRIVATE_KEY });
      assert.equal(client.facilitatorUrl, SWARMWAGE_FACILITATOR_URL);
    } finally {
      if (prev !== undefined) process.env.SWARMWAGE_FACILITATOR = prev;
    }
  });

  it("opts out when constructed with facilitatorUrl: null", () => {
    const client = new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      facilitatorUrl: null,
    });
    assert.equal(client.facilitatorUrl, null);
  });

  it("uses a custom override when constructed with facilitatorUrl: <string>", () => {
    const custom = "https://my-facilitator.example.com";
    const client = new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      facilitatorUrl: custom,
    });
    assert.equal(client.facilitatorUrl, custom);
  });

  it("respects env SWARMWAGE_FACILITATOR=0 at construct time", () => {
    const prev = process.env.SWARMWAGE_FACILITATOR;
    process.env.SWARMWAGE_FACILITATOR = "0";
    try {
      const client = new AgentClient({ privateKey: TEST_PRIVATE_KEY });
      assert.equal(client.facilitatorUrl, null);
    } finally {
      if (prev === undefined) delete process.env.SWARMWAGE_FACILITATOR;
      else process.env.SWARMWAGE_FACILITATOR = prev;
    }
  });
});
