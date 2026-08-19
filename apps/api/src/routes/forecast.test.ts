import { beforeEach, describe, expect, it } from "vitest";
import { toTimedUnits, type UsageEvent } from "@tokenops/shared";
import { createApp } from "../app.js";
import { createFakeVerifier } from "../auth/clerk.js";
import { createMemoryAuthRepo } from "../auth/repo.js";
import { createMemoryEventsRepo } from "../services/events-repo.js";
import { assertActiveIsDeclared, detectCandidatesSafely } from "./forecast.js";

// Harness copied from recommendations.test.ts: provision a user JIT via
// /v1/auth/me and learn their local id, since the routes below authorize on
// the local user id, not the Clerk id.
const verifier = createFakeVerifier({
  "token-a": { clerkUserId: "user_a", email: "a@example.com" },
});

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const H = 3_600_000;
const DAY = 24 * H;

function baseEvent(
  over: Partial<UsageEvent> & Pick<UsageEvent, "eventId" | "timestamp">,
): UsageEvent {
  return {
    machineId: "machine-a",
    machineName: "alice-laptop",
    app: "claude-code",
    provider: "anthropic",
    model: "claude-opus-4",
    inputTokens: 100,
    outputTokens: 0,
    costUsd: null,
    hasContent: false,
    features: { modelTier: "frontier" },
    ...over,
  };
}

/** Wednesday, matching packages/shared/src/forecast/candidates.test.ts's own anchor day. */
const TARGET_WEEKDAY = 3;

/**
 * A real, detectable wall candidate: ~24 days of weekday 9:00-18:00 activity
 * ending in a 20x-heavy day, followed by nothing. This is the same shape as
 * packages/shared/src/forecast/candidates.test.ts's `heavyFridayThenNothing`
 * fixture (proven there to produce a candidate via `detectCandidateWalls`),
 * anchored to `nowMs` instead of a fixed calendar date so it stays close
 * enough to "now" to land inside the route's `FORECAST_HISTORY_DAYS` fetch
 * window no matter when this test runs.
 *
 * That anchoring is NOT, on its own, safe against which real weekday `t0`
 * falls on: the loop below skips weekends using `getUTCDay()`, which reads
 * off the actual calendar, and `t0` (and therefore which weekday `HEAVY_DAY`
 * lands on) shifts with `nowMs`. Left alone, `HEAVY_DAY` itself lands on an
 * actual weekend on about 2 of every 7 possible run instants and gets
 * skipped entirely — the fixture then degrades to "any sufficiently long
 * gap after uniform history" rather than the documented "heavy run-up then
 * a wall" scenario `detectCandidateWalls` is meant to require. It still
 * produces a candidate on those runs (a long gap after ANY history clears a
 * low top-decile threshold), which is exactly why this was not caught by a
 * failing test — it silently exercises a different, weaker code path
 * instead. So `t0` is snapped backward (never forward, so `GAP_HOURS` can
 * only grow, never shrink below `CANDIDATE_MIN_GAP_HOURS`) to the most
 * recent UTC midnight that falls on `TARGET_WEEKDAY`, fixing every day's
 * weekday in the fixture regardless of what day this test actually runs.
 */
function heavyDayThenGapEvents(nowMs: number): UsageEvent[] {
  const GAP_HOURS = 74;
  const HEAVY_DAY = 23;
  const rawT0 = nowMs - GAP_HOURS * H - (HEAVY_DAY * 24 + 17) * H;

  const t0Midnight = new Date(rawT0);
  t0Midnight.setUTCHours(0, 0, 0, 0);
  const shiftDays = (t0Midnight.getUTCDay() - TARGET_WEEKDAY + 7) % 7;
  const t0 = t0Midnight.getTime() - shiftDays * DAY;

  const events: UsageEvent[] = [];
  for (let d = 0; d <= HEAVY_DAY; d += 1) {
    const dow = new Date(t0 + d * DAY).getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekend: no activity
    const mult = d === HEAVY_DAY ? 20 : 1;
    for (let h = 9; h < 18; h += 1) {
      const at = t0 + d * DAY + h * H;
      events.push(
        baseEvent({
          eventId: `evt-wall-${d}-${h}`,
          timestamp: new Date(at).toISOString(),
          inputTokens: 1_000 * mult,
        }),
      );
    }
  }
  return events;
}

