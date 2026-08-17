import { Hono } from "hono";
import {
  detectCandidateWalls,
  runForecast,
  toTimedUnits,
  trailingWindow,
  WINDOW_HOURS,
  type LimitObservationStatus,
  type LimitProvenance,
  type TimedUnit,
  type WallCandidate,
  type WindowKind,
} from "@tokenops/shared";
import { requireUser } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";
import type { ClerkVerifier } from "../auth/clerk.js";
import type { EventsRepo } from "../services/events-repo.js";

export type ForecastRouteVariables = {
  eventsRepo: EventsRepo;
  authRepo: AuthRepo;
  clerkVerifier: ClerkVerifier;
  userId: string;
};

/** History fetched for the forecast. Enough for MIN_HISTORY_DAYS plus margin. */
export const FORECAST_HISTORY_DAYS = 45;

const VALID_WINDOW_KINDS: readonly WindowKind[] = ["session_5h", "weekly_7d"];

function isWindowKind(value: unknown): value is WindowKind {
  return (
    typeof value === "string" &&
    (VALID_WINDOW_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A dismissed wall candidate is stored as a `limit_observations` row with
 * `status: "dismissed"` and `provenance: "inferred"`. `detectCandidateWalls`
 * keys a candidate's id purely on the gap's opening timestamp —
 * `wall:<startsAt ISO>` — so the round trip only has to carry that one
 * instant: `observedAt` holds `startsAt` verbatim, and prefixing it back with
 * `wall:` reconstructs exactly the id `detectCandidateWalls` would produce
 * for the same gap. `windowKind` and `unitsInWindow` are unused for this
 * status (every `WallCandidate.windowKind` is `weekly_7d`; there is no
 * meaningful "units" for a dismissal) but are still required fields on the
 * row, so they are filled with fixed placeholders. Reusing this table avoids
 * a second store for what is the same concept: a judgement the user has made
 * about a moment in their history.
 */
const DISMISSAL_ID_PREFIX = "wall:";

function candidateIdToObservedAt(id: string): string | null {
  if (!id.startsWith(DISMISSAL_ID_PREFIX)) return null;
  const isoPart = id.slice(DISMISSAL_ID_PREFIX.length);
  return Number.isNaN(Date.parse(isoPart)) ? null : isoPart;
}

function observedAtToCandidateId(observedAt: string): string {
  return `${DISMISSAL_ID_PREFIX}${observedAt}`;
}

/**
 * Guards the one invariant every write in this route must uphold: a ceiling
 * that is live (`status: "active"`) must always be one the user actually
 * declared. Two prior reviews flagged that neither `activeDeclaration` (in
 * `@tokenops/shared`, which selects the ceiling by `status === "active"`
 * alone) nor `insertLimitObservation` enforces this link on its own — this
 * route is the first code that writes observations at all, so the guarantee
 * has to hold here, at every call site that inserts one.
 */
export function assertActiveIsDeclared(observation: {
  status: LimitObservationStatus;
  provenance: LimitProvenance;
}): void {
  if (observation.status === "active" && observation.provenance !== "declared") {
    throw new Error(
      `refusing to write an active limit observation with provenance "${observation.provenance}" — active observations must be declared`,
    );
  }
}

/**
 * Detect candidate walls with a failure boundary: a bug in detection must
 * degrade the forecast to an empty candidate list rather than failing the
 * whole response, the same isolation `GET /v1/recommendations` gives its
 * `sessionCoverage` query. `detect` is injectable purely so tests can
 * exercise the degrade path with a fake that throws, the same pattern
 * `fetchWindowEvents` in recommendations.ts uses for `pageSize`/`maxEvents`.
 */
export function detectCandidatesSafely(
  sorted: TimedUnit[],
  nowMs: number,
  dismissedIds: string[],
  detect: typeof detectCandidateWalls = detectCandidateWalls,
): WallCandidate[] {
  try {
    return detect(sorted, nowMs, dismissedIds);
  } catch (err) {
    console.error("detectCandidateWalls failed; returning no candidates", err);
    return [];
  }
}

/** Supersede every currently-active observation for a window kind. */
async function supersedeActive(
  repo: EventsRepo,
  userId: string,
  windowKind: WindowKind,
): Promise<void> {
  const existing = await repo.listLimitObservations(userId);
  for (const o of existing) {
    if (o.windowKind === windowKind && o.status === "active") {
      await repo.setLimitObservationStatus(userId, o.id, "superseded");
    }
  }
}

export const forecastRoutes = new Hono<{ Variables: ForecastRouteVariables }>();

/** Panel: the forecast for both windows, plus any detected candidates. */
forecastRoutes.get("/v1/forecast", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const now = new Date();
  const since = new Date(
    now.getTime() - FORECAST_HISTORY_DAYS * 86_400_000,
  ).toISOString();

  const events = await repo.eventsSince(userId, since);
  const observations = await repo.listLimitObservations(userId);

  const forecast = runForecast(events, now.toISOString(), observations);

  const dismissedIds = observations
    .filter((o) => o.status === "dismissed")
    .map((o) => observedAtToCandidateId(o.observedAt));

  forecast.candidates = detectCandidatesSafely(
    toTimedUnits(events),
    now.getTime(),
    dismissedIds,
  );

  return c.json(forecast);
});

/**
 * "I hit my limit now": stamps `unitsInWindow` from the server's own ledger
 * rather than trusting the client — a declared ceiling is only meaningful if
 * it is the number TokenOps actually measured at that instant.
 */
forecastRoutes.post("/v1/limit-observations", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const windowKind = body["windowKind"];
  if (!isWindowKind(windowKind)) {
    return c.json({ error: "invalid_window_kind" }, 400);
  }

  const now = new Date();
  const since = new Date(
    now.getTime() - FORECAST_HISTORY_DAYS * 86_400_000,
  ).toISOString();
  const events = await repo.eventsSince(userId, since);
  const unitsInWindow = trailingWindow(
    toTimedUnits(events),
    now.getTime(),
    WINDOW_HOURS[windowKind],
  );

  await supersedeActive(repo, userId, windowKind);

  const toInsert = {
    windowKind,
    observedAt: now.toISOString(),
    unitsInWindow,
    provenance: "declared" as const,
    status: "active" as const,
  };
  assertActiveIsDeclared(toInsert);
  const observation = await repo.insertLimitObservation(userId, toInsert);

  return c.json({ observation });
});

/** Retire a previously declared/confirmed observation without replacing it. */
forecastRoutes.post(
  "/v1/limit-observations/:id/dismiss",
  requireUser,
  async (c) => {
    const repo = c.get("eventsRepo");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const ok = await repo.setLimitObservationStatus(userId, id, "dismissed");
    if (!ok) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ ok: true });
  },
);

