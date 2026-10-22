/**
 * Pending-event actions.
 *
 *   interject — decision #28's explicit override: a pending event forces the
 *               active run to stop and become the next turn.
 *   cancel    — withdraw a queued dashboard message nothing has consumed.
 */
import { Hono } from "hono";
import { findEvent } from "../../services/threads/inbox.js";
import { interjectEvent, withdrawEvent } from "../../services/threads/inbox-actions.js";
import type { ApiContext } from "../context.js";

export function createEventRoutes(ctx: ApiContext) {
  const { deps } = ctx;
  const app = new Hono();

  const loadEvent = async (rawId: string) => {
    let eventId: bigint;
    try {
      eventId = BigInt(rawId);
    } catch {
      return { error: "bad event id" as const };
    }
    return { event: await findEvent(deps.db, eventId) };
  };

  app.post("/api/events/:id/interject", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;

    const { error, event } = await loadEvent(c.req.param("id"));
    if (error) return c.json({ error }, 400);
    if (!event?.threadId) return c.json({ error: "event not found" }, 404);
    const thread = await ctx.loadThread(event.threadId);
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "event not found" }, 404);

    const result = await interjectEvent(
      { db: deps.db, queues: deps.queues, ...(deps.hub ? { hub: deps.hub } : {}) },
      thread,
      event,
    );
    if (!result.ok) return c.json(result, 409);
    deps.log(`api: interject on thread ${thread.id} → ${result.action}`);
    return c.json(result);
  });

  app.post("/api/events/:id/cancel", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;

    const { error, event } = await loadEvent(c.req.param("id"));
    if (error) return c.json({ error }, 400);
    if (!event?.threadId) return c.json({ error: "event not found" }, 404);
    const thread = await ctx.loadThread(event.threadId);
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "event not found" }, 404);

    const result = await withdrawEvent(deps.db, event);
    if (!result.ok) return c.json(result, 409);
    deps.hub.notify(thread.id);
    deps.log(`api: withdrew queued message event ${event.id} on thread ${thread.id}`);
    return c.json({ ok: true, action: "cancelled" });
  });

  return app;
}