/**
 * Two independently-detectable wall candidates within one
 * FORECAST_HISTORY_DAYS window: a heavy day (`heavyDay1`) followed by a
 * `gap1Days`-long gap and a resumption of normal activity, then a second
 * heavy day (`heavyDay2`) followed by an open trailing gap to `nowMs`. Same
 * construction as `heavyDayThenGapEvents` above (weekday 9:00-18:00 activity,
 * `t0` snapped to `TARGET_WEEKDAY` so the fixture's weekday/weekend shape is
 * independent of when the test actually runs), just with a second heavy
 * episode inserted partway through instead of one. The default parameters
 * (10, 3, 34, 74) were confirmed empirically (see the I2 fix report) to
 * produce exactly two candidates, spaced about three and a half weeks apart
 * -- the same shape the review's own reproduction used.
 */
function twoWallCandidatesEvents(
  nowMs: number,
  heavyDay1 = 10,
  gap1Days = 3,
  heavyDay2 = 34,
  finalGapHours = 74,
): UsageEvent[] {
  const rawT0 = nowMs - finalGapHours * H - (heavyDay2 * 24 + 17) * H;
  const t0Midnight = new Date(rawT0);
  t0Midnight.setUTCHours(0, 0, 0, 0);
  const shiftDays = (t0Midnight.getUTCDay() - TARGET_WEEKDAY + 7) % 7;
  const t0 = t0Midnight.getTime() - shiftDays * DAY;

  const events: UsageEvent[] = [];
  for (let d = 0; d <= heavyDay2; d += 1) {
    const dow = new Date(t0 + d * DAY).getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekend: no activity
    if (d > heavyDay1 && d <= heavyDay1 + gap1Days) continue; // the first gap
    const isHeavy = d === heavyDay1 || d === heavyDay2;
    const mult = isHeavy ? 20 : 1;
    for (let h = 9; h < 18; h += 1) {
      const at = t0 + d * DAY + h * H;
      events.push(
        baseEvent({
          eventId: `evt-2wall-${d}-${h}`,
          timestamp: new Date(at).toISOString(),
          inputTokens: 1_000 * mult,
        }),
      );
    }
  }
  return events;
}

