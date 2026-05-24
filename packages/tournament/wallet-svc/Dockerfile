# SPDX-License-Identifier: MIT
FROM node:20-alpine

WORKDIR /app
RUN addgroup -g 1001 -S walletsvc && adduser -u 1001 -S walletsvc -G walletsvc

COPY package.json tsconfig.json ./
COPY src ./src

RUN npm install --omit=optional --no-audit --no-fund && npm cache clean --force
RUN npx tsc

# Volumes are mounted at runtime:
#   /secrets — wallets.json + caps.json (read-only)
#   /state   — cap-ledger.json (read-write)
USER walletsvc
EXPOSE 7000

CMD ["node", "dist/index.js"]
