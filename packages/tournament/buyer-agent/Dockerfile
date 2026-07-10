# SPDX-License-Identifier: MIT
#
# Build context: `packages/tournament/` (NOT buyer-agent/) so the sibling
# `shared/` workspace package is reachable. Update docker-compose context
# accordingly: `context: ../..` (relative to ops/docker/).
FROM node:20-alpine AS build

WORKDIR /app
RUN apk add --no-cache python3 make g++

# Stage + build the shared workspace package so the final image contains
# executable JavaScript instead of a dangling file: symlink to TypeScript.
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
RUN cd shared \
 && npm install --omit=optional --no-audit --no-fund typescript@5.5.4 \
 && npx tsc -p tsconfig.json --noEmit false --outDir dist --declaration true \
 && sed -i \
      -e 's|"main": "src/index.ts"|"main": "dist/index.js"|' \
      -e 's|"types": "src/index.ts"|"types": "dist/index.d.ts"|' \
      -e 's|"./src/index.ts"|"./dist/index.js"|' \
      -e 's|"./src/compound-templates.ts"|"./dist/compound-templates.js"|' \
      -e 's|"./src/roster.ts"|"./dist/roster.js"|' \
      package.json \
 && rm -rf node_modules

WORKDIR /app/buyer-agent
COPY buyer-agent/package.json buyer-agent/tsconfig.json ./
COPY buyer-agent/src ./src

# Rewrite the workspace:* specs for npm install:
#   - tournament-shared → file:../shared (sibling staged above)
#   - agent-sdk → current published npm version since npm has no workspace awareness
RUN sed -i \
  -e 's|"@swarmwage/tournament-shared": "workspace:\*"|"@swarmwage/tournament-shared": "file:../shared"|' \
  -e 's|"@swarmwage/agent-sdk": "workspace:\*"|"@swarmwage/agent-sdk": "^0.7.2"|' \
  package.json \
 && npm install --omit=optional --no-audit --no-fund \
 && npx tsc \
 && rm -rf node_modules/@swarmwage/tournament-shared \
 && mkdir -p node_modules/@swarmwage/tournament-shared \
 && cp -RL /app/shared/package.json /app/shared/dist node_modules/@swarmwage/tournament-shared/

FROM node:20-alpine
RUN addgroup -g 1001 -S buyer && adduser -u 1001 -S buyer -G buyer
WORKDIR /app

COPY --from=build /app/buyer-agent/node_modules ./node_modules
COPY --from=build /app/buyer-agent/dist ./dist
COPY --from=build /app/buyer-agent/package.json ./

USER buyer

CMD ["node", "dist/index.js"]
