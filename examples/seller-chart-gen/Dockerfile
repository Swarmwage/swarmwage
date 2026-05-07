# Swarmwage seller-chart-gen — single-container image
# License: MIT
#
# Build context: REPO ROOT (because we need pnpm-workspace.yaml and the
# @swarmwage/agent-sdk workspace package).
#
#   docker build -f examples/seller-chart-gen/Dockerfile -t swarmwage-chart-gen .
#
# Run:
#
#   docker run -p 4002:4002 \
#     -e SELLER_PRIVATE_KEY=0x... \
#     -e REGISTRY_URL=https://registry.swarmwage.com \
#     -e PUBLIC_URL=https://chart-gen.swarmwage.com \
#     swarmwage-chart-gen

FROM node:20-bookworm-slim

# Python + matplotlib (in a venv to satisfy PEP 668)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
ENV PYTHON_BIN="$VIRTUAL_ENV/bin/python3"

COPY examples/seller-chart-gen/render/requirements.txt /tmp/render-requirements.txt
RUN pip install --no-cache-dir -r /tmp/render-requirements.txt

# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy workspace manifest + lockfile + base configs
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy only the workspace packages we need
COPY packages/protocol/ ./packages/protocol/
COPY packages/sdk-ts/ ./packages/sdk-ts/
COPY examples/seller-chart-gen/ ./examples/seller-chart-gen/

# Install deps for the SDK + seller, then build the SDK so the seller can import it
RUN pnpm install --filter @swarmwage/example-seller-chart-gen... --frozen-lockfile \
  && pnpm --filter @swarmwage/agent-sdk build

EXPOSE 4002
ENV PORT=4002
ENV NETWORK=base

WORKDIR /app/examples/seller-chart-gen
CMD ["pnpm", "start"]