describe("forecast routes", () => {
  let app: ReturnType<typeof createApp>;
  let eventsRepo: ReturnType<typeof createMemoryEventsRepo>;
  let userId: string;

  beforeEach(async () => {
    const authRepo = createMemoryAuthRepo();
    eventsRepo = createMemoryEventsRepo();
    app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });
    const me = await app.request("/v1/auth/me", { headers: bearer("token-a") });
    expect(me.status).toBe(200);
    userId = ((await me.json()) as { id: string }).id;
  });

  function request(path: string, init: Record<string, unknown> = {}) {
    return app.request(path, {
      ...init,
      headers: {
        ...bearer("token-a"),
        "Content-Type": "application/json",
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  }

  describe("GET /v1/forecast", () => {
    it("returns both windows and the counted-event totals", async () => {
      const res = await request("/v1/forecast");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(
        body.windows.map((w: { windowKind: string }) => w.windowKind),
      ).toEqual(["session_5h", "weekly_7d"]);
      expect(typeof body.eventsCounted).toBe("number");
      expect(typeof body.eventsWithoutBreakdown).toBe("number");
    });

    it("renders every ceiling with a provenance or with neither", async () => {
      // A number without provenance is exactly what this design exists to
      // prevent, so assert they travel together.
      const body = await (await request("/v1/forecast")).json();
      for (const w of body.windows) {
        if (w.ceiling === null) expect(w.ceilingProvenance).toBeNull();
        else
          expect(["measured", "reported", "declared", "inferred"]).toContain(
            w.ceilingProvenance,
          );
      }
    });

    it("requires auth", async () => {
      const res = await app.request("/v1/forecast");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/limit-observations", () => {
    it("I1: rejects a declaration when the real trailing window is empty, rather than storing a meaningless ceiling", async () => {
      // No events are seeded, so the server's own measurement is 0 -- a
      // "ceiling" of exactly zero is not a limit anyone could have hit, and
      // used to render as a self-contradiction downstream ("No ceiling
      // established yet." next to a projected reach date). The client's
      // wildly-claimed figure must still be ignored, not honored as a
      // fallback: this asserts the request is rejected outright, with
      // nothing written, not silently satisfied by the client's number.
      const res = await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({
          windowKind: "weekly_7d",
          unitsInWindow: 999_999_999,
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "empty_window" });
      expect(await eventsRepo.listLimitObservations(userId)).toEqual([]);
    });

    it("stamps the units actually measured from real history, not a default", async () => {
      // Stronger than the previous test: seed real events so the server
      // figure is a genuine non-trivial measurement, not merely "not the
      // client's number" by virtue of defaulting to 0.
      await eventsRepo.insertEventIfNew(
        userId,
        baseEvent({
          eventId: "evt-recent",
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          inputTokens: 500,
          outputTokens: 500,
        }),
      );
      const res = await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({ windowKind: "session_5h", unitsInWindow: 1 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // consumptionUnits: 500 raw input * 1.0 + 500 output * 5.0 = 3000.
      expect(body.observation.unitsInWindow).toBe(3000);
      expect(body.observation.unitsInWindow).not.toBe(1);
    });

    it("rejects an unknown window kind", async () => {
      const res = await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({ windowKind: "monthly" }),
      });
      expect(res.status).toBe(400);
    });

    it("400s (not 500) on a literal `null` JSON body", async () => {
      const res = await request("/v1/limit-observations", {
        method: "POST",
        body: "null",
      });
      expect(res.status).toBe(400);
    });

    it("supersedes the previous active observation for that window", async () => {
      // I1 now rejects a declaration whose real trailing window is empty, so
      // this seeds real consumption first -- both POSTs below must measure a
      // positive unitsInWindow to succeed at all.
      await eventsRepo.insertEventIfNew(
        userId,
        baseEvent({
          eventId: "evt-supersede-seed",
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          inputTokens: 500,
          outputTokens: 0,
        }),
      );
      await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({ windowKind: "weekly_7d" }),
      });
      await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({ windowKind: "weekly_7d" }),
      });
      const body = await (await request("/v1/forecast")).json();
      // Exactly one active weekly ceiling drives the forecast.
      expect(
        body.windows.find(
          (w: { windowKind: string }) => w.windowKind === "weekly_7d",
        ).ceilingProvenance,
      ).toBe("declared");

      const observations = await eventsRepo.listLimitObservations(userId);
      const activeWeekly = observations.filter(
        (o) => o.windowKind === "weekly_7d" && o.status === "active",
      );
      expect(activeWeekly).toHaveLength(1);
    });

    it("requires auth", async () => {
      const res = await app.request("/v1/limit-observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowKind: "weekly_7d" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/limit-observations/:id/dismiss", () => {
    it("dismisses an existing observation", async () => {
      // I1 now rejects a declaration whose real trailing window is empty, so
      // this seeds real consumption first.
      await eventsRepo.insertEventIfNew(
        userId,
        baseEvent({
          eventId: "evt-dismiss-seed",
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          inputTokens: 500,
          outputTokens: 0,
        }),
      );
      const created = await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({ windowKind: "session_5h" }),
      });
      const { observation } = (await created.json()) as {
        observation: { id: string };
      };

      const res = await request(
        `/v1/limit-observations/${observation.id}/dismiss`,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const stored = await eventsRepo.listLimitObservations(userId);
      expect(stored.find((o) => o.id === observation.id)?.status).toBe(
        "dismissed",
      );
    });

    it("404s for an unknown id", async () => {
      const res = await request(
        "/v1/limit-observations/does-not-exist/dismiss",
        { method: "POST" },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/wall-candidates/confirm", () => {
    it("turns a real detected candidate into a declared ceiling", async () => {
      for (const event of heavyDayThenGapEvents(Date.now())) {
        await eventsRepo.insertEventIfNew(userId, event);
      }

      const forecastBody = await (await request("/v1/forecast")).json();
      expect(forecastBody.candidates).toHaveLength(1);
      const candidate = forecastBody.candidates[0];
      expect(candidate.id).toMatch(/^wall:/);

      const confirmRes = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: JSON.stringify({
          id: candidate.id,
          windowKind: candidate.windowKind,
          observedAt: candidate.startsAt,
          unitsInWindow: candidate.unitsInWindow,
        }),
      });
      expect(confirmRes.status).toBe(200);
      const confirmBody = await confirmRes.json();
      expect(confirmBody.observation.provenance).toBe("declared");
      expect(confirmBody.observation.status).toBe("active");
      expect(confirmBody.observation.windowKind).toBe(candidate.windowKind);
      expect(confirmBody.observation.observedAt).toBe(candidate.startsAt);
      expect(confirmBody.observation.unitsInWindow).toBe(
        candidate.unitsInWindow,
      );

      const afterConfirm = await (await request("/v1/forecast")).json();
      const weekly = afterConfirm.windows.find(
        (w: { windowKind: string }) => w.windowKind === "weekly_7d",
      );
      expect(weekly.ceilingProvenance).toBe("declared");
      // I3: a confirmed candidate stops being (re-)proposed while the
      // confirmation stands -- the panel must not keep re-asking a question
      // that was already answered "yes".
      expect(
        afterConfirm.candidates.map((cand: { id: string }) => cand.id),
      ).not.toContain(candidate.id);
    });

    it("I1 regression: retracting a confirmation makes the candidate proposable again", async () => {
      // Confirming and dismissing a proposal are different acts. Before the
      // fix, dismissedIds was built from `status === "dismissed"` alone, so
      // retracting a *confirmed* candidate via
      // POST /v1/limit-observations/:id/dismiss (which sets status:
      // "dismissed" but leaves provenance: "declared" untouched) was
      // wrongly read back as "this candidate id was proposed and rejected",
      // permanently blacklisting it. This must fail against that reading:
      // the candidate has to come back once its confirmation is retracted.
      for (const event of heavyDayThenGapEvents(Date.now())) {
        await eventsRepo.insertEventIfNew(userId, event);
      }

      const before = await (await request("/v1/forecast")).json();
      expect(before.candidates).toHaveLength(1);
      const candidateId = before.candidates[0].id;

      const confirmRes = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: JSON.stringify({ id: candidateId }),
      });
      expect(confirmRes.status).toBe(200);
      const { observation } = (await confirmRes.json()) as {
        observation: { id: string };
      };

      // Confirmed: the candidate is retired while the confirmation stands.
      const afterConfirm = await (await request("/v1/forecast")).json();
      expect(afterConfirm.candidates).toHaveLength(0);

      // Retract the confirmation.
      const retractRes = await request(
        `/v1/limit-observations/${observation.id}/dismiss`,
        { method: "POST" },
      );
      expect(retractRes.status).toBe(200);

      // The candidate must be proposable again -- retracting a confirmation
      // is not the same act as dismissing a proposal.
      const afterRetract = await (await request("/v1/forecast")).json();
      expect(afterRetract.candidates).toHaveLength(1);
      expect(afterRetract.candidates[0].id).toBe(candidateId);
    });

    it("I2 regression: confirming a second candidate must not resurrect the first", async () => {
      // Before the fix, `suppressesCandidate` read "answered" purely off
      // `status === "active"`. Every candidate shares windowKind
      // "weekly_7d", so confirming B calls `supersedeActive("weekly_7d")`,
      // which flips A's row from "active" to "superseded" purely to keep
      // "one active ceiling per window" true -- and, as a side effect, made
      // A stop matching "answered" and get proposed again even though it had
      // already been confirmed. With two real, independently-detected
      // candidates, confirming both in turn must retire both; only
      // retracting a specific confirmation may bring its candidate back.
      for (const event of twoWallCandidatesEvents(Date.now())) {
        await eventsRepo.insertEventIfNew(userId, event);
      }

      const before = await (await request("/v1/forecast")).json();
      expect(before.candidates).toHaveLength(2);
      const [idA, idB] = before.candidates.map((c: { id: string }) => c.id);
      expect(idA).not.toBe(idB);

      const confirmA = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: JSON.stringify({ id: idA }),
      });
      expect(confirmA.status).toBe(200);
      const { observation: obsA } = (await confirmA.json()) as {
        observation: { id: string };
      };

      const afterA = await (await request("/v1/forecast")).json();
      expect(afterA.candidates.map((c: { id: string }) => c.id)).toEqual([
        idB,
      ]);

      const confirmB = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: JSON.stringify({ id: idB }),
      });
      expect(confirmB.status).toBe(200);

      // The crux of I2: confirming B must not resurrect A.
      const afterB = await (await request("/v1/forecast")).json();
      expect(afterB.candidates).toEqual([]);

      // Exactly one active weekly ceiling drives the forecast even though
      // two candidates have now been confirmed -- confirming B superseded
      // A's row, it did not leave two rows active at once.
      const observations = await eventsRepo.listLimitObservations(userId);
      const activeWeekly = observations.filter(
        (o) => o.windowKind === "weekly_7d" && o.status === "active",
      );
      expect(activeWeekly).toHaveLength(1);

      // Retracting A's confirmation must un-retire A specifically, without
      // touching B.
      const retractA = await request(
        `/v1/limit-observations/${obsA.id}/dismiss`,
        { method: "POST" },
      );
      expect(retractA.status).toBe(200);

      const afterRetractA = await (await request("/v1/forecast")).json();
      expect(afterRetractA.candidates.map((c: { id: string }) => c.id)).toEqual([
        idA,
      ]);
    });

    it("404s confirming an id that does not match any currently detected candidate", async () => {
      const res = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: JSON.stringify({ id: "wall:2026-01-01T00:00:00.000Z" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects a missing id", async () => {
      const res = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("400s (not 500) on a literal `null` JSON body", async () => {
      // `.catch(() => null)` on a parse failure covers an unparseable body,
      // but `JSON.parse("null")` succeeds and returns `null` -- the one
      // falsy value that parses cleanly but still isn't a record. Reading
      // `body["id"]` off it without a guard throws (property access on
      // null), which would surface as a 500 instead of the same 400 every
      // other malformed body gets.
      const res = await request("/v1/wall-candidates/confirm", {
        method: "POST",
        body: "null",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /v1/wall-candidates/dismiss", () => {
    it("stores a dismissal so a real detected candidate is never proposed again", async () => {
      // The task-7 brief's own draft of this test posts a dismissal for a
      // hardcoded candidate id and asserts it is absent from `candidates` --
      // which passes trivially under ANY implementation whenever the fixture
      // produces no candidates at all. This version seeds real history so
      // detection actually proposes a candidate, asserts its PRESENCE first,
      // then dismisses it and asserts its ABSENCE -- the only way this test
      // can fail is if dismissal doesn't work.
      for (const event of heavyDayThenGapEvents(Date.now())) {
        await eventsRepo.insertEventIfNew(userId, event);
      }

      const before = await (await request("/v1/forecast")).json();
      // Exactly one candidate, not just "at least one": pins the fixture's
      // known shape so the count-drop assertion below can only pass because
      // dismissal actually removed it, not because some unrelated failure
      // (e.g. detection silently degrading to []) coincidentally emptied the
      // list too.
      expect(before.candidates.length).toBe(1);
      const candidateId = before.candidates[0].id;

      const dismissRes = await request("/v1/wall-candidates/dismiss", {
        method: "POST",
        body: JSON.stringify({ id: candidateId }),
      });
      expect(dismissRes.status).toBe(200);
      expect(await dismissRes.json()).toEqual({ ok: true });

      const after = await (await request("/v1/forecast")).json();
      expect(after.candidates).toHaveLength(0);
      expect(
        after.candidates.map((c: { id: string }) => c.id),
      ).not.toContain(candidateId);
    });

    it("rejects an id that isn't in the wall: format", async () => {
      const res = await request("/v1/wall-candidates/dismiss", {
        method: "POST",
        body: JSON.stringify({ id: "not-a-wall-id" }),
      });
      expect(res.status).toBe(400);
    });

    it("400s (not 500) on a literal `null` JSON body", async () => {
      const res = await request("/v1/wall-candidates/dismiss", {
        method: "POST",
        body: "null",
      });
      expect(res.status).toBe(400);
    });

    it("requires auth", async () => {
      const res = await app.request("/v1/wall-candidates/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "wall:2026-01-01T00:00:00.000Z" }),
      });
      expect(res.status).toBe(401);
    });
  });
});

describe("I2: unhandled repo errors return JSON, not Hono's default plain text", () => {
  it("returns a JSON 500 when a repo call inside GET /v1/forecast throws", async () => {
    const authRepo = createMemoryAuthRepo();
    const eventsRepo = createMemoryEventsRepo();
    eventsRepo.eventsSince = async () => {
      throw new Error("simulated eventsSince failure");
    };
    const app = createApp({
      db: undefined as never,
      authRepo,
      eventsRepo,
      clerkVerifier: verifier,
    });
    await app.request("/v1/auth/me", { headers: bearer("token-a") });

    const res = await app.request("/v1/forecast", { headers: bearer("token-a") });
    expect(res.status).toBe(500);
    // The house convention every route in this app follows: a JSON body
    // shaped like `{ error: string }`, never Hono's default `text/plain`.
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});

describe("assertActiveIsDeclared", () => {
  it("throws when status is active but provenance is not declared", () => {
    expect(() =>
      assertActiveIsDeclared({ status: "active", provenance: "inferred" }),
    ).toThrow();
    expect(() =>
      assertActiveIsDeclared({ status: "active", provenance: "measured" }),
    ).toThrow();
    expect(() =>
      assertActiveIsDeclared({ status: "active", provenance: "reported" }),
    ).toThrow();
  });

  it("allows active+declared, and any non-active status regardless of provenance", () => {
    expect(() =>
      assertActiveIsDeclared({ status: "active", provenance: "declared" }),
    ).not.toThrow();
    expect(() =>
      assertActiveIsDeclared({ status: "dismissed", provenance: "inferred" }),
    ).not.toThrow();
    expect(() =>
      assertActiveIsDeclared({ status: "superseded", provenance: "measured" }),
    ).not.toThrow();
  });
});

describe("detectCandidatesSafely", () => {
  it("degrades to an empty list when the detector throws", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    const result = detectCandidatesSafely(
      [],
      Date.now(),
      [],
      throwing as never,
    );
    expect(result).toEqual([]);
  });

  it("passes through the real detector's output otherwise", () => {
    const nowMs = Date.now();
    const sorted = toTimedUnits(heavyDayThenGapEvents(nowMs));
    const result = detectCandidatesSafely(sorted, nowMs, []);
    expect(result.length).toBeGreaterThan(0);
  });
});
