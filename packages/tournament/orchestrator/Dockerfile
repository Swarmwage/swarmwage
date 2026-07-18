# SPDX-License-Identifier: MIT
#
# Build context: `packages/tournament/` (NOT orchestrator/) so the sibling
# `shared/` workspace package is reachable. Update docker-compose context
# accordingly: `context: ../..` (relative to ops/docker/).
FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache python3 make g++ && \
    addgroup -g 1001 -S orchestrator && \
    adduser -u 1001 -S orchestrator -G orchestrator

# Stage the shared workspace package first so npm (which has no workspace
# awareness here) can resolve it via a file: path.
COPY shared/package.json ./shared/package.json
COPY shared/src ./shared/src

WORKDIR /app/orchestrator
COPY orchestrator/package.json orchestrator/tsconfig.json ./
COPY orchestrator/src ./src

# Rewrite the workspace:* spec to file:../shared for npm install.
RUN sed -i 's|"@swarmwage/tournament-shared": "workspace:\*"|"@swarmwage/tournament-shared": "file:../shared"|' package.json \
 && npm install --omit=optional --no-audit --no-fund \
 && npx tsc

USER orchestrator
EXPOSE 4000
CMD ["node", "dist/index.js"]
