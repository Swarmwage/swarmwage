# © 2026 Swarmwage. MIT.
# Minimal container for Glama / introspection checks.
# The Swarmwage MCP server runs via stdio and is distributed on npm
# as @swarmwage/mcp. This image just wraps the npm install + execution.

FROM node:20-alpine

# Install the published MCP server globally
RUN npm install -g @swarmwage/mcp@latest

# Sensible defaults for introspection-only checks.
# A real buyer/seller sets these at runtime.
ENV SWARMWAGE_PRIVATE_KEY=""
ENV AGENT_TELEMETRY="0"

# MCP servers communicate over stdio. The binary exposed by the npm
# package is `swarmwage-mcp`. ENTRYPOINT runs it in foreground so the
# container's stdin/stdout become the MCP transport.
ENTRYPOINT ["swarmwage-mcp"]
