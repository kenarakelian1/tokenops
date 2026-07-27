import { createHash } from "node:crypto";

/**
 * Stable idempotent event id: SHA-256 hex of
 * `machineId|app|providerRequestId|fingerprint|timeBucketSec`.
 * Missing providerRequestId is treated as empty string.
 */
export function buildEventId(parts: {
  machineId: string;
  app: string;
  providerRequestId?: string;
  fingerprint: string;
  timeBucketSec: number;
}): string {
  const material = [
    parts.machineId,
    parts.app,
    parts.providerRequestId ?? "",
    parts.fingerprint,
    String(parts.timeBucketSec),
  ].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}
