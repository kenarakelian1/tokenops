import { Hono } from "hono";
import { requireSession } from "../auth/middleware.js";
import type { Recommendation, RecommendationStatus } from "../db/schema.js";
import type { EventsRepo } from "../services/events-repo.js";

export type RecommendationsRouteVariables = {
  eventsRepo: EventsRepo;
  userId: string;
};

function recToDto(row: Recommendation) {
  return {
    id: row.id,
    ruleId: row.ruleId,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    estimatedWastedTokens: row.estimatedWastedTokens,
    estimatedWastedUsd:
      row.estimatedWastedUsd != null ? Number(row.estimatedWastedUsd) : null,
    eventIds: row.eventIds,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export const recommendationsRoutes = new Hono<{
  Variables: RecommendationsRouteVariables;
}>();

/** Session: list recommendations (default open). */
recommendationsRoutes.get("/", requireSession, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const statusParam = c.req.query("status");
  let status: RecommendationStatus | undefined = "open";
  if (statusParam === "dismissed") status = "dismissed";
  else if (statusParam === "all") status = undefined;
  else if (statusParam === "open") status = "open";
  else if (statusParam != null && statusParam !== "") {
    return c.json({ error: "invalid_status" }, 400);
  }

  const rows = await repo.listRecommendations(userId, status);
  return c.json({ recommendations: rows.map(recToDto) });
});

/** Session: dismiss a recommendation. */
recommendationsRoutes.post("/:id/dismiss", requireSession, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const ok = await repo.dismissRecommendation(userId, id);
  if (!ok) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true });
});
