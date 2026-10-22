/**
 * The webhook door: signature check and delivery headers, then the GitHub
 * service decides what the event means. The service returns a plain
 * {status, body}; nothing in it knows about Hono.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { handleGithubWebhook, type WebhookDeps } from "../../services/github/webhook.js";

export function createWebhookRoutes(deps: WebhookDeps) {
  const app = new Hono();

  app.post("/webhooks/github", async (c) => {
    const result = await handleGithubWebhook(deps, {
      rawBody: await c.req.text(),
      eventName: c.req.header("x-github-event") ?? "",
      deliveryId: c.req.header("x-github-delivery") ?? "",
      signature: c.req.header("x-hub-signature-256"),
    });
    return c.json(result.body as Record<string, unknown>, result.status as ContentfulStatusCode);
  });

  return app;
}
