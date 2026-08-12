import { useCallback, useEffect, useState } from "react";
import {
  dismissRecommendation,
  formatTokens,
  formatUsd,
  getRecommendations,
  type CoverageDto,
  type RecommendationDto,
} from "../api/client";

export function Recommendations() {
  const [rows, setRows] = useState<RecommendationDto[] | null>(null);
  const [coverage, setCoverage] = useState<CoverageDto | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getRecommendations("open");
      setRows(res.recommendations);
      setCoverage(res.coverage);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recommendations");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onDismiss(id: string) {
    setBusyId(id);
    try {
      await dismissRecommendation(id);
      setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dismiss failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1>Recommendations</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Efficiency findings, highest estimated savings first. Savings figures are{" "}
        <strong>estimated</strong> — each is a real token count priced at
        published rates under the stated assumption, not a measurement.
      </p>

      {coverage ? <CoverageNote coverage={coverage} /> : null}

      {error ? <div className="error">{error}</div> : null}
      {rows == null && !error ? <div className="loading">Loading…</div> : null}

      {rows && rows.length === 0 ? (
        <div className="empty">No open recommendations.</div>
      ) : null}

      {rows && rows.length > 0 ? (
        <div className="rec-list">
          {rows.map((r) => (
            <RecommendationCard
              key={r.id}
              rec={r}
              busy={busyId === r.id}
              onDismiss={() => void onDismiss(r.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * States what the session-rules panel does NOT cover, in the sentence a
 * user actually reads. Three blind spots/edge cases, all silent otherwise:
 *
 * - Zero sessions considered (a brand-new account with no history yet) gets
 *   its own sentence rather than the arithmetically-true-but-absurd
 *   "Considered 0 sessions, all shown per rule."
 * - Only the top `sessionsShownPerRule` sessions per rule ever get a card
 *   (see MAX_SESSION_CARDS_PER_RULE in jobs/session-rules.ts) — a session
 *   ranked 11th on a rule produces no card, with nothing on the page to say
 *   so. That clause is only shown when a truncation actually happened
 *   (`sessionsConsidered > sessionsShownPerRule`); claiming "top 10 per
 *   rule" when only 3 sessions exist would assert a cap that never bound
 *   anything.
 * - Subagent/sidechain turns carry no sessionId by the adapter's design, so
 *   their tokens never enter a rollup and never produce a card either. That
 *   clause is only shown when `unattributedTurns > 0` — a dangling "0
 *   subagent turns belong to no session" sentence would read as a bug
 *   report, not as good news. Its singular/plural agreement (noun AND both
 *   verbs — "1 turn belongs ... is not counted" vs "2 turns belong ... are
 *   not counted") is decided once via `isSingularTurn` so the three
 *   agreements cannot drift apart from each other. `(N tokens)` itself stays
 *   plural regardless of turn count — a single turn still carries many
 *   tokens, so the token count doesn't govern that word.
 *
 * Exported (and free of hooks, unlike `Recommendations` itself) so
 * `Recommendations.test.tsx` can render it standalone with
 * `renderToStaticMarkup`, the same no-DOM pattern used for `RecommendationCard`.
 */
export function CoverageNote({ coverage }: { coverage: CoverageDto }) {
  const {
    sessionsConsidered,
    sessionsShownPerRule,
    unattributedTurns,
    unattributedInputTokens,
  } = coverage;

  if (sessionsConsidered === 0) {
    return (
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        No sessions in this window yet.
      </p>
    );
  }

  const sessionWord = sessionsConsidered === 1 ? "session" : "sessions";
  const scopeClause =
    sessionsConsidered > sessionsShownPerRule
      ? `showing the top ${sessionsShownPerRule} per rule`
      : "all shown per rule";

  const isSingularTurn = unattributedTurns === 1;
  const unattributedClause =
    unattributedTurns > 0
      ? ` ${unattributedTurns.toLocaleString("en-US")} subagent turn${
          isSingularTurn ? "" : "s"
        } (${formatTokens(unattributedInputTokens)} tokens) ${
          isSingularTurn ? "belongs" : "belong"
        } to no session and ${isSingularTurn ? "is" : "are"} not counted here.`
      : "";

  return (
    <p className="muted" style={{ fontSize: "0.85rem" }}>
      Considered {sessionsConsidered.toLocaleString("en-US")} {sessionWord},{" "}
      {scopeClause}.
      {unattributedClause}
    </p>
  );
}

/**
 * One finding's card. Exported (and free of hooks) so `Recommendations.test.tsx`
 * can render it and assert on the sentences a user actually reads — the
 * evidence line, the counterfactual, and the assumption. Every defect this
 * component has shipped was a string no test had ever looked at.
 */
export function RecommendationCard({
  rec: r,
  busy,
  onDismiss,
}: {
  rec: RecommendationDto;
  busy: boolean;
  onDismiss: () => void;
}) {
  return (
    <article className="rec-item">
      <header>
        <div>
          <h3>
            <span className={`severity severity-${severityClass(r.severity)}`}>
              {r.severity}
            </span>
            {r.title}
          </h3>
          <div className="muted mono" style={{ fontSize: "0.8rem" }}>
            {r.ruleId} · {new Date(r.createdAt).toISOString().slice(0, 10)}
          </div>
        </div>
        <button
          type="button"
          className="btn-danger"
          disabled={busy}
          onClick={onDismiss}
        >
          {busy ? "…" : "Dismiss"}
        </button>
      </header>
      <p style={{ margin: "0.75rem 0 0.5rem" }}>{r.detail}</p>
      {/*
        "Tokens involved", not "Est. waste": estimatedWastedTokens is the
        tokens the finding is ABOUT, which for several rules is neither waste
        nor a delta. frontier_share sets it to every frontier model's tokens
        in the window while repricing only the dominant one; cache_efficiency
        sets it to the cache-read shortfall, tokens that were billed at the
        full rate rather than wasted. Labelling both figures "waste" invited
        dividing one by the other for a per-token rate that corresponds to
        nothing. The money keeps its own label, and stays "estimated".

        The dollar figure is also labelled "API-equivalent": most accounts
        are on a subscription, where nothing is billed per token, so this
        number is not what the user was charged. It is what the tokens
        involved would have cost had this usage gone through the API at
        published rates — the counterfactual the estimate is actually
        measuring. Tokens stay the primary, measured figure; the dollars are
        a unit conversion of them, not a receipt.
      */}
      <div className="muted" style={{ fontSize: "0.9rem" }}>
        Tokens involved: {formatTokens(r.estimatedWastedTokens)} · Est. savings:{" "}
        {formatUsd(r.estimatedWastedUsd)}{" "}
        <span className="est-label">(estimated, API-equivalent)</span>
        {r.eventIds.length > 0 ? ` · ${r.eventIds.length} linked event(s)` : null}
      </div>
      {r.counterfactual ? (
        <div className="muted mono" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
          Would have been: {describeCounterfactual(r.counterfactual)}
        </div>
      ) : null}
      {r.assumption ? (
        <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
          Assumes: {r.assumption}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The counterfactual, in one line: what the request or window would have
 * looked like had the advice been followed.
 *
 * The cache components are here because without them `cache_efficiency` —
 * the highest-value rule, and the one the whole counterfactual design exists
 * to let quote dollars — rendered a hypothetical identical to what actually
 * happened. Its advice changes neither the model nor either token count; it
 * moves tokens from the full input rate into the 0.1x cache-read rate, and
 * that move was the one part of the counterfactual the card never showed.
 * docs/rules/authoring.md § 3 names cache-mix as one of three counterfactual
 * shapes; this is the third one becoming visible.
 *
 * `null` vs `0` stays load-bearing, exactly as it is in the rules and the
 * pricer: `null` means no cache breakdown was ever recorded, and renders
 * NOTHING — not a zero, not a dash, which would both assert knowledge the
 * data does not support. A recorded `0` is a real measurement and is shown.
 * The two components are tested independently because a rule can legitimately
 * produce one of each (see trimCacheTokens).
 */
export function describeCounterfactual(
  cf: NonNullable<RecommendationDto["counterfactual"]>,
): string {
  const parts = [
    cf.model,
    `${formatTokens(cf.inputTokens)} in / ${formatTokens(cf.outputTokens)} out`,
  ];
  if (cf.cacheReadTokens != null) {
    parts.push(`${formatTokens(cf.cacheReadTokens)} cache read`);
  }
  if (cf.cacheCreationTokens != null) {
    parts.push(`${formatTokens(cf.cacheCreationTokens)} cache write`);
  }
  return parts.join(" · ");
}

function severityClass(s: string): string {
  const lower = s.toLowerCase();
  if (lower === "high" || lower === "critical") return "high";
  if (lower === "medium" || lower === "med") return "medium";
  return "low";
}
