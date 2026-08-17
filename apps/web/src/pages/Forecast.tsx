import { useCallback, useEffect, useState } from "react";
import {
  confirmWallCandidate,
  dismissWallCandidate,
  formatTokens,
  getForecast,
  recordLimitObservation,
  type ForecastDto,
  type WallCandidateDto,
  type WindowForecastDto,
} from "../api/client";

export function Forecast() {
  const [forecast, setForecast] = useState<ForecastDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getForecast();
      setForecast(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load forecast");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onDeclare(windowKind: WindowForecastDto["windowKind"]) {
    const key = `declare:${windowKind}`;
    setBusyKey(key);
    try {
      await recordLimitObservation(windowKind);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record");
    } finally {
      setBusyKey(null);
    }
  }

  async function onConfirm(id: string) {
    setBusyKey(id);
    try {
      await confirmWallCandidate(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm");
    } finally {
      setBusyKey(null);
    }
  }

  async function onDismiss(id: string) {
    setBusyKey(id);
    try {
      await dismissWallCandidate(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss");
    } finally {
      setBusyKey(null);
    }
  }

  // Optional the same way `RecommendationDto`'s `coverage` is: an older API
  // build may not send them yet, and the panel must not crash for it.
  const candidates = forecast?.candidates ?? [];

  return (
    <div>
      <h1>Forecast</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        How close each of your account's two enforced windows is to its
        ceiling, projected from your own history. Every figure below is in{" "}
        <strong>consumption units (estimated)</strong> — Anthropic publishes no
        metering formula for subscription plans, so this is a proxy, not a
        bill.
      </p>

      {error ? <div className="error">{error}</div> : null}
      {forecast == null && !error ? <div className="loading">Loading…</div> : null}

      {forecast ? (
        <>
          {forecast.eventsWithoutBreakdown != null && forecast.eventsCounted != null ? (
            <BreakdownNote
              eventsWithoutBreakdown={forecast.eventsWithoutBreakdown}
              eventsCounted={forecast.eventsCounted}
            />
          ) : null}

          <div className="forecast-windows">
            {forecast.windows.map((w) => (
              <WindowCard
                key={w.windowKind}
                window={w}
                busy={busyKey === `declare:${w.windowKind}`}
                onDeclare={() => void onDeclare(w.windowKind)}
              />
            ))}
          </div>

          <h2 style={{ marginTop: "1.5rem" }}>Possible past limit hits</h2>
          {candidates.length === 0 ? (
            <div className="empty">
              No gaps in your history look like a limit hit right now.
            </div>
          ) : (
            <div className="forecast-candidates">
              {candidates.map((c) => (
                <CandidatePrompt
                  key={c.id}
                  candidate={c}
                  busy={busyKey === c.id}
                  onConfirm={() => void onConfirm(c.id)}
                  onDismiss={() => void onDismiss(c.id)}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/** "session_5h" / "weekly_7d" in the words a person actually enforces against. */
function windowLabel(kind: WindowForecastDto["windowKind"]): string {
  return kind === "session_5h" ? "5-hour session" : "7-day week";
}

/** The noun an inferred ceiling is "your highest ___ ever". */
function windowNoun(kind: WindowForecastDto["windowKind"]): string {
  return kind === "session_5h" ? "session" : "week";
}

/** Calendar day only, matching the mono date style `RecommendationCard` uses. */
function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function formatHours(h: number): string {
  return `${Math.round(h * 10) / 10}h`;
}

/**
 * The ceiling clause, on its own so `WindowCard` doesn't have to hold the
 * per-provenance copy inline. Every branch names its own provenance word
 * literally: a number without its provenance is the failure this whole
 * design exists to prevent, so "declared" reads as declared and "inferred"
 * reads as inferred, never as an unqualified fact.
 *
 * An inferred ceiling is deliberately never called "your limit" — it is the
 * user's own historical maximum, a lower bound on their real limit, not a
 * fact about their account. Anthropic's stated words ("measured"/"reported")
 * get their own honest phrasing too, in case a future observation source
 * ever produces one.
 */
function ceilingClause(w: WindowForecastDto): string {
  if (w.ceiling == null || w.fractionOfCeiling == null || w.ceilingProvenance == null) {
    return "No ceiling established yet.";
  }
  const pct = Math.round(w.fractionOfCeiling * 100);
  switch (w.ceilingProvenance) {
    case "inferred":
      return `${pct}% of your highest ${windowNoun(w.windowKind)} ever (inferred from your own history).`;
    case "declared":
      return `${pct}% of your observed limit (declared).`;
    case "measured":
      return `${pct}% of your measured limit (measured by Anthropic).`;
    case "reported":
      return `${pct}% of your reported limit (reported by Anthropic).`;
    default:
      // Defensive: an unrecognized provenance string must not fall through
      // to a bare, unqualified number.
      return "No ceiling established yet.";
  }
}

/**
 * The projection clause: a date when there is one, the reason verbatim when
 * there is not — and never both. `noProjectionReason` is written to already
 * read as an explanation (see `packages/shared/src/forecast/types.ts`), so
 * this renders it as-is rather than re-wrapping it.
 */
function projectionClause(w: WindowForecastDto): string | null {
  if (w.reachesCeilingAt != null) {
    return `Projected to reach the ceiling around ${formatDate(w.reachesCeilingAt)}.`;
  }
  if (w.noProjectionReason != null) {
    return `No projection: ${w.noProjectionReason}`;
  }
  return null;
}

/**
 * One window's card. Exported (and free of hooks) so `Forecast.test.tsx` can
 * render it standalone with `renderToStaticMarkup` and assert on the exact
 * sentences a user reads, the same discipline `RecommendationCard` and
 * `CoverageNote` pin in `Recommendations.tsx`.
 */
export function WindowCard({
  window: w,
  busy,
  onDeclare,
}: {
  window: WindowForecastDto;
  busy?: boolean;
  onDeclare?: () => void;
}) {
  const projection = projectionClause(w);
  return (
    <article className="forecast-card">
      <h3>{windowLabel(w.windowKind)}</h3>
      <div className="muted" style={{ fontSize: "0.9rem" }}>
        Current: {formatTokens(w.current)} consumption units (estimated) ·
        Pace: {formatTokens(w.pacePerHour)} consumption units/hour (estimated)
      </div>
      <div style={{ marginTop: "0.5rem" }}>{ceilingClause(w)}</div>
      {projection ? (
        <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
          {projection}
        </div>
      ) : null}
      {onDeclare ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onDeclare}
          style={{ marginTop: "0.6rem" }}
        >
          {busy ? "…" : "I hit this limit now"}
        </button>
      ) : null}
    </article>
  );
}

/**
 * A detected gap that might be a past limit hit — a question, not a
 * finding. Deliberately never renders the word "ceiling" or asserts one:
 * `WallCandidateDto` carries no ceiling field at all, only the evidence
 * (the gap and what the trailing window held just before it), because the
 * user's answer is what turns evidence into a declared ceiling, not this
 * card. Exported and free of hooks for the same standalone-render reason as
 * `WindowCard`.
 */
export function CandidatePrompt({
  candidate: c,
  busy,
  onConfirm,
  onDismiss,
}: {
  candidate: WallCandidateDto;
  busy?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <article className="forecast-candidate">
      <p>
        Activity went quiet for {formatHours(c.gapHours)} starting{" "}
        {formatDate(c.startsAt)}, right after reaching{" "}
        {formatTokens(c.unitsInWindow)} consumption units (estimated) in the{" "}
        {windowLabel(c.windowKind)} window.
      </p>
      <p>Did you hit a wall then?</p>
      <div>
        <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
          {busy ? "…" : "Yes, that was a limit"}
        </button>{" "}
        <button
          type="button"
          className="btn-danger"
          disabled={busy}
          onClick={onDismiss}
        >
          {busy ? "…" : "No, unrelated"}
        </button>
      </div>
    </article>
  );
}

/**
 * States what the forecast does NOT cover: when more than 5% of the events
 * behind these figures had no cache breakdown recorded, the consumption-unit
 * proxy is coarser than usual for this window, and the reader should know
 * that rather than trust a silently-degraded number. Below that ratio the
 * note renders nothing, the same "say nothing rather than pad a good case
 * with defensive noise" choice `CoverageNote` makes for zero unattributed
 * turns.
 *
 * The event word's plural is governed by `eventsCounted` (the denominator
 * the reader is told "X of Y ___"), not by `eventsWithoutBreakdown`: "1 of 1
 * event" is correct even though nothing here hinges on the numerator being
 * singular, and "1 of 20 events" needs the plural despite the numerator
 * being 1. `CoverageNote` shipped exactly this kind of singular/plural bug
 * once already (see its `isSingularTurn`), so the two counts are kept
 * distinct on purpose.
 */
export function BreakdownNote({
  eventsWithoutBreakdown,
  eventsCounted,
}: {
  eventsWithoutBreakdown: number;
  eventsCounted: number;
}) {
  const ratio = eventsCounted > 0 ? eventsWithoutBreakdown / eventsCounted : 0;
  if (ratio <= 0.05) {
    return null;
  }
  const eventWord = eventsCounted === 1 ? "event" : "events";
  return (
    <p className="muted" style={{ fontSize: "0.85rem" }}>
      {eventsWithoutBreakdown.toLocaleString("en-US")} of{" "}
      {eventsCounted.toLocaleString("en-US")} {eventWord} had no cache breakdown
      recorded — the consumption-unit estimate is coarser than usual here.
    </p>
  );
}
