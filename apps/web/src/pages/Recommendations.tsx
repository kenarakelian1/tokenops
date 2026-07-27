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
        Efficiency tips with estimated waste. Savings figures are{" "}
        <strong>estimated</strong>.
      </p>

      {error ? <div className="error">{error}</div> : null}
      {rows == null && !error ? <div className="loading">Loading…</div> : null}

      {rows && rows.length === 0 ? (
        <div className="empty">No open recommendations.</div>
      ) : null}

      {rows && rows.length > 0 ? (
        <div className="rec-list">
          {rows.map((r) => (
            <article key={r.id} className="rec-item">
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
                  disabled={busyId === r.id}
                  onClick={() => void onDismiss(r.id)}
                >
                  {busyId === r.id ? "…" : "Dismiss"}
                </button>
              </header>
              <p style={{ margin: "0.75rem 0 0.5rem" }}>{r.detail}</p>
              <div className="muted" style={{ fontSize: "0.9rem" }}>
                Est. waste: {formatTokens(r.estimatedWastedTokens)} tokens ·{" "}
                {formatUsd(r.estimatedWastedUsd)}{" "}
                <span className="est-label">(estimated)</span>
                {r.eventIds.length > 0
                  ? ` · ${r.eventIds.length} linked event(s)`
                  : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function severityClass(s: string): string {
  const lower = s.toLowerCase();
  if (lower === "high" || lower === "critical") return "high";
  if (lower === "medium" || lower === "med") return "medium";
  return "low";
}
