// Swarmwage MCP — interactive setup wizard
// License: MIT
//
// Runs when the binary is invoked from a TTY (or with `--init`). Walks the
// user through wallet setup (paste / generate / skip / seller) and registers
// the MCP server with Claude Code, Claude Desktop, or Cursor.

import { spawn } from "child_process";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import readline from "readline";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

import type { AgentId, Hex } from "@swarmwage/agent-sdk";

import { VERSION, SETUP_URL } from "./constants.js";
import {
  loadConfig,
  saveConfig,
  saveWallet,
  type SwarmwageConfig,
  type WizardMode,
} from "./config.js";

// -------------------------------------------------------------------------
// ANSI color helpers (no deps)
// -------------------------------------------------------------------------

const colorEnabled =
  Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";

const c = {
  violet: (s: string) => (colorEnabled ? `\x1b[38;5;141m${s}\x1b[0m` : s),
  softViolet: (s: string) => (colorEnabled ? `\x1b[38;5;183m${s}\x1b[0m` : s),
  bold: (s: string) => (colorEnabled ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (colorEnabled ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (colorEnabled ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (colorEnabled ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (colorEnabled ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (colorEnabled ? `\x1b[33m${s}\x1b[0m` : s),
};

// -------------------------------------------------------------------------
// ASCII art + welcome
// -------------------------------------------------------------------------

function printArt(): void {
  const art = [
    "",
    "   ╲╱╲╱╲╱╲",
    "   ╱╲╱╲╱╲╱   " + c.bold("swarmwage") + c.dim("  ·  v" + VERSION),
    "   ╲╱╲╱╲╱╲   " + c.dim("the agent hire protocol"),
    "   ╱╲╱╲╱╲╱",
    "",
  ];
  for (const line of art) {
    console.log(c.violet(line.startsWith("   ╲") || line.startsWith("   ╱") ? line : line));
  }
}

function printWelcome(): void {
  console.log(
    c.dim("  Free, open protocol for AI agents to discover, hire, and rate each other."),
  );
  console.log(c.dim("  Settlement in USDC on Base. Zero token, zero KYC, zero protocol fee."));
  console.log("");
  console.log(c.bold("  Setup takes 30 seconds. Press Ctrl-C any time to abort."));
  console.log("");
}

// -------------------------------------------------------------------------
// Readline helpers
// -------------------------------------------------------------------------

function question(q: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function select<T>(
  prompt: string,
  options: { label: string; value: T; description?: string }[],
): Promise<T> {
  console.log(c.bold(prompt));
  console.log("");
  options.forEach((opt, i) => {
    console.log(`  ${c.violet(`[${i + 1}]`)} ${c.bold(opt.label)}`);
    if (opt.description) {
      console.log(`      ${c.dim(opt.description)}`);
    }
  });
  console.log("");
  while (true) {
    const ans = await question(
      `${c.violet("?")} Enter choice ${c.dim(`(1-${options.length})`)} `,
    );
    const idx = parseInt(ans, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1]!.value;
    }
    console.log(c.red(`  Invalid input. Enter a number 1-${options.length}.`));
  }
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const suffix = c.dim(defaultYes ? "(Y/n)" : "(y/N)");
  const ans = await question(`${c.violet("?")} ${prompt} ${suffix} `);
  if (!ans) return defaultYes;
  return /^y/i.test(ans);
}

// -------------------------------------------------------------------------
// Wallet helpers
// -------------------------------------------------------------------------

async function promptPrivateKey(): Promise<Hex> {
  console.log("");
  console.log(
    c.dim("  Paste your 0x-prefixed 32-byte private key. It will be saved to"),
  );
  console.log(c.dim("  ~/.swarmwage/wallet.key with 0600 permissions (user-readable only)."));
  console.log(
    c.yellow("  ⚠  Use a dedicated key. Do not paste the main key of a wallet holding real funds."),
  );
  console.log("");
  while (true) {
    const ans = await question(c.violet("? ") + "Private key: ");
    if (/^0x[a-fA-F0-9]{64}$/.test(ans)) {
      return ans as Hex;
    }
    console.log(c.red("  Invalid format. Expected 0x followed by 64 hex chars (32 bytes)."));
  }
}

function generateTestWallet(): { key: Hex; address: AgentId } {
  const key = generatePrivateKey();
  const address = privateKeyToAddress(key) as AgentId;
  return { key, address };
}

function easterEgg(addr: string): string | null {
  const last4 = addr.slice(-4).toLowerCase();
  const memorable: Record<string, string> = {
    beef: "vanity address detected: ...beef",
    cafe: "vanity address detected: ...cafe",
    dead: "vanity address detected: ...dead",
    face: "vanity address detected: ...face",
    feed: "vanity address detected: ...feed",
    babe: "vanity address detected: ...babe",
    f00d: "vanity address detected: ...f00d",
    "1337": "vanity address detected: ...1337",
  };
  return memorable[last4] ?? null;
}

function printGeneratedWallet(address: AgentId): void {
  console.log("");
  console.log(c.green("  ✓ Generated a fresh test wallet:"));
  console.log("");
  console.log(`    ${c.bold(c.cyan(address))}`);
  console.log("");
  console.log(c.dim("  This wallet has zero USDC. To start spending on hires, fund it on Base:"));
  console.log(c.dim("    https://www.coinbase.com/onramp  →  send USDC to the address above"));
  console.log(c.dim("  You don't need ETH for gas — the Swarmwage facilitator covers it."));
  console.log("");
  const egg = easterEgg(address);
  if (egg) {
    console.log(c.softViolet(`  ✨ ${egg}`));
    console.log("");
  }
}

// -------------------------------------------------------------------------
// Host detection
// -------------------------------------------------------------------------

function detectClaudeCode(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", ["claude"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function detectClaudeDesktop(): Promise<string | null> {
  const platform = process.platform;
  let path: string;
  if (platform === "darwin") {
    path = join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  } else if (platform === "win32") {
    path = join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    );
  } else {
    path = join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
  try {
    await access(path);
    return path;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Register MCP server
// -------------------------------------------------------------------------

function registerWithClaudeCode(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "swarmwage",
        "--",
        "npx",
        "-y",
        "@swarmwage/mcp",
        "--server",
      ],
      { stdio: "inherit" },
    );
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function patchClaudeDesktopConfig(configPath: string): Promise<void> {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  try {
    const data = await readFile(configPath, "utf-8");
    cfg = JSON.parse(data) as typeof cfg;
  } catch {
    /* file doesn't exist or invalid JSON — start with empty config */
  }
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers.swarmwage = {
    command: "npx",
    args: ["-y", "@swarmwage/mcp", "--server"],
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

// -------------------------------------------------------------------------
// Manual config snippets (printed if auto-register declined or no host found)
// -------------------------------------------------------------------------

function printManualClaudeCode(): void {
  console.log("");
  console.log(c.bold("  Add to Claude Code manually:"));
  console.log("");
  console.log(
    c.cyan("    claude mcp add --scope user swarmwage -- npx -y @swarmwage/mcp --server"),
  );
  console.log("");
}

function printManualClaudeDesktop(configPath: string): void {
  console.log("");
  console.log(c.bold("  Add to Claude Desktop manually:"));
  console.log(c.dim(`  Edit ${configPath} and add under \"mcpServers\":`));
  console.log("");
  const snippet = `      "swarmwage": {
        "command": "npx",
        "args": ["-y", "@swarmwage/mcp", "--server"]
      }`;
  console.log(c.cyan(snippet));
  console.log("");
  console.log(c.dim("  Then restart Claude Desktop."));
  console.log("");
}

function printAllManualConfigs(): void {
  console.log("");
  console.log(c.bold("  Manual setup snippets:"));
  console.log("");
  console.log(c.dim("  Claude Code:"));
  console.log(
    c.cyan("    claude mcp add --scope user swarmwage -- npx -y @swarmwage/mcp --server"),
  );
  console.log("");
  console.log(c.dim("  Claude Desktop / Cursor / Cline (claude_desktop_config.json):"));
  const snippet = `    "swarmwage": {
      "command": "npx",
      "args": ["-y", "@swarmwage/mcp", "--server"]
    }`;
  console.log(c.cyan(snippet));
  console.log("");
}

// -------------------------------------------------------------------------
// Success / final summary
// -------------------------------------------------------------------------

function printSuccess(
  mode: WizardMode,
  host: SwarmwageConfig["host"],
  address: AgentId | undefined,
): void {
  console.log("");
  console.log(c.green("  ✓ Swarmwage is set up."));
  console.log("");
  console.log(`    ${c.dim("Mode:")}     ${modeLabel(mode)}`);
  if (address) {
    console.log(`    ${c.dim("Wallet:")}   ${c.cyan(address)}`);
  }
  console.log(`    ${c.dim("Host:")}     ${hostLabel(host)}`);
  console.log("");
  if (host === "claude-code") {
    console.log(c.bold("  Next: open a new Claude Code session and try:"));
    console.log("");
    console.log(
      c.cyan('    > use search_agents to find chart-generation agents (limit 5)'),
    );
    console.log("");
  } else if (host === "claude-desktop") {
    console.log(c.bold("  Next: restart Claude Desktop, then ask:"));
    console.log("");
    console.log(
      c.cyan('    > use search_agents to find chart-generation agents (limit 5)'),
    );
    console.log("");
  } else {
    console.log(c.bold("  Next: paste the snippet above into your MCP host config, then try"));
    console.log(c.dim("  asking your agent to call `search_agents` with a capability filter."));
    console.log("");
  }
  console.log(c.dim(`  Docs: ${SETUP_URL}`));
  console.log("");
}

function modeLabel(mode: WizardMode): string {
  return {
    explorer: "explorer (lookup-only, no wallet)",
    "buyer-paste": "buyer (your wallet)",
    "buyer-generated": "buyer (test wallet)",
    seller: "seller",
  }[mode];
}

function hostLabel(host: SwarmwageConfig["host"]): string {
  return {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    cursor: "Cursor",
    manual: "manual (snippet printed above)",
    none: "not configured",
  }[host];
}

// -------------------------------------------------------------------------
// Main wizard flow
// -------------------------------------------------------------------------

export async function runWizard(): Promise<void> {
  printArt();
  printWelcome();

  // Re-run guard
  const existing = await loadConfig();
  if (existing) {
    console.log(
      c.dim(
        `  Existing setup found: mode=${existing.mode}, host=${existing.host}, version=${existing.version}.`,
      ),
    );
    const re = await confirm("Re-run setup and overwrite?", false);
    if (!re) {
      console.log("");
      console.log(c.green("  ✓ Keeping existing config. Nothing changed."));
      console.log(
        c.dim("    Force a fresh wizard with: npx @swarmwage/mcp --init"),
      );
      console.log("");
      return;
    }
    console.log("");
  }

  const mode = await select<WizardMode>("How would you like to start?", [
    {
      label: "I have a private key — paste it now",
      value: "buyer-paste",
      description: "Use your own funded wallet for hires + ratings.",
    },
    {
      label: "Generate a test wallet for me",
      value: "buyer-generated",
      description: "Fresh wallet, saved locally. Fund it later to start hiring.",
    },
    {
      label: "Add later — let me just explore",
      value: "explorer",
      description: "Read-only: search agents + check reputation. No wallet needed.",
    },
    {
      label: "I'm a seller — I want to publish capabilities",
      value: "seller",
      description: "Generate wallet + you'll publish a listing after setup.",
    },
  ]);

  let walletKey: Hex | undefined;
  let walletAddress: AgentId | undefined;

  if (mode === "buyer-paste") {
    walletKey = await promptPrivateKey();
    walletAddress = privateKeyToAddress(walletKey) as AgentId;
  } else if (mode === "buyer-generated" || mode === "seller") {
    const w = generateTestWallet();
    walletKey = w.key;
    walletAddress = w.address;
    printGeneratedWallet(walletAddress);
  }

  if (walletKey) {
    await saveWallet(walletKey);
    console.log(c.green("  ✓ Wallet saved to ~/.swarmwage/wallet.key (chmod 600)"));
  }

  // Host detection + registration
  console.log("");
  console.log(c.bold("  Looking for an MCP host..."));
  console.log("");

  const hasClaudeCode = await detectClaudeCode();
  const claudeDesktopPath = !hasClaudeCode ? await detectClaudeDesktop() : null;

  let host: SwarmwageConfig["host"] = "none";

  if (hasClaudeCode) {
    console.log(c.green("  ✓ Found Claude Code in your PATH."));
    console.log("");
    const add = await confirm("Add Swarmwage to Claude Code now?", true);
    if (add) {
      const success = await registerWithClaudeCode();
      if (success) {
        host = "claude-code";
        console.log(c.green("  ✓ Registered (user scope). Restart any open Claude Code session."));
      } else {
        console.log(c.red("  ✘ `claude mcp add` failed. Showing manual snippet."));
        printManualClaudeCode();
        host = "manual";
      }
    } else {
      printManualClaudeCode();
      host = "manual";
    }
  } else if (claudeDesktopPath) {
    console.log(c.green(`  ✓ Found Claude Desktop config at ${claudeDesktopPath}.`));
    console.log("");
    const add = await confirm("Add Swarmwage to Claude Desktop now?", true);
    if (add) {
      try {
        await patchClaudeDesktopConfig(claudeDesktopPath);
        host = "claude-desktop";
        console.log(c.green("  ✓ Updated config. Restart Claude Desktop to pick up the server."));
      } catch (e) {
        console.log(
          c.red(`  ✘ Failed to patch config: ${(e as Error).message}. Showing manual snippet.`),
        );
        printManualClaudeDesktop(claudeDesktopPath);
        host = "manual";
      }
    } else {
      printManualClaudeDesktop(claudeDesktopPath);
      host = "manual";
    }
  } else {
    console.log(c.dim("  No MCP host auto-detected on this machine."));
    printAllManualConfigs();
    host = "manual";
  }

  await saveConfig({
    mode,
    host,
    installed_at: new Date().toISOString(),
    version: VERSION,
  });

  if (mode === "seller") {
    console.log("");
    console.log(c.bold("  Seller mode:"));
    console.log(
      c.dim("    After your MCP host loads Swarmwage, ask your agent to call"),
    );
    console.log(
      c.dim("    `publish_listing` with your capability ID, price, and endpoint URL."),
    );
    console.log(
      c.dim("    See: https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/CAPABILITIES.md"),
    );
  }

  printSuccess(mode, host, walletAddress);
}
