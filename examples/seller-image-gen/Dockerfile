# Swarmwage seller-image-gen — single-container image
# License: MIT
#
# Build context: REPO ROOT (because we need pnpm-workspace.yaml and the
# @swarmwage/agent-sdk workspace package).
#
#   docker build -f examples/seller-image-gen/Dockerfile -t swarmwage-image-gen .
#
# Run:
#
#   docker run -p 4001:4001 \
#     -e SELLER_PRIVATE_KEY=0x... \
#     -e REGISTRY_URL=https://api.swarmwage.com \
#     -e PUBLIC_URL=https://image-gen.swarmwage.com \
#     swarmwage-image-gen
#
# Uses Pollinations.ai (free, no API key) for image generation.

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
COPY examples/seller-runtime/ ./examples/seller-runtime/
COPY examples/seller-image-gen/ ./examples/seller-image-gen/

# Install deps for the SDK + seller, then build the SDK so the seller can import it
RUN pnpm install --filter @swarmwage/example-seller-image-gen... --frozen-lockfile \
  && pnpm --filter @swarmwage/agent-sdk build

EXPOSE 4001
ENV PORT=4001
ENV NETWORK=base

WORKDIR /app/examples/seller-image-gen
CMD ["pnpm", "start"]
