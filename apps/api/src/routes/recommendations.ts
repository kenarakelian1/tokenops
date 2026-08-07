import { Hono } from "hono";
import { backtest } from "@tokenops/shared";
import { requireUser } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";
import type { ClerkVerifier } from "../auth/clerk.js";
import type {
  Recommendation,
  RecommendationStatus,
  UsageEventRow,
} from "../db/schema.js";
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

/** `EventsRepo.listEvents`' hard per-call maximum (see events-repo.ts's clamp). */
export const EVENTS_PAGE_SIZE = 1000;

/**
 * Hard ceiling on how many events a single back-test call will scan.
 *
 * 20,000 events is roughly 220 events/day sustained for the entire 90-day
 * window — well above realistic coding-agent request volumes for a single
 * account — while bounding worst-case latency to 20 sequential
 * EVENTS_PAGE_SIZE round trips. A pathological account past this ceiling
 * gets `truncated: true` instead of an unbounded scan.
 */
export const MAX_BACKTEST_EVENTS = 20_000;

/**
 * Fetch every event in [startIso, endIso], paginating past `listEvents`'
 * default single-page limit. An unpaginated call silently returns only the
 * newest ~100-1000 rows (repo default/clamp), which would make a 30- or
 * 90-day back-test report on a fraction of the window while presenting the
 * figure as complete — the exact failure this endpoint exists to prevent.
 *
 * `listEvents` only supports newest-first order, so this walks a `to`
 * cursor backward to the oldest timestamp seen in the previous page. `to`
 * is inclusive, so the next page re-fetches any row exactly at that
 * boundary instant; deduping by `eventId` is what keeps a row that shares
 * its timestamp with the page boundary from being dropped OR double-counted
 * (double-counting would silently inflate a rule's `hits`, which is worse
 * than under-counting for an endpoint whose whole purpose is credibility).
 *
 * Stops at `maxEvents` (default `MAX_BACKTEST_EVENTS`) and reports
 * `truncated` only when a probe fetch past the cap confirms there really is
 * more data beyond it — a window whose true size happens to land exactly on
 * the cap must still report `truncated: false`. `pageSize` and `maxEvents`
 * are injectable (defaulting to the production constants above) purely so
 * tests can exercise the cursor/dedupe/probe logic at small, fast sizes
 * instead of seeding tens of thousands of rows.
 */
export async function fetchWindowEvents(
  repo: EventsRepo,
  userId: string,
  startIso: string,
  endIso: string,
  options: { pageSize?: number; maxEvents?: number } = {},
): Promise<{ rows: UsageEventRow[]; truncated: boolean }> {
  const pageSize = options.pageSize ?? EVENTS_PAGE_SIZE;
  const maxEvents = options.maxEvents ?? MAX_BACKTEST_EVENTS;

  const seen = new Set<string>();
  const rows: UsageEventRow[] = [];
  let cursorTo = endIso;

  while (rows.length < maxEvents) {
    const page = await repo.listEvents(userId, {
      from: startIso,
      to: cursorTo,
      limit: pageSize,
    });
    if (page.length === 0) {
      return { rows, truncated: false }; // window exhausted, nothing left
    }

    let addedAny = false;
    for (const row of page) {
      if (seen.has(row.eventId)) continue;
      seen.add(row.eventId);
      rows.push(row);
      addedAny = true;
    }

    if (page.length < pageSize) {
      return { rows, truncated: false }; // this page didn't fill — nothing older remains
    }
    if (!addedAny) {
      // A full page that added nothing new means every row in it was
      // already seen — a same-instant cluster exactly straddling the
      // cursor with no forward progress possible. Stop rather than loop.
      return { rows, truncated: false };
    }

    cursorTo = page[page.length - 1]!.timestamp.toISOString();
  }

  // Hit the cap with more of the window potentially unread — confirm there
  // really is more beyond it rather than guessing.
  const probe = await repo.listEvents(userId, {
    from: startIso,
    to: cursorTo,
    limit: pageSize,
  });
  const hasMore = probe.some((row) => !seen.has(row.eventId));
  return { rows, truncated: hasMore };
}

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

  const { rows, truncated } = await fetchWindowEvents(
    repo,
    userId,
    startIso,
    endIso,
  );
  const events = rows
    .map(rowToUsageEvent)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const byModel = await repo.modelWindowTotals(userId, startIso, endIso);

  // One window spanning the whole period, so every aggregate-grain row is
  // priced at a single instant (`endIso`) rather than at the rates in force
  // when each day's traffic happened — a 90-day run prices all 90 days off
  // today's rate card. Each row says which it is via `pricingBasis`
  // ("window-end" here, "event-timestamp" for the request grain); see
  // backtest.ts. Splitting this into rate-stable sub-windows is the fix, and
  // is deliberately not done here.
  const result = backtest({
    events,
    windows: [{ start: startIso, end: endIso, byModel }],
    windowStart: startIso,
    windowEnd: endIso,
  });

  return c.json({ ...result, eventsScanned: rows.length, truncated });
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
