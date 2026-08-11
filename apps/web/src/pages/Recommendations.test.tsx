import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecommendationDto } from "../api/client";
import { RecommendationCard, describeCounterfactual } from "./Recommendations";

/**
 * The card's user-visible sentences, pinned.
 *
 * Rendered to static markup and stripped of tags, so these assert what a
 * person reads rather than which element it landed in. Nothing here needs a
 * DOM: the card takes no hooks and no data fetching.
 */
function textOf(rec: RecommendationDto): string {
  const html = renderToStaticMarkup(
    <RecommendationCard rec={rec} busy={false} onDismiss={() => {}} />,
  );
  return html.replace(/<[^>]*>/g, "");
}

/**
 * The pinned `cache_efficiency` finding the final review traced end to end:
 * 10M input tokens on claude-opus-5 with zero recorded cache reads. The rule
 * targets a 50% read ratio, so the counterfactual raises cacheReadTokens to
 * 5M and the shared pricer values the move at $50 - $27.50 = $22.50.
 * `estimatedWastedTokens` is the 5M read shortfall.
 */
const cacheEfficiency: RecommendationDto = {
  id: "r1",
  ruleId: "cache_efficiency",
  severity: "warn",
  title: "Low cache reuse",
  detail: "Only 0% of claude-opus-5's input tokens were served from cache.",
  estimatedWastedTokens: 5_000_000,
  estimatedWastedUsd: 22.5,
  eventIds: [],
  status: "open",
  createdAt: "2026-08-05T00:00:00.000Z",
  counterfactual: {
    model: "claude-opus-5",
    inputTokens: 10_000_000,
    outputTokens: 0,
    cacheReadTokens: 5_000_000,
    cacheCreationTokens: 0,
  },
  assumption: "a 50% cache-read ratio is achievable for this workload",
};

describe("RecommendationCard", () => {
  it("shows what actually changed in a cache-mix counterfactual", () => {
    // Before the cache fields were rendered, this card read
    // "Would have been: claude-opus-5 · 10.00M in / 0 out" — a $22.50 saving
    // attributed to a hypothetical displayed as identical to reality, because
    // cache_efficiency's advice changes neither the model nor either token
    // count. The 0 -> 5M cache-read move IS the counterfactual.
    const text = textOf(cacheEfficiency);
    expect(text).toContain(
      "Would have been: claude-opus-5 · 10.00M in / 0 out · 5.00M cache read · 0 cache write",
    );
  });

  it("labels the token figure as what it is, and keeps the money estimated", () => {
    // "Est. waste" claimed both figures describe waste. estimatedWastedTokens
    // is the tokens the finding is ABOUT: here the cache-read shortfall,
    // which was billed at the full rate rather than wasted, and for
    // frontier_share every frontier model's tokens including ones never
    // repriced. Dividing the dollars by it yields a rate for nothing.
    const text = textOf(cacheEfficiency);
    expect(text).toContain("Tokens involved: 5.00M · Est. savings: $22.5000");
    expect(text).toContain("(estimated)");
    expect(text).not.toContain("Est. waste");
  });

  it("renders the assumption prefix exactly once", () => {
    // Four of the five rules used to begin their assumption with "Assumes",
    // on top of the prefix this component supplies.
    const text = textOf(cacheEfficiency);
    expect(text).toContain(
      "Assumes: a 50% cache-read ratio is achievable for this workload",
    );
    expect(text).not.toContain("Assumes: Assumes");
  });

  it("says nothing about cache when no breakdown was recorded", () => {
    // null means "never recorded", and must render NOTHING — not a 0, which
    // would claim a measurement, and not a dash. Same discipline the rules
    // and the pricer keep.
    const text = textOf({
      ...cacheEfficiency,
      ruleId: "frontier_trivial",
      estimatedWastedTokens: 160,
      estimatedWastedUsd: 0.02,
      counterfactual: {
        model: "claude-sonnet-5",
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      assumption: "claude-sonnet-5 handles requests at or under 200 tokens as well as claude-opus-5",
    });
    expect(text).toContain("Would have been: claude-sonnet-5 · 120 in / 40 out");
    expect(text).not.toContain("cache read");
    expect(text).not.toContain("cache write");
    expect(text).not.toContain("null");
  });
});

describe("describeCounterfactual", () => {
  const base = {
    model: "claude-opus-5",
    inputTokens: 10_000_000,
    outputTokens: 0,
    cacheReadTokens: null as number | null,
    cacheCreationTokens: null as number | null,
  };

  it("omits a null component and shows a recorded zero", () => {
    // The two components move independently — trimCacheTokens can leave one
    // null and the other a number on the same counterfactual — so each is
    // decided on its own.
    expect(describeCounterfactual({ ...base, cacheReadTokens: 0 })).toBe(
      "claude-opus-5 · 10.00M in / 0 out · 0 cache read",
    );
    expect(describeCounterfactual({ ...base, cacheCreationTokens: 0 })).toBe(
      "claude-opus-5 · 10.00M in / 0 out · 0 cache write",
    );
    expect(describeCounterfactual(base)).toBe(
      "claude-opus-5 · 10.00M in / 0 out",
    );
  });

  it("shows both components when both were recorded", () => {
    expect(
      describeCounterfactual({
        ...base,
        cacheReadTokens: 5_000_000,
        cacheCreationTokens: 250_000,
      }),
    ).toBe("claude-opus-5 · 10.00M in / 0 out · 5.00M cache read · 250.0k cache write");
  });
});
