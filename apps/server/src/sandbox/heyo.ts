/**
 * Sailor's provider factory — the ONE place that translates `loadConfig()`
 * into an Anchor sandbox provider.
 *
 * Products own this wiring (which backend, which image, which credentials);
 * Anchor owns the mechanics. A future backend joins as another branch here
 * and nothing else in Sailor changes.
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import { heyo } from "anchor-ai-sdk/sandbox/heyo";
import { loadConfig } from "../config.js";

export function heyoProvider(
  cfg: ReturnType<typeof loadConfig>,
): SandboxProvider {
  return heyo({
    token: cfg.heyo.token ?? "",
    server: cfg.heyo.server,
    namespace: cfg.heyo.namespace,
    ...(cfg.heyo.imageStore ? { imageStore: cfg.heyo.imageStore } : {}),
    image: cfg.heyo.image,
    imageKind: cfg.heyo.imageKind,
    ...(cfg.heyo.imageRepo ? { imageRepo: cfg.heyo.imageRepo } : {}),
    ...(cfg.heyo.imageRef ? { imageRef: cfg.heyo.imageRef } : {}),
    ...(cfg.heyo.imageDockerfile
      ? { imageDockerfile: cfg.heyo.imageDockerfile }
      : {}),
    ...(cfg.heyo.imageAuth ? { imageAuth: cfg.heyo.imageAuth } : {}),
    ...(cfg.heyo.buildSecretRefresh !== undefined
      ? { buildSecretRefresh: cfg.heyo.buildSecretRefresh }
      : {}),
    ...(cfg.heyo.imageSizeMb ? { imageSizeMb: cfg.heyo.imageSizeMb } : {}),
    sizeClass: cfg.heyo.sizeClass,
    diskSizeGb: cfg.heyo.diskSizeGb,
  });
}
