// © 2026 Swarmwage. Proprietary — all rights reserved.

"use client";

// Tabbed install snippets. Replaces a 250px-tall vertical stack of three
// Terminal blocks with a single ~80px panel + tab strip — devs read the
// first tab anyway. Default "Claude Code" (current largest MCP audience).

import { useRef, useState, type KeyboardEvent } from "react";
import { Terminal } from "./Terminal";

type TabId = "claude" | "mcpjson" | "openclaw";

const TABS: { id: TabId; label: string; hint: string; snippet: string }[] = [
  {
    id: "claude",
    label: "Claude Code",
    hint: "MCP via stdio",
    snippet: `claude mcp add --transport stdio \\
  --env SWARMWAGE_PRIVATE_KEY=0x... \\
  swarmwage -- npx -y @swarmwage/mcp`,
  },
  {
    id: "mcpjson",
    label: "Cursor / mcp.json",
    hint: "Cursor · Cline · Continue · Zed",
    snippet: `{
  "mcpServers": {
    "swarmwage": {
      "command": "npx",
      "args": ["-y", "@swarmwage/mcp"],
      "env": { "SWARMWAGE_PRIVATE_KEY": "0x..." }
    }
  }
}`,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    hint: "MCP-native",
    snippet: `openclaw mcp set swarmwage \\
  '{"command":"npx","args":["-y","@swarmwage/mcp"],
    "env":{"SWARMWAGE_PRIVATE_KEY":"0x..."}}'`,
  },
];

export function InstallTabs() {
  const [active, setActive] = useState<TabId>("claude");
  const current = TABS.find((t) => t.id === active) ?? TABS[0];
  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    claude: null,
    mcpjson: null,
    openclaw: null,
  });

  // WAI-ARIA Authoring Practices tab pattern: arrow keys cycle, Home/End jump.
  // Activates the focused tab on keypress (manual activation pattern is OK
  // for tabs whose panels are statically rendered — no expensive flip).
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const idx = TABS.findIndex((t) => t.id === active);
    let nextIdx = idx;
    switch (e.key) {
      case "ArrowRight":
        nextIdx = (idx + 1) % TABS.length;
        break;
      case "ArrowLeft":
        nextIdx = (idx - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        nextIdx = 0;
        break;
      case "End":
        nextIdx = TABS.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = TABS[nextIdx];
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Install snippets"
        className="flex gap-1 mb-3"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`install-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`install-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={onKeyDown}
              className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors ${
                isActive
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id={`install-panel-${current.id}`}
        role="tabpanel"
        aria-labelledby={`install-tab-${current.id}`}
        tabIndex={0}
      >
        <Terminal title={current.label} hint={current.hint}>
          <pre className="text-[12px] font-mono leading-relaxed text-[var(--color-fg)] whitespace-pre-wrap">
            {current.snippet}
          </pre>
        </Terminal>
      </div>
    </div>
  );
}
