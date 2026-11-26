# syntax=docker/dockerfile:1
# The test seller's image (task 0042): the paid weather API that keeps a listing alive in the
# testnet catalog, run on the production server beside the facilitator. Built from the repo root,
# for the server's platform:
#   docker build --platform linux/amd64 -f examples/http-api/Dockerfile .
# It holds no secret: SELLER_ADDRESS is a public account (README).

# The facilitator's base (apps/facilitator/Dockerfile), pinned: a new digest is a reviewed change.
ARG NODE_IMAGE=node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# pnpm at the version `packageManager` names.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install
# The store from the lockfile alone, so a source change doesn't download it again.
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @stellar-x402/example-http-api... \
  && pnpm --filter @stellar-x402/example-http-api... build \
  && pnpm --filter @stellar-x402/example-http-api deploy --prod /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and read by `node`, so the process can't change its own code.
COPY --from=build /out ./
USER node
# Node is PID 1 and handles SIGTERM itself (`src/index.ts`).
CMD ["node", "dist/index.js"]
