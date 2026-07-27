import type { UsageEvent } from "./schema/event.js";

/** Content retention modes for the privacy gate / ship payload. */
export type ContentMode = "off" | "local" | "cloud_ttl";

/**
 * Prepare an event for shipping based on content mode.
 * - `off` / `local`: strip content (local mode keeps content only on-device; ship shape has none)
 * - `cloud_ttl`: keep content for cloud retention with TTL
 */
export function applyPrivacy(event: UsageEvent, mode: ContentMode): UsageEvent {
  const cloned: UsageEvent = {
    ...event,
    features: { ...event.features },
    content: event.content
      ? {
          requestBody: event.content.requestBody,
          responseBody: event.content.responseBody,
        }
      : undefined,
  };

  if (mode === "off" || mode === "local") {
    delete cloned.content;
    cloned.hasContent = false;
  }
  // cloud_ttl: keep content and hasContent as-is

  return cloned;
}
