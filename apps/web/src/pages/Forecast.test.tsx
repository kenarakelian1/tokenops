import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WallCandidateDto, WindowForecastDto } from "../api/client";
import { BreakdownNote, CandidatePrompt, TruncationNote, WindowCard } from "./Forecast";

/**
 * Same no-DOM pattern `Recommendations.test.tsx` uses for `RecommendationCard`
 * and `CoverageNote`: render to static markup, strip tags, assert on what a
 * person actually reads. `WindowCard` and `CandidatePrompt` take no hooks and
 * do no fetching, so they render standalone.
 */
function textOf(w: WindowForecastDto): string {
  return renderToStaticMarkup(<WindowCard window={w} />).replace(/<[^>]*>/g, "");
}

function candidateTextOf(c: WallCandidateDto): string {
  return renderToStaticMarkup(
    <CandidatePrompt candidate={c} onConfirm={() => {}} onDismiss={() => {}} />,
  ).replace(/<[^>]*>/g, "");
}

const base: WindowForecastDto = {
  windowKind: "weekly_7d",
  current: 1_340_000,
  pacePerHour: 9_000,
  ceiling: 1_540_000,
  ceilingProvenance: "inferred",
  fractionOfCeiling: 0.87,
  reachesCeilingAt: "2026-08-18T12:00:00.000Z",
  noProjectionReason: null,
};

describe("WindowCard", () => {
  it("always names the provenance beside the ceiling", () => {
    // A number without its provenance is the failure this design exists to
    // prevent: an inferred bound must never read like a measured fact.
    expect(textOf(base)).toMatch(/inferred/i);
  });

  it("calls an inferred ceiling the user's own maximum, not a limit", () => {
    expect(textOf(base)).not.toMatch(/your limit/i);
    expect(textOf(base)).toMatch(/highest|maximum/i);
  });

  it("calls a declared ceiling an observed limit", () => {
    const t = textOf({ ...base, ceilingProvenance: "declared" });
    expect(t).toMatch(/observed/i);
    expect(t).toMatch(/declared/i);
  });

  it("shows the reason instead of a date when there is no projection", () => {
    const t = textOf({
      ...base,
      ceiling: null,
      ceilingProvenance: null,
      fractionOfCeiling: null,
      reachesCeilingAt: null,
      noProjectionReason:
        "needs 14 days of history before a ceiling means anything (have 3)",
    });
    expect(t).toMatch(/needs 14 days of history/);
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("never renders a raw unit count without calling it an estimate", () => {
    // The unit is a proxy, not Anthropic's metering. Saying "usage" would
    // claim an accuracy this cannot have.
    const t = textOf(base);
    expect(t).not.toMatch(/\busage\b/i);
    expect(t).toMatch(/consumption units \(estimated\)/);
  });

  it("names the window kind in plain words", () => {
    expect(textOf(base)).toMatch(/7-day week/i);
    expect(textOf({ ...base, windowKind: "session_5h" })).toMatch(/5-hour session/i);
  });

  it("never states both 'No ceiling established yet.' and a projected reach date, even for a contradictory DTO", () => {
    // Defect B (2026-08-16 second review): an earlier round put the
    // mutual-exclusion guard in the PRODUCER (`forecastWindow` in
    // @tokenops/shared, whose own invariant comment says `ceiling` may
    // never be `0`), not the renderer. Rendering `WindowCard` directly
    // against a shape that violates that invariant still emitted both
    // sentences -- this is exactly the shape the reviewer demonstrated, and
    // `ForecastDto`'s own doc comment says the panel must tolerate an OLDER
    // API build (a pre-fix API emits precisely this). This test targets
    // `Forecast.tsx` itself, independent of whether the producer-side guard
    // holds -- it must not be removed.
    const contradictory: WindowForecastDto = {
      windowKind: "weekly_7d",
      current: 1_000,
      pacePerHour: 50,
      ceiling: 0,
      ceilingProvenance: "declared",
      fractionOfCeiling: null,
      reachesCeilingAt: "2026-08-20T00:00:00.000Z",
      noProjectionReason: null,
    };
    const t = textOf(contradictory);
    expect(t).toMatch(/No ceiling established yet\./);
    expect(t).not.toMatch(/Projected to reach the ceiling around/);
  });
});

const candidate: WallCandidateDto = {
  id: "wall:2026-08-05T12:00:00.000Z",
  windowKind: "weekly_7d",
  startsAt: "2026-08-05T12:00:00.000Z",
  endsAt: "2026-08-05T20:00:00.000Z",
  gapHours: 8,
  unitsInWindow: 1_500_000,
};

describe("CandidatePrompt", () => {
  it("asks a question and offers two answers, never stating a ceiling", () => {
    const t = candidateTextOf(candidate);
    expect(t).toMatch(/\?/);
    expect(t).not.toMatch(/\bceiling\b/i);
    expect(t).not.toMatch(/\busage\b/i);
  });

  it("shows both buttons' labels", () => {
    const html = renderToStaticMarkup(
      <CandidatePrompt candidate={candidate} onConfirm={() => {}} onDismiss={() => {}} />,
    );
    expect(html).toMatch(/<button/);
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });
});

describe("TruncationNote", () => {
  it("tells the reader their history was capped", () => {
    const html = renderToStaticMarkup(<TruncationNote />);
    const t = html.replace(/<[^>]*>/g, "");
    expect(t).toMatch(/most recent/i);
    expect(t).toMatch(/left out|too large/i);
  });
});

describe("BreakdownNote", () => {
  it("names how many events lacked a cache breakdown when the ratio is coarse", () => {
    const html = renderToStaticMarkup(
      <BreakdownNote eventsWithoutBreakdown={12} eventsCounted={100} />,
    );
    const t = html.replace(/<[^>]*>/g, "");
    expect(t).toContain("12");
    expect(t).toContain("100");
    expect(t).toMatch(/cache breakdown/);
  });

  it("renders nothing when the ratio is at or under 5%", () => {
    const html = renderToStaticMarkup(
      <BreakdownNote eventsWithoutBreakdown={5} eventsCounted={100} />,
    );
    expect(html).toBe("");
  });

  it("renders nothing when there are no events counted, instead of dividing by zero", () => {
    const html = renderToStaticMarkup(
      <BreakdownNote eventsWithoutBreakdown={0} eventsCounted={0} />,
    );
    expect(html).toBe("");
  });

  it("keeps 'event' singular only when the denominator itself is one", () => {
    const html = renderToStaticMarkup(
      <BreakdownNote eventsWithoutBreakdown={1} eventsCounted={1} />,
    );
    const t = html.replace(/<[^>]*>/g, "");
    expect(t).toContain("1 of 1 event ");
    expect(t).not.toContain("1 of 1 events");
  });
});