/**
 * Confirm a detected candidate as a real limit hit. Candidates are not
 * persisted (they are recomputed on every `GET /v1/forecast`), so this
 * re-runs detection over the server's own event ledger and looks the
 * candidate up by id rather than trusting the client's copy of its
 * `windowKind`/`observedAt`/`unitsInWindow` — the same "never trust a
 * client-supplied figure" rule `POST /v1/limit-observations` follows, applied
 * here via re-derivation instead of re-measurement since a candidate is a
 * fact about history, not about "now". A `400` client body carrying those
 * fields is still accepted for callers that pass through the exact object
 * `GET /v1/forecast` returned, but only `id` is trusted.
 */
forecastRoutes.post("/v1/wall-candidates/confirm", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const id = body["id"];
  if (typeof id !== "string" || id.length === 0) {
    return c.json({ error: "invalid_id" }, 400);
  }

  const now = new Date();
  const since = new Date(
    now.getTime() - FORECAST_HISTORY_DAYS * 86_400_000,
  ).toISOString();
  const events = await repo.eventsSince(userId, since);
  const observations = await repo.listLimitObservations(userId);
  const dismissedIds = observations
    .filter((o) => o.status === "dismissed")
    .map((o) => observedAtToCandidateId(o.observedAt));

  const candidates = detectCandidatesSafely(
    toTimedUnits(events),
    now.getTime(),
    dismissedIds,
  );
  const candidate = candidates.find((cand) => cand.id === id);
  if (!candidate) {
    return c.json({ error: "not_found" }, 404);
  }

  await supersedeActive(repo, userId, candidate.windowKind);

  const toInsert = {
    windowKind: candidate.windowKind,
    observedAt: candidate.startsAt,
    unitsInWindow: candidate.unitsInWindow,
    provenance: "declared" as const,
    status: "active" as const,
  };
  assertActiveIsDeclared(toInsert);
  const observation = await repo.insertLimitObservation(userId, toInsert);

  return c.json({ observation });
});

/** Dismiss a detected candidate so it is never proposed again. */
forecastRoutes.post("/v1/wall-candidates/dismiss", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const id = body["id"];
  const observedAt =
    typeof id === "string" ? candidateIdToObservedAt(id) : null;
  if (observedAt === null) {
    return c.json({ error: "invalid_id" }, 400);
  }

  const toInsert = {
    windowKind: "weekly_7d" as const,
    observedAt,
    unitsInWindow: 0,
    provenance: "inferred" as const,
    status: "dismissed" as const,
  };
  assertActiveIsDeclared(toInsert);
  await repo.insertLimitObservation(userId, toInsert);

  return c.json({ ok: true });
});
