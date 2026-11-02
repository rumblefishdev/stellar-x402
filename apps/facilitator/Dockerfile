# syntax=docker/dockerfile:1
# The facilitator's image (ADR 0011). Built from the repo root, for the server's platform:
#   docker build --platform linux/amd64 -f apps/facilitator/Dockerfile .
# The same image runs the service (`node dist/server.js`) and its migrations (`node dist/migrate.js`).

# node:22-slim (bookworm), pinned: a new digest is a reviewed change.
ARG NODE_IMAGE=node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# pnpm at the version `packageManager` names.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install
# The store from the lockfile alone, so a source change doesn't download it again.
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @stellar-x402/facilitator... \
  && pnpm --filter @stellar-x402/facilitator... build \
  && pnpm --filter @stellar-x402/facilitator deploy --prod /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and read by `node`, so the process can't change its own code; the compose file
# also makes the root filesystem read-only.
COPY --from=build /out ./
USER node
# Node is PID 1 and handles SIGTERM itself (`src/server.ts`).
CMD ["node", "dist/server.js"]
