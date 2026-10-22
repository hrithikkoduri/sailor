# syntax=docker/dockerfile:1

# One image, two commands: `serve` (HTTP + SSE + dashboard) and `worker`.
#
# The server runs TypeScript directly through tsx. That is deliberate for now:
# it keeps the image identical to `npm run dev` and avoids a second build
# pipeline. When the server gets a compiled build, swap the CMD for `node
# apps/server/dist/cli.js` and prune dev dependencies.
#
FROM node:22-bookworm-slim AS base
WORKDIR /app

# --- dependencies -------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci

# --- build the dashboard ------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build -w apps/dashboard

# --- runtime ------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/src ./apps/server/src
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/dashboard/package.json ./apps/dashboard/package.json
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist

ENV SAILOR_DASHBOARD_DIST=/app/apps/dashboard/dist
EXPOSE 8787

# `docker run <image>` starts the HTTP service; override the last argument with
# `worker` for the queue consumer, and `migrate` for a one-off schema update.
ENTRYPOINT ["./node_modules/.bin/tsx", "apps/server/src/cli.ts"]
CMD ["serve"]
