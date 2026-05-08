# Swarmwage Facilitator — gas-relay-only x402 facilitator
# License: BUSL-1.1

# ---- builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Copy workspace manifests first so dependency installs cache cleanly.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/facilitator/package.json ./packages/facilitator/

RUN pnpm install --frozen-lockfile --filter @swarmwage/facilitator...

# Copy package sources and build.
COPY packages/facilitator ./packages/facilitator

RUN pnpm --filter @swarmwage/facilitator build

# Prune dev dependencies for the runtime layer.
RUN pnpm --filter @swarmwage/facilitator deploy --prod /out

# ---- runtime --------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /out/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json

EXPOSE 3001

CMD ["node", "dist/index.js"]
