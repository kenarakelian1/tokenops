import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CoverageDto, RecommendationDto } from "../api/client";
import {
  CoverageNote,
  RecommendationCard,
  describeCounterfactual,
} from "./Recommendations";

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

  it("labels the token figure as what it is, and labels the money as API-equivalent", () => {
    // "Est. waste" claimed both figures describe waste. estimatedWastedTokens
    // is the tokens the finding is ABOUT: here the cache-read shortfall,
    // which was billed at the full rate rather than wasted, and for
    // frontier_share every frontier model's tokens including ones never
    // repriced. Dividing the dollars by it yields a rate for nothing.
    //
    // The dollar figure is also relabeled "API-equivalent": on a
    // subscription plan the number is notional — what this usage would have
    // cost on the API, not what the user was actually charged. Tokens stay
    // the primary, measured figure; the money keeps its own label.
    const text = textOf(cacheEfficiency);
    expect(text).toContain("Tokens involved: 5.00M · Est. savings: $22.5000");
    expect(text).toContain("(estimated, API-equivalent)");
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

/**
 * The coverage note's user-visible sentence, pinned the same way the card's
 * text is: rendered to static markup and stripped of tags, because a silent
 * truncation (only the top 10 sessions per rule are ever kept, sidechain
 * turns carry no sessionId at all) reads as full coverage unless the panel
 * says otherwise in the words a person actually reads.
 */
function noteTextOf(coverage: CoverageDto): string {
  const html = renderToStaticMarkup(<CoverageNote coverage={coverage} />);
  return html.replace(/<[^>]*>/g, "");
}

describe("CoverageNote", () => {
  it("states how many sessions were considered, that only the top N per rule are shown, and what belongs to no session", () => {
    const text = noteTextOf({
      sessionsConsidered: 190,
      sessionsShownPerRule: 10,
      unattributedTurns: 4_423,
      unattributedInputTokens: 500_000_000,
    });
    expect(text).toContain("190 sessions");
    expect(text).toContain("top 10 per rule");
    expect(text).toContain("4,423");
    expect(text).toContain("500.00M");
    expect(text).toContain("belong to no session");
  });

  it("omits the unattributed clause instead of describing zero turns", () => {
    // A dangling "0 subagent turns (0 tokens) belong to no session" clause
    // would read as a bug, not as good news. When there is nothing
    // unattributed, the sentence should simply not mention it.
    const text = noteTextOf({
      sessionsConsidered: 50,
      sessionsShownPerRule: 10,
      unattributedTurns: 0,
      unattributedInputTokens: 0,
    });
    expect(text).not.toContain("subagent turn");
    expect(text).not.toContain("belong to no session");
  });

  it("does not claim a top-N truncation when every considered session is already shown", () => {
    // "showing the top 10 per rule" implies 10 were kept out of more — untrue
    // and misleading when only 3 sessions exist in the window at all. Pins
    // the replacement wording too, not just the absence of the wrong one —
    // an implementation that dropped the scope clause entirely (rendering
    // just "Considered 3 sessions.") would satisfy the negative assertion
    // alone without actually saying anything true.
    const text = noteTextOf({
      sessionsConsidered: 3,
      sessionsShownPerRule: 10,
      unattributedTurns: 0,
      unattributedInputTokens: 0,
    });
    expect(text).toContain("3 sessions");
    expect(text).toContain("all shown per rule");
    expect(text).not.toContain("top 10 per rule");
  });

  it("agrees noun and verb for a single unattributed turn", () => {
    // Regression: the noun's plural suffix was already conditional on
    // unattributedTurns === 1, but the verbs ("belong", "are not counted")
    // were hardcoded plural, so a single turn rendered "1 subagent turn ...
    // belong to no session and are not counted here" — wrong on both verbs.
    // isSingularTurn now decides the noun and both verbs from one place.
    const text = noteTextOf({
      sessionsConsidered: 50,
      sessionsShownPerRule: 10,
      unattributedTurns: 1,
      unattributedInputTokens: 42,
    });
    expect(text).toContain(
      "1 subagent turn (42 tokens) belongs to no session and is not counted here.",
    );
    expect(text).not.toContain("subagent turns");
    expect(text).not.toContain("belong to no session");
    expect(text).not.toContain("are not counted");
  });

  it("gives zero considered sessions its own sentence instead of an absurd 'all shown per rule'", () => {
    // "Considered 0 sessions, all shown per rule." is arithmetically true
    // (0 > 10 is false, so the non-truncation branch fires) but reads as a
    // malfunction to a brand-new account with no history yet. That state is
    // deliberate, not incidental: it gets its own sentence.
    const text = noteTextOf({
      sessionsConsidered: 0,
      sessionsShownPerRule: 10,
      unattributedTurns: 0,
      unattributedInputTokens: 0,
    });
    expect(text).toBe("No sessions in this window yet.");
  });
});
