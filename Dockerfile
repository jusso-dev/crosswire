# syntax=docker/dockerfile:1.7
# Production image (#57): multi-stage pnpm build -> slim Node runtime, non-root, no secrets in layers.
# Build: docker build -t crosswire:web .
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/web apps/web
RUN pnpm --filter web build
# Production-only dependency tree for the runtime stage.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter web deploy --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 SQUAD_DIR=/app/.squad MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/web/dist ./dist
COPY --from=build --chown=node:node /repo/apps/web/server.mjs ./server.mjs
COPY --from=build --chown=node:node /repo/apps/web/telemetry.mjs ./telemetry.mjs
COPY --from=build --chown=node:node /repo/apps/web/drizzle ./drizzle
COPY --from=build --chown=node:node /repo/apps/web/src ./src
COPY --chown=node:node .squad ./.squad
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default: serve. Migrations run as a separate one-shot step (#69): the Compose `migrate` service or
# the Azure Container Apps Job (`node_modules/.bin/tsx src/server/cli/migrate.ts`).
# Set MIGRATE_ON_START=true for single-container dev setups only.
# Worker: CMD ["node_modules/.bin/tsx", "src/server/cli/worker.ts"].
CMD ["sh", "-c", "if [ \"$MIGRATE_ON_START\" = true ]; then node_modules/.bin/tsx src/server/cli/migrate.ts || exit 1; fi; exec node --import ./telemetry.mjs server.mjs"]
