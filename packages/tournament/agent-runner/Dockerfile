# SPDX-License-Identifier: MIT
#
# Build context: `packages/tournament/` (NOT agent-runner/) so the sibling
# `shared/` workspace package is reachable. docker-compose context is `../..`
# (relative to ops/docker/).
FROM node:20-alpine AS build

WORKDIR /app

# Stage + BUILD the shared workspace package first. We compile it to dist/ JS
# here so the runtime never has to execute .ts, and so we can replace npm's
# file: SYMLINK with a real directory (a multi-stage COPY would otherwise leave
# a dangling symlink pointing at a /shared the final stage never copies).
COPY shared/package.json shared/tsconfig.build.json ./shared/
COPY shared/src ./shared/src
RUN cd shared \
 && npm install --omit=optional --no-audit --no-fund typescript@5.5.4 \
 && npx tsc -p tsconfig.build.json \
 && rm -rf node_modules

WORKDIR /app/agent-runner
COPY agent-runner/package.json agent-runner/tsconfig.json ./
COPY agent-runner/src ./src

# Rewrite the workspace:* specs for npm install:
#   - tournament-shared -> file:../shared (sibling built above)
#   - agent-sdk -> published npm version since npm has no workspace awareness
RUN sed -i \
  -e 's|"@swarmwage/tournament-shared": "workspace:\*"|"@swarmwage/tournament-shared": "file:../shared"|' \
  -e 's|"@swarmwage/agent-sdk": "workspace:\*"|"@swarmwage/agent-sdk": "^0.5.1"|' \
  package.json \
 && npm install --omit=optional --no-audit --no-fund \
 && npx tsc \
 && rm -rf node_modules/@swarmwage/tournament-shared \
 && mkdir -p node_modules/@swarmwage/tournament-shared \
 && cp -RL /app/shared/package.json /app/shared/dist node_modules/@swarmwage/tournament-shared/

FROM node:20-alpine
RUN addgroup -g 1001 -S agent && adduser -u 1001 -S agent -G agent
WORKDIR /app

COPY --from=build /app/agent-runner/node_modules ./node_modules
COPY --from=build /app/agent-runner/dist ./dist
COPY --from=build /app/agent-runner/package.json ./

USER agent
EXPOSE 3000

CMD ["node", "dist/index.js"]
