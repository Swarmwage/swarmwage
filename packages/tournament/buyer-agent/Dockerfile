# SPDX-License-Identifier: MIT
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

RUN npm install --omit=optional --no-audit --no-fund && npx tsc

FROM node:20-alpine
RUN addgroup -g 1001 -S buyer && adduser -u 1001 -S buyer -G buyer
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER buyer

CMD ["node", "dist/index.js"]
