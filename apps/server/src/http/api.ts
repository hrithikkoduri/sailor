/**
 * Composition of the dashboard's REST + SSE surface.
 *
 * The HTTP edge is deliberately thin: each resource has its own route module,
 * and shared auth/visibility helpers come from `context.ts`. Business rules
 * live under `src/services/`.
 */
import { Hono } from "hono";
import { createStreamHub } from "./stream.js";
import { createApiContext, type ApiDeps } from "./context.js";
import { createEventRoutes } from "./routes/events.js";
import { createRunRoutes } from "./routes/runs.js";
import { createThreadRoutes } from "./routes/threads.js";
import { createWorkspaceRoutes } from "./routes/workspace.js";

export type { ApiDeps } from "./context.js";

export function createApiRoutes(deps: ApiDeps): Hono {
  const hub = deps.hub ?? createStreamHub();
  const resolved = { ...deps, hub, log: deps.log ?? (() => undefined) };
  const ctx = createApiContext(resolved);
  const app = new Hono();

  app.route("/", createWorkspaceRoutes(resolved));
  app.route("/", createThreadRoutes(ctx));
  app.route("/", createRunRoutes(ctx));
  app.route("/", createEventRoutes(ctx));

  return app;
}
