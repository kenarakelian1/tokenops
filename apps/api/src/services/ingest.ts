import {
  IngestBatchSchema,
  type IngestBatch,
  type UsageEvent,
} from "@tokenops/shared";
import { dayKeyFromTimestamp } from "./aggregates.js";
import type { EventsRepo } from "./events-repo.js";
import { applyRulesForEvent } from "./rules-runner.js";

export const CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_HOSTED_MACHINES = 3;
export const SESSION_CONTEXT_LIMIT = 20;

export type IngestResult = {
  accepted: number;
  duplicates: number;
};

export class MachineLimitError extends Error {
  readonly code = "machine_limit" as const;
  constructor(message = "machine limit reached") {
    super(message);
    this.name = "MachineLimitError";
  }
}

export type IngestOptions = {
  /** When true, max 3 distinct machines per user. */
  hostedLimits?: boolean;
};

/**
 * Validate and ingest a batch of usage events for a user.
 * Idempotent on event_id: duplicates are counted and skipped (no aggregate bump).
 */
export async function ingest(
  repo: EventsRepo,
  userId: string,
  batch: IngestBatch | unknown,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const parsed =
    typeof batch === "object" &&
    batch !== null &&
    "events" in batch &&
    Array.isArray((batch as IngestBatch).events)
      ? IngestBatchSchema.parse(batch)
      : IngestBatchSchema.parse(batch);

  const hosted =
    options.hostedLimits ?? process.env.HOSTED_LIMITS === "true";

  let accepted = 0;
  let duplicates = 0;

  for (const event of parsed.events) {
    if (hosted) {
      await assertMachineAllowed(repo, userId, event.machineId);
    }

    const status = await repo.insertEventIfNew(userId, event);
    if (status === "duplicate") {
      duplicates += 1;
      continue;
    }
    accepted += 1;

    if (event.content != null && event.hasContent) {
      const expiresAt = new Date(Date.now() + CONTENT_TTL_MS);
      await repo.insertEventContent(event.eventId, event.content, expiresAt);
    }

    const day = dayKeyFromTimestamp(event.timestamp);
    const cost = event.costUsd ?? 0;
    await repo.bumpDailyAggregate(
      userId,
      day,
      event.machineId,
      event.app,
      event.model,
      event.inputTokens,
      event.outputTokens,
      cost,
    );

    const sessionContext = await loadSessionContext(repo, userId, event);
    await applyRulesForEvent(repo, userId, event, sessionContext);

    await repo.upsertMachine(userId, event.machineId, event.machineName);
  }

  return { accepted, duplicates };
}

async function loadSessionContext(
  repo: EventsRepo,
  userId: string,
  event: UsageEvent,
): Promise<UsageEvent[]> {
  if (!event.sessionId) return [];
  const rows = await repo.listSessionEvents(
    userId,
    event.sessionId,
    SESSION_CONTEXT_LIMIT + 1,
    new Date(event.timestamp),
  );
  // listSessionEvents is newest-first; reverse to chronological ASC so
  // context_bloat can use [0] as the early-session baseline.
  return rows
    .filter((e) => e.eventId !== event.eventId)
    .slice(0, SESSION_CONTEXT_LIMIT)
    .reverse();
}

export async function assertMachineAllowed(
  repo: EventsRepo,
  userId: string,
  machineId: string,
): Promise<void> {
  const known = await repo.hasMachine(userId, machineId);
  if (known) return;
  const count = await repo.countMachines(userId);
  if (count >= MAX_HOSTED_MACHINES) {
    throw new MachineLimitError();
  }
}

/**
 * Heartbeat: upsert machine last_seen + queue depth; enforce hosted machine limit.
 */
export async function recordHeartbeat(
  repo: EventsRepo,
  userId: string,
  body: { machineId: string; machineName: string; queueDepth: number },
  options: IngestOptions = {},
): Promise<void> {
  const hosted =
    options.hostedLimits ?? process.env.HOSTED_LIMITS === "true";
  if (hosted) {
    await assertMachineAllowed(repo, userId, body.machineId);
  }
  await repo.upsertMachine(
    userId,
    body.machineId,
    body.machineName,
    body.queueDepth,
  );
}
