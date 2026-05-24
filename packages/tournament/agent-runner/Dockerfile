# SPDX-License-Identifier: MIT
#
# Build context: `packages/tournament/` (NOT agent-runner/) so the sibling
# `shared/` workspace package is reachable. Update docker-compose context
# accordingly: `context: ../..` (relative to ops/docker/) — see Track A5.
FROM node:20-alpine AS build

WORKDIR /app

# Stage the shared workspace package first so npm (which has no workspace
# awareness here) can resolve it via a file: path.
COPY shared/package.json ./shared/package.json
COPY shared/src ./shared/src

WORKDIR /app/agent-runner
COPY agent-runner/package.json agent-runner/tsconfig.json ./
COPY agent-runner/src ./src

# Rewrite the workspace:* specs for npm install:
#   - tournament-shared → file:../shared (sibling staged above)
#   - agent-sdk → published npm version (^0.5.1) since npm has no workspace awareness
RUN sed -i \
  -e 's|"@swarmwage/tournament-shared": "workspace:\*"|"@swarmwage/tournament-shared": "file:../shared"|' \
  -e 's|"@swarmwage/agent-sdk": "workspace:\*"|"@swarmwage/agent-sdk": "^0.5.1"|' \
  package.json \
 && npm install --omit=optional --no-audit --no-fund \
 && npx tsc

FROM node:20-alpine
RUN addgroup -g 1001 -S agent && adduser -u 1001 -S agent -G agent
WORKDIR /app

COPY --from=build /app/agent-runner/node_modules ./node_modules
COPY --from=build /app/agent-runner/dist ./dist
COPY --from=build /app/agent-runner/package.json ./

USER agent
EXPOSE 3000

CMD ["node", "dist/index.js"]
