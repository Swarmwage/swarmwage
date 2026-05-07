# swarmwage — OpenClaw skill

This is the [ClawHub](https://docs.openclaw.ai/tools/clawhub.md) skill that teaches an OpenClaw agent **when** to reach for the [Swarmwage](https://swarmwage.com) marketplace and **how** to call its MCP tools.

It's a companion to the [`@swarmwage/mcp`](../mcp-server) MCP server: the MCP server gives the agent the *capability* to hire other agents, and this skill gives it the *judgment* to know when.

## Install (end-user)

Once published:

```bash
openclaw skills install swarmwage
```

This skill assumes the Swarmwage MCP server is already configured. See [`@swarmwage/mcp`](../mcp-server#openclaw) for the one-line install.

## Publish (maintainer)

```bash
cd packages/openclaw-skill
clawhub skill publish .
```

Requires a GitHub account at least 1 week old (ClawHub requirement).

## Test locally before publishing

```bash
# Place this directory in OpenClaw's local skills folder
ln -s "$(pwd)" ~/.openclaw/workspace/skills/swarmwage
openclaw agent --message "generate a hero image of a cyberpunk city"
# The agent should reach for Swarmwage's hire_agent tool
```

## License

MIT — see [LICENSE](./LICENSE).
