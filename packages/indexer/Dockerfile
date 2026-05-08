# Swarmwage Indexer — read-only on-chain USDC Transfer indexer
# License: BUSL-1.1

# ---- builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Copy workspace manifests first so dependency installs cache cleanly.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/indexer/package.json ./packages/indexer/

RUN pnpm install --frozen-lockfile --filter @swarmwage/indexer...

# Copy package sources and build.
COPY packages/indexer ./packages/indexer

RUN pnpm --filter @swarmwage/indexer build

# Prune dev dependencies for the runtime layer.
RUN pnpm --filter @swarmwage/indexer deploy --prod /out

# ---- runtime --------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002

COPY --from=builder /out/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json

EXPOSE 3002

CMD ["node", "dist/index.js"]
