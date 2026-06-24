// Swarmwage MCP — entry point
// License: MIT
//
// Dispatch:
//   `npx @swarmwage/mcp`           → interactive wizard if stdin is a TTY,
//                                    else MCP server (host launched us)
//   `npx @swarmwage/mcp --server`  → force MCP server mode (silent boot)
//   `npx @swarmwage/mcp --init`    → force wizard, even if stdin is not a TTY
//   `npx @swarmwage/mcp search ...` → human-facing read-only CLI commands
//   `npx @swarmwage/mcp --version` → print version and exit

import { VERSION } from "./constants.js";

const argv = process.argv.slice(2);
const cliCommands = new Set([
  "capabilities",
  "list",
  "search",
  "x402-search",
  "reliability",
  "dry-run",
  "help",
]);

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
  npx @swarmwage/mcp capabilities
  npx @swarmwage/mcp search <capability>
  npx @swarmwage/mcp x402-search [query]
  npx @swarmwage/mcp reliability [--url URL | --service-id ID]
  npx @swarmwage/mcp dry-run <url>
  npx @swarmwage/mcp --version  print version
  npx @swarmwage/mcp --help     this help

Docs: https://github.com/Swarmwage/swarmwage/tree/main/packages/mcp-server
`);
  process.exit(0);
}

const forceServer = argv.includes("--server");
const forceWizard = argv.includes("--init");
const isTTY = Boolean(process.stdin.isTTY);

if (argv[0] && cliCommands.has(argv[0])) {
  const { runCli } = await import("./cli.js");
  try {
    await runCli(argv);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

const wizardMode = forceWizard || (!forceServer && isTTY);

if (wizardMode) {
  const { runWizard } = await import("./wizard.js");
  await runWizard();
  process.exit(0);
} else {
  const { runServer } = await import("./server.js");
  await runServer();
}
