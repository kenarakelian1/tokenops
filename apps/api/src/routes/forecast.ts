import { Hono } from "hono";
import {
  detectCandidateWalls,
  runForecast,
  toTimedUnits,
  trailingWindow,
  WINDOW_HOURS,
  type TimedUnit,
  type WallCandidate,
  type WindowKind,
} from "@tokenops/shared";
import { requireUser } from "../auth/middleware.js";
import type { AuthRepo } from "../auth/repo.js";
import type { ClerkVerifier } from "../auth/clerk.js";
import {
  assertActiveIsDeclared,
  type EventsRepo,
} from "../services/events-repo.js";

// Re-exported so callers (and this file's own tests) that want the
// invariant guard don't need to know it now lives beside the write it
// guards, in events-repo.ts, rather than here.
export { assertActiveIsDeclared };

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
 * Parse a request body into a plain object, defaulting to `{}` for anything
 * that isn't one — including a body that fails to parse at all (`.catch`)
 * AND the one JSON value that parses successfully but still isn't a record:
 * a literal `null` body. Without this second check, `body["windowKind"]`
 * below would throw on `null` (property access on null) and surface as a
 * generic 500 instead of the same 400 every other malformed body gets.
 */
async function parseBody(req: { json(): Promise<unknown> }): Promise<
  Record<string, unknown>
> {
  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

/**
 * `detectCandidateWalls` keys a candidate's id purely on the gap's opening
 * timestamp — `wall:<startsAt ISO>` — so encoding a judgement about a
 * candidate only ever has to carry that one instant: `observedAt` holds
 * `startsAt` verbatim, and prefixing it back with `wall:` reconstructs
 * exactly the id `detectCandidateWalls` would produce for the same gap.
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
 * True when an observation should suppress its corresponding candidate id
 * from ever being (re-)proposed by `detectCandidateWalls`. Two shapes count,
 * and only two:
 *
 *   1. An explicit "no" — `status: "dismissed"`, `provenance: "inferred"` —
 *      written by `POST /v1/wall-candidates/dismiss` (via
 *      `insertDismissalMarker`). Permanent: nothing currently un-sets it.
 *   2. An explicit "yes" that is STILL STANDING — `status: "active"`,
 *      `provenance: "declared"` — written by `POST /v1/wall-candidates/confirm`.
 *      Deliberately NOT permanent the way (1) is: if the user later retracts
 *      this specific confirmation via `POST /v1/limit-observations/:id/dismiss`,
 *      that call only flips `status` to `"dismissed"` and leaves `provenance:
 *      "declared"` untouched — which matches NEITHER shape here, so
 *      suppression lifts and the candidate is proposed again.
 *
 * This single predicate is what makes "a confirmed candidate is retired
 * while confirmed" and "retracting a confirmation and dismissing a proposal
 * are different acts" both true at once, without `confirm` having to write a
 * second, independent marker row that would outlive — and fight with — a
 * later retraction: a separate permanent marker plus a revocable active row
 * would leave the marker suppressing the candidate forever regardless of
 * what happens to the active row, which is exactly the bug this function
 * exists to avoid reintroducing.
 */
function suppressesCandidate(o: { status: string; provenance: string }): boolean {
  return (
    (o.status === "dismissed" && o.provenance === "inferred") ||
    (o.status === "active" && o.provenance === "declared")
  );
}

/**
 * Insert the "never propose this candidate again, until explicitly
 * undone" marker described in `suppressesCandidate` (shape 1). Used only by
 * `POST /v1/wall-candidates/dismiss` — an explicit rejection, the one
 * suppression shape meant to be permanent. Confirming does NOT call this;
 * see `suppressesCandidate`'s doc comment for why a second marker would
 * conflict with a later retraction.
 */
async function insertDismissalMarker(
  repo: EventsRepo,
  userId: string,
  observedAt: string,
): Promise<void> {
  await repo.insertLimitObservation(userId, {
    windowKind: "weekly_7d",
    observedAt,
    unitsInWindow: 0,
    provenance: "inferred",
    status: "dismissed",
  });
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
    .filter(suppressesCandidate)
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

  const body = await parseBody(c.req);
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

  // insertLimitObservation itself enforces status:"active" =>
  // provenance:"declared" (see events-repo.ts's assertActiveIsDeclared); the
  // literals below already satisfy it.
  const observation = await repo.insertLimitObservation(userId, {
    windowKind,
    observedAt: now.toISOString(),
    unitsInWindow,
    provenance: "declared",
    status: "active",
  });

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
 *
 * Answering a candidate's question — either way — must retire it: once this
 * writes the `active`/`declared` observation below, `suppressesCandidate`'s
 * shape 2 keeps this same candidate id out of every subsequent
 * `GET /v1/forecast`'s (and this route's own) candidate list for as long as
 * that declaration stands, so the panel stops re-asking and a second confirm
 * of the same id 404s (it is no longer a live candidate) instead of
 * appending another row that supersedes the last.
 */
forecastRoutes.post("/v1/wall-candidates/confirm", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const body = await parseBody(c.req);
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
    .filter(suppressesCandidate)
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

  const observation = await repo.insertLimitObservation(userId, {
    windowKind: candidate.windowKind,
    observedAt: candidate.startsAt,
    unitsInWindow: candidate.unitsInWindow,
    provenance: "declared",
    status: "active",
  });

  return c.json({ observation });
});

/** Dismiss a detected candidate so it is never proposed again. */
forecastRoutes.post("/v1/wall-candidates/dismiss", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");

  const body = await parseBody(c.req);
  const id = body["id"];
  const observedAt =
    typeof id === "string" ? candidateIdToObservedAt(id) : null;
  if (observedAt === null) {
    return c.json({ error: "invalid_id" }, 400);
  }

  await insertDismissalMarker(repo, userId, observedAt);

  return c.json({ ok: true });
});
