# syntax=docker/dockerfile:1.7
#
# CompassAlpha — multi-stage build.
#
# Layers:
#   1. `deps`    — pnpm install with workspace package.json manifests.
#                  Cached aggressively: a code change without manifest
#                  change reuses this layer.
#   2. `build`   — full source copy + per-app builds (web bundles + api
#                  Bun build + bot + worker).
#   3. `runtime` — minimal Bun image with only the compiled artifacts
#                  and node_modules. EXPOSE 3000; HEALTHCHECK hits
#                  /health/live.
#
# Bun image carries Node.js already (oven/bun:*-alpine has node + npm)
# so we install pnpm via corepack rather than apk-installing it
# separately. That saves ~80 MB versus the previous `apk add nodejs
# npm + npm i -g pnpm`.

# ---- 1. dependency install ----
FROM oven/bun:1.1.38-alpine AS deps
WORKDIR /app
# corepack is shipped with Node.js inside the bun-alpine base image.
# `prepare --activate` pins pnpm to the version we use locally so the
# image matches lockfile expectations.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/bot/package.json apps/bot/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/i18n/package.json packages/i18n/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/ui/package.json packages/ui/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile

# ---- 2. build packages + apps ----
FROM deps AS build
WORKDIR /app
COPY . .
# All four apps are built — earlier the Dockerfile only built api+web
# and the bot/worker compose services died at startup with
# "ENOENT apps/bot/dist/main.js". M3.18 fix.
RUN pnpm --filter @compass/web build
RUN pnpm --filter @compass/api build
RUN pnpm --filter @compass/bot build
RUN pnpm --filter @compass/worker build

# ---- 3. runtime ----
FROM oven/bun:1.1.38-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1
CMD ["bun", "run", "apps/api/dist/main.js"]
