# syntax=docker/dockerfile:1
# The facilitator's image (ADR 0011). Built from the repo root, for the server's platform:
#   docker build --platform linux/amd64 -f apps/facilitator/Dockerfile .
# The same image runs the service (`node dist/server.js`), its migrations (`node dist/migrate.js`)
# and the search model's server (`node /search-model/dist/main.js`, ADR 0014).

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
    --filter @stellar-x402/search-model... \
  && pnpm --filter @stellar-x402/facilitator... --filter @stellar-x402/search-model... build \
  && pnpm --filter @stellar-x402/facilitator deploy --prod /out \
  && pnpm --filter @stellar-x402/search-model deploy --prod /out-search-model
# The model's files at the revision `apps/search-model/src/model.ts` pins, so its container
# downloads nothing when it starts.
RUN node apps/search-model/scripts/fetch-model.mjs /out-search-model/model

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# Owned by root and read by `node`, so the process can't change its own code; the compose file
# also makes the root filesystem read-only.
COPY --from=build /out ./
# The search model's server and its files, run as a container of its own from this image.
COPY --from=build /out-search-model /search-model
ENV MODEL_DIR=/search-model/model
USER node
# The commit this image is built from; `/health` reports it. Last, so the layers above stay cached.
ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}
# Node is PID 1 and handles SIGTERM itself (`src/server.ts`).
CMD ["node", "dist/server.js"]
