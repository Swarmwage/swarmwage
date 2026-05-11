// Swarmwage MCP — local config persistence
// License: MIT
//
// Stores wallet + setup state in `~/.swarmwage/`:
//   wallet.key   — raw 0x-prefixed private key, chmod 600
//   config.json  — { mode, host, installed_at, version }

import { mkdir, writeFile, readFile, chmod } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import type { Hex } from "@swarmwage/agent-sdk";

export const SWARMWAGE_DIR = join(homedir(), ".swarmwage");
export const WALLET_PATH = join(SWARMWAGE_DIR, "wallet.key");
export const CONFIG_PATH = join(SWARMWAGE_DIR, "config.json");

export type WizardMode =
  | "explorer" // no wallet, lookup-only
  | "buyer-paste" // user pasted a private key
  | "buyer-generated" // wizard generated a test wallet
  | "seller"; // generated wallet + published a listing

export interface SwarmwageConfig {
  mode: WizardMode;
  host: "claude-code" | "claude-desktop" | "cursor" | "manual" | "none";
  installed_at: string; // ISO 8601
  version: string;
}

async function ensureDir(): Promise<void> {
  await mkdir(SWARMWAGE_DIR, { recursive: true, mode: 0o700 });
  // chmod again in case dir already existed with looser perms
  try {
    await chmod(SWARMWAGE_DIR, 0o700);
  } catch {
    /* best-effort, Windows or read-only FS */
  }
}

export async function saveWallet(key: Hex): Promise<void> {
  await ensureDir();
  await writeFile(WALLET_PATH, key, { encoding: "utf-8", mode: 0o600 });
  try {
    await chmod(WALLET_PATH, 0o600);
  } catch {
    /* best-effort */
  }
}

export async function loadWallet(): Promise<Hex | null> {
  try {
    const data = await readFile(WALLET_PATH, "utf-8");
    const key = data.trim();
    if (/^0x[a-fA-F0-9]{64}$/.test(key)) {
      return key as Hex;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: SwarmwageConfig): Promise<void> {
  await ensureDir();
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

export async function loadConfig(): Promise<SwarmwageConfig | null> {
  try {
    const data = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(data) as SwarmwageConfig;
  } catch {
    return null;
  }
}

