import { Hono } from "hono";
import { z } from "zod";
import { requirePat } from "../auth/middleware.js";
import type { EventsRepo } from "../services/events-repo.js";
import { MachineLimitError, recordHeartbeat } from "../services/ingest.js";

export type HeartbeatsRouteVariables = {
  eventsRepo: EventsRepo;
  userId: string;
  hostedLimits: boolean;
};

const heartbeatSchema = z.object({
  machineId: z.string().min(1),
  machineName: z.string().min(1),
  queueDepth: z.number().int().nonnegative(),
});

export const heartbeatsRoutes = new Hono<{
  Variables: HeartbeatsRouteVariables;
}>();

/** PAT: machine heartbeat (last seen + queue depth). */
heartbeatsRoutes.post("/", requirePat, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const hostedLimits = c.get("hostedLimits");
  const body = await c.req.json().catch(() => null);
  const parsed = heartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      400,
    );
  }

  try {
    await recordHeartbeat(repo, userId, parsed.data, { hostedLimits });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof MachineLimitError) {
      return c.json({ error: "machine_limit" }, 403);
    }
    throw err;
  }
});
