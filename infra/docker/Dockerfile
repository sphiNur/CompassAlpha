# syntax=docker/dockerfile:1.7

# ---- 1. dependency install ----
FROM oven/bun:1.1.38-alpine AS deps
WORKDIR /app
RUN apk add --no-cache nodejs npm
RUN npm install -g pnpm@9.12.0
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
RUN pnpm --filter @compass/web build
RUN pnpm --filter @compass/api build

# ---- 3. runtime ----
FROM oven/bun:1.1.38-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1
CMD ["bun", "run", "apps/api/dist/main.js"]
