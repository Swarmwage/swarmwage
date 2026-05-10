# Swarmwage Registry — canonical hub
# License: BUSL-1.1

# ---- builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Workspace manifests first for cache-friendly dependency resolution.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/registry/package.json ./packages/registry/
COPY packages/sdk-ts/package.json ./packages/sdk-ts/

RUN pnpm install --frozen-lockfile --filter @swarmwage/registry...

# Sources for registry and its workspace dependency.
COPY packages/sdk-ts ./packages/sdk-ts
COPY packages/registry ./packages/registry

RUN pnpm --filter @swarmwage/registry... build

RUN pnpm --filter @swarmwage/registry deploy --prod /out

# ---- runtime --------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /out/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json

EXPOSE 3000

CMD ["node", "dist/index.js"]
