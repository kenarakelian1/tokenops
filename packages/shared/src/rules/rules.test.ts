import { describe, it, expect } from "vitest";
import { REQUEST_RULES, runRules } from "./index.js";
import type { Rule } from "./contract.js";
import { UsageEventSchema } from "../schema/event.js";
import type { UsageEvent } from "../schema/event.js";
import { frontierTrivialRule } from "./frontier-trivial.js";
import { fullDocumentIoRule, FULL_DOC_EXCERPT_FRACTION } from "./full-document-io.js";
import { contextBloatRule } from "./context-bloat.js";
import { priceCounterfactual } from "./counterfactual.js";

const CTX = { now: new Date("2026-09-15T00:00:00Z") };

function ev(
  partial: Partial<UsageEvent> &
    Pick<
      UsageEvent,
      "eventId" | "model" | "inputTokens" | "outputTokens" | "features"
    >,
): UsageEvent {
  return {
    timestamp: new Date().toISOString(),
    machineId: "m",
    machineName: "n",
    app: "openai-proxy",
    provider: "openai",
    costUsd: 0.01,
    hasContent: false,
    ...partial,
  };
}

describe("runRules", () => {
  it("flags frontier for trivial", () => {
    const hits = runRules(
      ev({
        eventId: "a",
        // Savings come from the claude-opus-4 vs. claude-sonnet-5 rate
        // delta, priced by the shared pricer — NOT from costUsd, which
        // savings no longer read at all. Output-heavy (the output-rate
        // delta is what's large enough to matter) so the finding clears
        // MIN_WASTED_USD within frontier_trivial's 200-token cap; at
        // claude-opus-5's much smaller rate delta (or an input-heavy split)
        // the same call is genuinely below the floor.
        model: "claude-opus-4",
        inputTokens: 20,
        outputTokens: 180,
        costUsd: 0.05,
        features: {
          promptChars: 40,
          responseChars: 20,
          messageCount: 1,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "frontier",
        },
      }),
    );
    expect(hits.some((h) => h.ruleId === "frontier_trivial")).toBe(true);
  });

  it("flags full document io", () => {
    const hits = runRules(
      ev({
        eventId: "b",
        // gpt-4o, not gpt-4o-mini: savings here are the removed-token share
        // priced at the model's OWN input rate (full_document_io doesn't
        // change model), read from the shared pricer — not from costUsd,
        // which savings no longer read at all. gpt-4o-mini's rate is too low
        // to clear MIN_WASTED_USD at this token count; gpt-4o's does.
        model: "gpt-4o",
        inputTokens: 12_000,
        outputTokens: 100,
        costUsd: 0.05,
        features: {
          promptChars: 40_000,
          responseChars: 200,
          messageCount: 2,
          codeFenceCount: 8,
          largePasteScore: 0.9,
          fileDumpScore: 0.8,
          modelTier: "small",
        },
      }),
    );
    expect(hits.some((h) => h.ruleId === "full_document_io")).toBe(true);
  });

  it("flags context bloat with session history", () => {
    // gpt-4o, not gpt-4o-mini, and larger token counts: savings are the
    // excess-over-first-request tokens priced at the model's OWN input
    // rate, read from the shared pricer — not from costUsd, which savings
    // no longer read at all. gpt-4o-mini's rate at 1,000 -> 3,000 tokens is
    // too low to clear MIN_WASTED_USD; gpt-4o at these larger counts does.
    const session: UsageEvent[] = [
      ev({
        eventId: "s1",
        model: "gpt-4o",
        inputTokens: 5000,
        outputTokens: 50,
        sessionId: "S",
        features: {
          promptChars: 5000,
          responseChars: 50,
          messageCount: 2,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "small",
          newContentRatio: 1,
        },
      }),
      ev({
        eventId: "s2",
        model: "gpt-4o",
        inputTokens: 8000,
        outputTokens: 50,
        sessionId: "S",
        features: {
          promptChars: 8000,
          responseChars: 50,
          messageCount: 4,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "small",
          newContentRatio: 0.2,
        },
      }),
    ];
    const current = ev({
      eventId: "s3",
      model: "gpt-4o",
      inputTokens: 15_000,
      outputTokens: 50,
      sessionId: "S",
      costUsd: 0.05,
      features: {
        promptChars: 15_000,
        responseChars: 50,
        messageCount: 6,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "small",
        newContentRatio: 0.1,
      },
    });
    const hits = runRules(current, session);
    expect(hits.some((h) => h.ruleId === "context_bloat")).toBe(true);
  });

  it("returns empty for normal mid-size call", () => {
    const hits = runRules(
      ev({
        eventId: "c",
        model: "gpt-4o-mini",
        inputTokens: 800,
        outputTokens: 200,
        features: {
          promptChars: 2000,
          responseChars: 500,
          messageCount: 4,
          codeFenceCount: 1,
          largePasteScore: 0.1,
          fileDumpScore: 0.1,
          modelTier: "small",
        },
      }),
    );
    expect(hits).toEqual([]);
  });
});

