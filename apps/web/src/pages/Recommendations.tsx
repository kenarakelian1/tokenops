import { useCallback, useEffect, useState } from "react";
import {
  dismissRecommendation,
  formatTokens,
  formatUsd,
  getRecommendations,
  type RecommendationDto,
} from "../api/client";

export function Recommendations() {
  const [rows, setRows] = useState<RecommendationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getRecommendations("open");
      setRows(res.recommendations);
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
      */}
      <div className="muted" style={{ fontSize: "0.9rem" }}>
        Tokens involved: {formatTokens(r.estimatedWastedTokens)} · Est. savings:{" "}
        {formatUsd(r.estimatedWastedUsd)}{" "}
        <span className="est-label">(estimated)</span>
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
