// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Self-contained roster + wallet-address map for the leaderboard service.
//
// Duplicated (not imported from @swarmwage/tournament-shared) on purpose: the
// leaderboard Dockerfile does a standalone `npm install` of this package only,
// without the pnpm workspace, so it cannot resolve workspace deps at build
// time. Keep these labels in sync with shared/src/roster.ts.
//
// Addresses verified 2026-05-26 (tournament launch state). All on Base mainnet.

export interface AgentMeta {
  agent_id: string;
  label: string;
  provider: string;
  kind: 'internal' | 'buyer';
  address: string; // lowercase 0x
}

export const ROSTER: AgentMeta[] = [
  { agent_id: 'agent_01', label: 'Claude Sonnet 4.6', provider: 'anthropic', kind: 'internal', address: '0x051e9c55280a546be824459bd3d34f311e8a9c39' },
  { agent_id: 'agent_02', label: 'Claude Haiku 4.5',  provider: 'anthropic', kind: 'internal', address: '0x4e9758587bc2e234e9c1133a870d20cf6fa8e878' },
  { agent_id: 'agent_03', label: 'GPT-5',             provider: 'openai',    kind: 'internal', address: '0x40fdf0163a97bfee997bf98a3330b252c457971c' },
  { agent_id: 'agent_04', label: 'GPT-5 Mini',        provider: 'openai',    kind: 'internal', address: '0x017237b3012fad9e61c2086c902d1f4034a2f8c5' },
  { agent_id: 'agent_05', label: 'Gemini 2.5 Pro',    provider: 'google',    kind: 'internal', address: '0x86429bd38038be462e4093667a43b99c24dd5851' },
  { agent_id: 'agent_06', label: 'Grok 4.3',          provider: 'xai',       kind: 'internal', address: '0xb962377acf020f2980d6c76dc73b4cd48200118b' },
  { agent_id: 'agent_07', label: 'DeepSeek R1',       provider: 'deepseek',  kind: 'internal', address: '0xf06d95adb90a555a5136c9b153e38e11cb3b3cc4' },
  { agent_id: 'agent_08', label: 'Kimi K2',           provider: 'moonshot',  kind: 'internal', address: '0xd357edd3b08d9028e59f18d91dfadb80f8745518' },
  { agent_id: 'agent_09', label: 'Mistral Large 2',   provider: 'mistral',   kind: 'internal', address: '0xb37ccabc3b1b4e8e10253d3392673cdbb204111b' },
  { agent_id: 'agent_10', label: 'Gemini 2.5 Flash',  provider: 'google',    kind: 'internal', address: '0xfb5c3827bab3f58482e5fde414d14aac387622ef' },
  { agent_id: 'buyer_01', label: 'Claude Haiku 4.5',  provider: 'anthropic', kind: 'buyer',    address: '0x6dd1777235e54d07b83b542f7624a223397e2606' },
  { agent_id: 'buyer_02', label: 'Claude Haiku 4.5',  provider: 'anthropic', kind: 'buyer',    address: '0xfa0dfc1803e788520c3133312f903fbe2c0fd7a4' },
];

const BY_ADDRESS = new Map(ROSTER.map((a) => [a.address.toLowerCase(), a]));
const BY_ID = new Map(ROSTER.map((a) => [a.agent_id, a]));

export function metaByAddress(addr: string | undefined | null): AgentMeta | undefined {
  if (!addr) return undefined;
  return BY_ADDRESS.get(addr.toLowerCase());
}

export function metaById(id: string | undefined | null): AgentMeta | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

/** All known tournament addresses (lowercase) — used to filter on-chain logs. */
export const ALL_ADDRESSES: string[] = ROSTER.map((a) => a.address.toLowerCase());

/** Short human handle for an address: "Grok 4.3 (agent_06)" or the raw addr. */
export function labelForAddress(addr: string | undefined | null): string {
  const m = metaByAddress(addr);
  if (!m) return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '?';
  return m.label;
}
