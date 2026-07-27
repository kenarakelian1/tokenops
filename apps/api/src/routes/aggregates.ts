import { Hono } from "hono";
import { requireSession } from "../auth/middleware.js";
import { listAggregates } from "../services/aggregates.js";
import type { EventsRepo } from "../services/events-repo.js";

export type AggregatesRouteVariables = {
  eventsRepo: EventsRepo;
  userId: string;
};

export const aggregatesRoutes = new Hono<{
  Variables: AggregatesRouteVariables;
}>();

/** Session: daily aggregates by day/machine/app/model. */
aggregatesRoutes.get("/", requireSession, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const rows = await listAggregates(repo, userId, {
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
  });
  return c.json({ aggregates: rows });
});
