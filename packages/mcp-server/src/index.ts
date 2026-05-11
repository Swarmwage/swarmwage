// Swarmwage MCP — entry point
// License: MIT
//
// Dispatch:
//   `npx @swarmwage/mcp`           → interactive wizard if stdin is a TTY,
//                                    else MCP server (host launched us)
//   `npx @swarmwage/mcp --server`  → force MCP server mode (silent boot)
//   `npx @swarmwage/mcp --init`    → force wizard, even if stdin is not a TTY
//   `npx @swarmwage/mcp --version` → print version and exit

import { VERSION } from "./constants.js";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`@swarmwage/mcp v${VERSION}`);
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`@swarmwage/mcp v${VERSION}

Usage:
  npx @swarmwage/mcp            run interactive setup (first time) or boot MCP server (when launched by host)
  npx @swarmwage/mcp --server   force MCP server mode (silent boot)
  npx @swarmwage/mcp --init     force re-run interactive setup
  npx @swarmwage/mcp --version  print version
  npx @swarmwage/mcp --help     this help

Docs: https://github.com/Swarmwage/swarmwage/tree/main/packages/mcp-server
`);
  process.exit(0);
}

const forceServer = argv.includes("--server");
const forceWizard = argv.includes("--init");
const isTTY = Boolean(process.stdin.isTTY);

const wizardMode = forceWizard || (!forceServer && isTTY);

if (wizardMode) {
  const { runWizard } = await import("./wizard.js");
  await runWizard();
  process.exit(0);
} else {
  const { runServer } = await import("./server.js");
  await runServer();
}