describe("grain gating", () => {
  const trivialFrontier = {
    eventId: "e1", timestamp: "2026-08-05T12:00:00.000Z",
    machineId: "m1", machineName: "desktop", app: "claude-code",
    provider: "anthropic", model: "claude-opus-4[1m]",
    // Savings now come from the claude-opus-4 vs. claude-sonnet-5 rate
    // delta (priced by the shared pricer, not from costUsd, which savings
    // no longer read). Output-heavy so the larger output-rate delta clears
    // MIN_WASTED_USD within the frontier_trivial 200-token cap.
    inputTokens: 20, outputTokens: 180, costUsd: 5, hasContent: false,
    features: { modelTier: "frontier" as const, messageCount: 1, largePasteScore: 0,
                promptChars: 0, responseChars: 0, codeFenceCount: 0, fileDumpScore: 0 },
  };

  it("runs per-request rules on a request event", () => {
    const hits = runRules({ ...trivialFrontier, grain: "request" } as never);
    expect(hits.map((h) => h.ruleId)).toContain("frontier_trivial");
  });

  it("treats a missing grain as request, for pre-existing producers", () => {
    const hits = runRules(trivialFrontier as never);
    expect(hits.map((h) => h.ruleId)).toContain("frontier_trivial");
  });

  it("runs NO per-request rule on an aggregate event with identical numbers", () => {
    const hits = runRules({ ...trivialFrontier, grain: "aggregate" } as never);
    expect(hits).toEqual([]);
  });

  it("never evaluates an aggregate-grain rule that is sitting in REQUEST_RULES", () => {
    // REQUEST_RULES is a hand-maintained array: nothing stops an
    // aggregate-grain rule being appended to it, and before the declared-grain
    // filter existed, runRules called it and handed it a single UsageEvent.
    // `Rule.grain` was read by nothing at all.
    let evaluated = false;
    const misfiled: Rule<UsageEvent> = {
      id: "cache_efficiency",
      grain: "aggregate",
      defaultSeverity: "warn",
      evaluate() {
        evaluated = true;
        // A finding rich enough to clear the materiality floor, so a leak
        // shows up as a hit and not just a silent extra call.
        return {
          title: "misfiled",
          detail: "misfiled",
          eventIds: [],
          implicatedTokens: 1_000_000,
          counterfactual: {
            model: "claude-haiku-4-5",
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: null,
            cacheCreationTokens: null,
          },
        };
      },
    };

    REQUEST_RULES.push(misfiled);
    try {
      const hits = runRules({ ...trivialFrontier, grain: "request" } as never);
      expect(evaluated).toBe(false);
      expect(hits.map((h) => h.ruleId)).not.toContain("cache_efficiency");
    } finally {
      REQUEST_RULES.pop();
    }
  });

  it("accepts an event whose per-request features are absent", () => {
    const { features, ...rest } = trivialFrontier;
    const parsed = UsageEventSchema.safeParse({
      ...rest, grain: "aggregate", features: { modelTier: "frontier" },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("frontier_trivial counterfactual", () => {
  it("declares the cheaper in-vendor sibling at unchanged token counts", () => {
    const event = ev({
      eventId: "cf-1",
      model: "claude-opus-5",
      inputTokens: 120,
      outputTokens: 40,
      costUsd: null,
      features: {
        promptChars: 40,
        responseChars: 20,
        messageCount: 1,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "frontier",
      },
    });
    const finding = frontierTrivialRule.evaluate(event, CTX);
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(finding!.implicatedTokens).toBe(160);
  });

  it("is declared info severity — its findings are worth cents", () => {
    expect(frontierTrivialRule.defaultSeverity).toBe("info");
  });
});

describe("full_document_io counterfactual", () => {
  it("removes the excerptable share of input and states the assumption", () => {
    const event = ev({
      eventId: "fd-1",
      model: "claude-sonnet-5",
      inputTokens: 10_000,
      outputTokens: 200,
      costUsd: null,
      features: {
        promptChars: 40_000,
        responseChars: 400,
        messageCount: 1,
        codeFenceCount: 3,
        largePasteScore: 0.9,
        fileDumpScore: 0.8,
        modelTier: "mid",
      },
    });
    const finding = fullDocumentIoRule.evaluate(event, CTX);
    expect(finding).not.toBeNull();
    const removed = Math.floor(10_000 * 0.8 * FULL_DOC_EXCERPT_FRACTION);
    expect(finding!.counterfactual.inputTokens).toBe(10_000 - removed);
    expect(finding!.counterfactual.model).toBe("claude-sonnet-5");
    expect(finding!.implicatedTokens).toBe(removed);
    expect(finding!.assumption).toMatch(/half/i);
  });

  it("trims uncached content first so cache tokens don't outlive the shrunken input", () => {
    // 12,000 input, 8,000 already cached -> only 4,000 uncached. Excerpting
    // removes floor(12,000 * 0.8 * 0.5) = 4,800 tokens, more than the 4,000
    // uncached tokens available, so the counterfactual's cacheReadTokens
    // must shrink too: 8,000 - (4,800 - 4,000) = 7,200.
    const event = ev({
      eventId: "fd-2",
      model: "claude-haiku-4-5",
      inputTokens: 12_000,
      outputTokens: 0,
      cacheReadTokens: 8_000,
      costUsd: null,
      features: {
        promptChars: 40_000,
        responseChars: 0,
        messageCount: 1,
        codeFenceCount: 3,
        largePasteScore: 0.9,
        fileDumpScore: 0.8,
        modelTier: "mid",
      },
    });
    const finding = fullDocumentIoRule.evaluate(event, CTX);
    expect(finding).not.toBeNull();
    const cf = finding!.counterfactual;
    expect(finding!.implicatedTokens).toBe(4_800);
    expect(cf.inputTokens).toBe(7_200);

    // Post-condition: cache tokens never outlive the shrunken input.
    expect((cf.cacheReadTokens ?? 0) + (cf.cacheCreationTokens ?? 0)).toBeLessThanOrEqual(
      cf.inputTokens,
    );
    expect(cf.cacheReadTokens).toBe(7_200);
    expect(cf.cacheCreationTokens).toBeNull();

    // Savings must reflect the full 4,800-token removal. A stale, unclamped
    // cacheReadTokens: 8_000 on the counterfactual (the pre-fix bug) would
    // clamp the counterfactual's full-rate portion to 0 and understate the
    // saving relative to the fixed, correctly-trimmed counterfactual.
    const actual = {
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: 8_000,
      cacheCreationTokens: null,
    };
    const fixed = priceCounterfactual(actual, cf, CTX);
    const buggy = priceCounterfactual(actual, { ...cf, cacheReadTokens: 8_000 }, CTX);
    expect(fixed.estimatedWastedUsd).toBeGreaterThan(buggy.estimatedWastedUsd!);
  });

  it("leaves a null cache breakdown null when nothing needs to be trimmed from it", () => {
    // Same shape as the first test in this block: no cache breakdown was
    // ever recorded on the event, so nothing on the counterfactual should
    // ever turn that "unknown" into a materialized zero.
    const event = ev({
      eventId: "fd-3",
      model: "claude-sonnet-5",
      inputTokens: 10_000,
      outputTokens: 200,
      costUsd: null,
      features: {
        promptChars: 40_000,
        responseChars: 400,
        messageCount: 1,
        codeFenceCount: 3,
        largePasteScore: 0.9,
        fileDumpScore: 0.8,
        modelTier: "mid",
      },
    });
    const finding = fullDocumentIoRule.evaluate(event, CTX);
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual.cacheReadTokens).toBeNull();
    expect(finding!.counterfactual.cacheCreationTokens).toBeNull();
  });
});

describe("context_bloat counterfactual", () => {
  it("holds input flat at the session's first request", () => {
    const base = {
      model: "claude-sonnet-5",
      costUsd: null,
      sessionId: "s1",
      features: {
        promptChars: 1_000,
        responseChars: 100,
        messageCount: 4,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "mid" as const,
        newContentRatio: 0.05,
      },
    };
    const prior = [
      ev({ ...base, eventId: "b1", inputTokens: 5_000, outputTokens: 100 }),
      ev({ ...base, eventId: "b2", inputTokens: 9_000, outputTokens: 100 }),
    ];
    const current = ev({
      ...base,
      eventId: "b3",
      inputTokens: 40_000,
      outputTokens: 100,
    });
    const finding = contextBloatRule.evaluate(current, {
      ...CTX,
      sessionContext: prior,
    });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual.inputTokens).toBe(5_000);
    expect(finding!.implicatedTokens).toBe(35_000);
    expect(finding!.eventIds).toEqual(["b1", "b2", "b3"]);
    expect(finding!.assumption).toMatch(/first request/i);
  });

  it("trims uncached content first so cache tokens don't outlive the shrunken input", () => {
    // First request: 5,000 input. Current: 40,000 input, 30,000 already
    // cached (10,000 uncached). Holding input flat at the first request
    // removes 35,000 tokens, more than the 10,000 uncached tokens
    // available, so the counterfactual's cacheReadTokens must shrink too:
    // 30,000 - (35,000 - 10,000) = 5,000. Routine on real coding-agent
    // traffic, and the case this fix matters most for.
    const base = {
      model: "claude-haiku-4-5",
      costUsd: null,
      sessionId: "s1",
      features: {
        promptChars: 1_000,
        responseChars: 100,
        messageCount: 4,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "mid" as const,
        newContentRatio: 0.05,
      },
    };
    const prior = [
      ev({ ...base, eventId: "c1", inputTokens: 5_000, outputTokens: 100 }),
      ev({ ...base, eventId: "c2", inputTokens: 20_000, outputTokens: 100 }),
    ];
    const current = ev({
      ...base,
      eventId: "c3",
      inputTokens: 40_000,
      outputTokens: 100,
      cacheReadTokens: 30_000,
    });
    const finding = contextBloatRule.evaluate(current, {
      ...CTX,
      sessionContext: prior,
    });
    expect(finding).not.toBeNull();
    const cf = finding!.counterfactual;
    expect(finding!.implicatedTokens).toBe(35_000);
    expect(cf.inputTokens).toBe(5_000);

    // Post-condition: cache tokens never outlive the shrunken input.
    expect((cf.cacheReadTokens ?? 0) + (cf.cacheCreationTokens ?? 0)).toBeLessThanOrEqual(
      cf.inputTokens,
    );
    expect(cf.cacheReadTokens).toBe(5_000);
    expect(cf.cacheCreationTokens).toBeNull();

    // Savings must reflect the full 35,000-token removal. A stale,
    // unclamped cacheReadTokens: 30_000 on the counterfactual (the pre-fix
    // bug) would clamp the counterfactual's full-rate portion to 0 and
    // understate the saving relative to the fixed, correctly-trimmed
    // counterfactual.
    const actual = {
      model: current.model,
      inputTokens: current.inputTokens,
      outputTokens: current.outputTokens,
      cacheReadTokens: 30_000,
      cacheCreationTokens: null,
    };
    const fixed = priceCounterfactual(actual, cf, CTX);
    const buggy = priceCounterfactual(actual, { ...cf, cacheReadTokens: 30_000 }, CTX);
    expect(fixed.estimatedWastedUsd).toBeGreaterThan(buggy.estimatedWastedUsd!);
  });

  it("leaves a null cache breakdown null when nothing needs to be trimmed from it", () => {
    // Same shape as the first test in this block: no cache breakdown was
    // ever recorded on any event, so nothing on the counterfactual should
    // ever turn that "unknown" into a materialized zero.
    const base = {
      model: "claude-sonnet-5",
      costUsd: null,
      sessionId: "s1",
      features: {
        promptChars: 1_000,
        responseChars: 100,
        messageCount: 4,
        codeFenceCount: 0,
        largePasteScore: 0,
        fileDumpScore: 0,
        modelTier: "mid" as const,
        newContentRatio: 0.05,
      },
    };
    const prior = [
      ev({ ...base, eventId: "d1", inputTokens: 5_000, outputTokens: 100 }),
      ev({ ...base, eventId: "d2", inputTokens: 9_000, outputTokens: 100 }),
    ];
    const current = ev({
      ...base,
      eventId: "d3",
      inputTokens: 40_000,
      outputTokens: 100,
    });
    const finding = contextBloatRule.evaluate(current, {
      ...CTX,
      sessionContext: prior,
    });
    expect(finding).not.toBeNull();
    expect(finding!.counterfactual.cacheReadTokens).toBeNull();
    expect(finding!.counterfactual.cacheCreationTokens).toBeNull();
  });
});

describe("runRules pricing", () => {
  it("prices a hit from the counterfactual and carries the evidence", () => {
    // claude-opus-4, not claude-opus-5: at frontier_trivial's 200-token
    // cap, opus-5's much smaller rate delta to claude-sonnet-5 can never
    // clear MIN_WASTED_USD (max ~$0.003 at any token split), so this uses
    // the bigger opus-4 delta, output-heavy, to get a real priced hit.
    const hits = runRules(
      ev({
        eventId: "priced",
        model: "claude-opus-4",
        inputTokens: 20,
        outputTokens: 180,
        costUsd: null,
        features: {
          promptChars: 40,
          responseChars: 20,
          messageCount: 1,
          codeFenceCount: 0,
          largePasteScore: 0,
          fileDumpScore: 0,
          modelTier: "frontier",
        },
      }),
    );
    const hit = hits.find((h) => h.ruleId === "frontier_trivial");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("info");
    expect(hit!.counterfactual).not.toBeNull();
    expect(hit!.assumption).toContain("claude-sonnet-5");
    expect(hit!.estimatedWastedUsd).toBeGreaterThan(0);
  });
});
