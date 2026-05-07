# Swarmwage seller-data-extract — single-container image
# License: MIT
#
# Build context: REPO ROOT (because we need pnpm-workspace.yaml and the
# @swarmwage/agent-sdk workspace package).
#
#   docker build -f examples/seller-data-extract/Dockerfile -t swarmwage-data-extract .
#
# Run:
#
#   docker run -p 4004:4004 \
#     -e SELLER_PRIVATE_KEY=0x... \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     -e REGISTRY_URL=https://registry.swarmwage.com \
#     -e PUBLIC_URL=https://data-extract.swarmwage.com \
#     swarmwage-data-extract

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
COPY examples/seller-data-extract/ ./examples/seller-data-extract/

# Install deps for the SDK + seller, then build the SDK so the seller can import it
RUN pnpm install --filter @swarmwage/example-seller-data-extract... --frozen-lockfile \
  && pnpm --filter @swarmwage/agent-sdk build

EXPOSE 4004
ENV PORT=4004
ENV NETWORK=base

WORKDIR /app/examples/seller-data-extract
CMD ["pnpm", "start"]
