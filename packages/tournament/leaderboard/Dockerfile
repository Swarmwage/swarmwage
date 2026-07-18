# SPDX-License-Identifier: MIT
FROM node:20-alpine

WORKDIR /app
RUN addgroup -g 1001 -S leaderboard && adduser -u 1001 -S leaderboard -G leaderboard

COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm install --omit=optional --no-audit --no-fund && npx tsc

USER leaderboard
EXPOSE 8080
CMD ["node", "dist/index.js"]
