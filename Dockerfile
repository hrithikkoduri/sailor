# syntax=docker/dockerfile:1

# One image, two commands: `serve` (HTTP + SSE + dashboard) and `worker`.
# The build compiles contracts, the dashboard, and the server; the runtime
# stage installs production dependencies only and runs plain Node.

FROM node:22-bookworm-slim AS base
WORKDIR /app

# --- dependencies -------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci

# --- build --------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build -w packages/contracts \
 && npm run build -w apps/dashboard \
 && npm run build -w apps/server

# --- runtime ------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist

ENV SAILOR_DASHBOARD_DIST=/app/apps/dashboard/dist
EXPOSE 8787

# `docker run <image>` starts the HTTP service; override the last argument with
# `worker` for the queue consumer, and `migrate` for a one-off schema update.
ENTRYPOINT ["node", "apps/server/dist/cli.js"]
CMD ["serve"]
