import { Hono } from "hono";
import { IngestBatchSchema } from "@tokenops/shared";
import { requirePat, requireUser } from "../auth/middleware.js";
import type { EventsRepo } from "../services/events-repo.js";
import { ingest, MachineLimitError } from "../services/ingest.js";
import type { UsageEventRow } from "../db/schema.js";

export type EventsRouteVariables = {
  eventsRepo: EventsRepo;
  userId: string;
  hostedLimits: boolean;
};

function eventToDto(row: UsageEventRow) {
  return {
    eventId: row.eventId,
    timestamp: row.timestamp.toISOString(),
    machineId: row.machineId,
    machineName: row.machineName,
    app: row.app,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd != null ? Number(row.costUsd) : null,
    latencyMs: row.latencyMs,
    sessionId: row.sessionId,
    features: row.features,
    hasContent: row.hasContent,
  };
}

export const eventsRoutes = new Hono<{ Variables: EventsRouteVariables }>();

/** PAT: batch ingest usage events. */
eventsRoutes.post("/", requirePat, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const hostedLimits = c.get("hostedLimits");
  const body = await c.req.json().catch(() => null);
  const parsed = IngestBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      400,
    );
  }

  try {
    const result = await ingest(repo, userId, parsed.data, { hostedLimits });
    return c.json(result);
  } catch (err) {
    if (err instanceof MachineLimitError) {
      return c.json({ error: "machine_limit" }, 403);
    }
    throw err;
  }
});

/** Dashboard: filtered event list. */
eventsRoutes.get("/", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const rows = await repo.listEvents(userId, {
    machineId: c.req.query("machineId") ?? undefined,
    app: c.req.query("app") ?? undefined,
    model: c.req.query("model") ?? undefined,
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return c.json({ events: rows.map(eventToDto) });
});
