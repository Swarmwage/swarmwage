// Swarmwage MCP — constants tests
// License: MIT

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { VERSION } from "../constants.js";

test("runtime VERSION stays in sync with package.json", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
});
