import { Hono } from "hono";
import { backtest } from "@tokenops/shared";
import { requireUser } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";
import type { ClerkVerifier } from "../auth/clerk.js";
import type { Recommendation, RecommendationStatus } from "../db/schema.js";
import { rowToUsageEvent, type EventsRepo } from "../services/events-repo.js";

export type RecommendationsRouteVariables = {
  eventsRepo: EventsRepo;
  authRepo: AuthRepo;
  clerkVerifier: ClerkVerifier;
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
    counterfactual: row.counterfactual ?? null,
    assumption: row.assumption ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `window` query param -> trailing day count. Unknown values are rejected, not defaulted. */
const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const recommendationsRoutes = new Hono<{
  Variables: RecommendationsRouteVariables;
}>();

/** Dashboard: list recommendations (default open). */
recommendationsRoutes.get("/", requireUser, async (c) => {
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

/**
 * Replay the current rules over stored history. Rejects an unknown window
 * rather than falling back silently, matching how the list route rejects an
 * unknown `status` — a typo'd window must not quietly return a different
 * period than the caller asked for.
 *
 * Registered before `/:id/dismiss` so Hono never matches this literal path
 * as an `:id` parameter.
 */
recommendationsRoutes.get("/backtest", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const windowParam = c.req.query("window") ?? "30d";
  const days = WINDOW_DAYS[windowParam];
  if (days === undefined) {
    return c.json({ error: "invalid_window" }, 400);
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const rows = await repo.listEvents(userId, { from: startIso, to: endIso });
  const events = rows
    .map(rowToUsageEvent)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const byModel = await repo.modelWindowTotals(userId, startIso, endIso);

  const result = backtest({
    events,
    windows: [{ start: startIso, end: endIso, byModel }],
    windowStart: startIso,
    windowEnd: endIso,
  });

  return c.json(result);
});

/** Dashboard: dismiss a recommendation. */
recommendationsRoutes.post("/:id/dismiss", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const ok = await repo.dismissRecommendation(userId, id);
  if (!ok) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ ok: true });
});
