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

/**
 * A real, detectable wall candidate: ~24 days of weekday 9:00-18:00 activity
 * ending in a 20x-heavy day, followed by nothing. This is the same shape as
 * packages/shared/src/forecast/candidates.test.ts's `heavyFridayThenNothing`
 * fixture (proven there to produce a candidate via `detectCandidateWalls`),
 * anchored to `nowMs` instead of a fixed calendar date so it works no matter
 * what day this test actually runs.
 *
 * That anchoring is safe because hour-of-week (day-of-week * 24 + hour) has
 * an exact 7-day period: shifting the whole fixture by any amount never
 * changes which weekday/hour slots its own repeating pattern lands on
 * relative to itself. Only the fixed 74h trailing gap after the heavy day
 * matters, and that is anchored to `nowMs` directly.
 */
function heavyDayThenGapEvents(nowMs: number): UsageEvent[] {
  const GAP_HOURS = 74;
  const HEAVY_DAY = 23;
  const t0 = nowMs - GAP_HOURS * H - (HEAVY_DAY * 24 + 17) * H;

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
    it("records the live trailing total rather than trusting the client", async () => {
      // The client must not be able to claim an arbitrary ceiling; the server
      // stamps the number from its own ledger. No events are seeded, so the
      // real figure is 0 -- nowhere near the client's claimed 999,999,999.
      const res = await request("/v1/limit-observations", {
        method: "POST",
        body: JSON.stringify({
          windowKind: "weekly_7d",
          unitsInWindow: 999_999_999,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.observation.unitsInWindow).not.toBe(999_999_999);
      expect(body.observation.unitsInWindow).toBe(0);
      expect(body.observation.provenance).toBe("declared");
      expect(body.observation.status).toBe("active");
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

    it("supersedes the previous active observation for that window", async () => {
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
