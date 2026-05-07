# Swarmwage seller-code-exec — single-container image
# License: MIT
#
# Build context: REPO ROOT (because we need pnpm-workspace.yaml and the
# @swarmwage/agent-sdk workspace package).
#
#   docker build -f examples/seller-code-exec/Dockerfile -t swarmwage-code-exec .
#
# Run:
#
#   docker run -p 4003:4003 \
#     -e SELLER_PRIVATE_KEY=0x... \
#     -e REGISTRY_URL=https://registry.swarmwage.com \
#     -e PUBLIC_URL=https://code-exec.swarmwage.com \
#     swarmwage-code-exec
#
# No Python sidecar: Pyodide runs entirely inside Node via WebAssembly.

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy workspace manifest + lockfile + base configs
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy only the workspace packages we need
COPY packages/protocol/ ./packages/protocol/
COPY packages/sdk-ts/ ./packages/sdk-ts/
COPY examples/seller-code-exec/ ./examples/seller-code-exec/

# Install deps for the SDK + seller, then build the SDK so the seller can import it
RUN pnpm install --filter @swarmwage/example-seller-code-exec... --frozen-lockfile \
  && pnpm --filter @swarmwage/agent-sdk build

EXPOSE 4003
ENV PORT=4003
ENV NETWORK=base

WORKDIR /app/examples/seller-code-exec
CMD ["pnpm", "start"]
