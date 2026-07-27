import {
  applyPrivacy,
  type ContentMode,
  type UsageEvent,
} from "@tokenops/shared";
import type { TokenOpsConfig } from "./config.js";

/**
 * Apply privacy gate for cloud ship shape using shared `applyPrivacy`.
 * - off / local: strip content from payload
 * - cloud_ttl: keep content for cloud retention
 */
export function applyEventPrivacy(
  event: UsageEvent,
  mode: ContentMode,
): UsageEvent {
  return applyPrivacy(event, mode);
}

/** Convenience: privacy from agent config. */
export function prepareEventForShip(
  event: UsageEvent,
  config: TokenOpsConfig,
): UsageEvent {
  return applyPrivacy(event, config.privacy.contentMode);
}
