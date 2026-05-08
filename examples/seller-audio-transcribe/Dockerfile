# Swarmwage seller-audio-transcribe — single-container image
# License: MIT
#
# Build context: REPO ROOT (because we need pnpm-workspace.yaml and the
# @swarmwage/agent-sdk workspace package).
#
#   docker build -f examples/seller-audio-transcribe/Dockerfile -t swarmwage-audio-transcribe .
#
# Run:
#
#   docker run -p 4005:4005 \
#     -e SELLER_PRIVATE_KEY=0x... \
#     -e GROQ_API_KEY=gsk_... \
#     -e FAL_API_KEY=...                                 # optional fallback \
#     -e REGISTRY_URL=https://registry.swarmwage.com \
#     -e PUBLIC_URL=https://audio-transcribe.swarmwage.com \
#     swarmwage-audio-transcribe

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
COPY examples/seller-audio-transcribe/ ./examples/seller-audio-transcribe/

# Install deps for the SDK + seller, then build the SDK so the seller can import it
RUN pnpm install --filter @swarmwage/example-seller-audio-transcribe... --frozen-lockfile \
  && pnpm --filter @swarmwage/agent-sdk build

EXPOSE 4005
ENV PORT=4005
ENV NETWORK=base

WORKDIR /app/examples/seller-audio-transcribe
CMD ["pnpm", "start"]
