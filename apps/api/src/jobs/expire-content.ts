import { inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { eventContent, usageEvents } from "../db/schema.js";

/** Default raw event retention when HOSTED_LIMITS is enabled. */
export const DEFAULT_HOSTED_RETENTION_DAYS = 30;

export const HOUR_MS = 60 * 60 * 1000;

export type ExpireContentResult = {
  contentDeleted: number;
  eventsDeleted: number;
  retentionDays: number | null;
};

/**
 * Resolve raw-event retention in days.
 * - `RAW_EVENT_RETENTION_DAYS` set → use that value (0 = delete all historical)
 * - else `HOSTED_LIMITS=true` → 30 days
 * - else → unlimited (null)
 */
export function resolveRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.RAW_EVENT_RETENTION_DAYS;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error(
        `RAW_EVENT_RETENTION_DAYS must be a non-negative integer, got: ${raw}`,
      );
    }
    return n;
  }
  if (env.HOSTED_LIMITS === "true") {
    return DEFAULT_HOSTED_RETENTION_DAYS;
  }
  return null;
}

/**
 * 1. Delete expired event_content rows; clear usage_events.has_content for those ids.
 * 2. If retention is configured, delete usage_events older than the cutoff
 *    (event_content cascades). Aggregates are left untouched.
 */
export async function expireContent(
  db: Db,
  options: {
    now?: Date;
    retentionDays?: number | null;
  } = {},
): Promise<ExpireContentResult> {
  const now = options.now ?? new Date();
  const retentionDays =
    options.retentionDays !== undefined
      ? options.retentionDays
      : resolveRetentionDays();

  let contentDeleted = 0;
  let eventsDeleted = 0;

  await db.transaction(async (tx) => {
    const expired = await tx
      .select({ eventId: eventContent.eventId })
      .from(eventContent)
      .where(lt(eventContent.expiresAt, now));

    if (expired.length > 0) {
      const ids = expired.map((r) => r.eventId);
      await tx
        .delete(eventContent)
        .where(inArray(eventContent.eventId, ids));
      await tx
        .update(usageEvents)
        .set({ hasContent: false })
        .where(inArray(usageEvents.eventId, ids));
      contentDeleted = ids.length;
    }

    if (retentionDays != null) {
      const cutoff = new Date(
        now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
      );
      const deleted = await tx
        .delete(usageEvents)
        .where(lt(usageEvents.timestamp, cutoff))
        .returning({ eventId: usageEvents.eventId });
      eventsDeleted = deleted.length;
    }
  });

  return { contentDeleted, eventsDeleted, retentionDays };
}

/**
 * Run expire once and log. Swallows errors so the interval stays alive.
 */
export async function runExpireContentOnce(
  db: Db,
  log: Pick<Console, "info" | "error"> = console,
): Promise<ExpireContentResult | null> {
  try {
    const result = await expireContent(db);
    log.info(
      `expire-content: contentDeleted=${result.contentDeleted} eventsDeleted=${result.eventsDeleted} retentionDays=${result.retentionDays ?? "unlimited"}`,
    );
    return result;
  } catch (err) {
    log.error("expire-content job failed", err);
    return null;
  }
}

/**
 * Schedule hourly expire job. Runs once immediately, then every `intervalMs`.
 * Returns the interval handle (unref'd so it does not keep the process alive alone).
 */
export function startExpireContentJob(
  db: Db,
  intervalMs: number = HOUR_MS,
  log: Pick<Console, "info" | "error"> = console,
): NodeJS.Timeout {
  void runExpireContentOnce(db, log);
  const handle = setInterval(() => {
    void runExpireContentOnce(db, log);
  }, intervalMs);
  // Allow process to exit if nothing else is keeping it open (tests).
  if (typeof handle.unref === "function") {
    handle.unref();
  }
  return handle;
}
