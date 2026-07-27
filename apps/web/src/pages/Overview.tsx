import { useEffect, useMemo, useState } from "react";
import {
  formatTokens,
  formatUsd,
  getAggregates,
  type AggregateRow,
  type UserMe,
  utcDay,
  utcDayDaysAgo,
} from "../api/client";

type Props = {
  user: UserMe;
};

type Totals = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  eventCount: number;
};

function emptyTotals(): Totals {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, eventCount: 0 };
}

function sumRows(rows: AggregateRow[]): Totals {
  const t = emptyTotals();
  for (const r of rows) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.costUsd += r.costUsd;
    t.eventCount += r.eventCount;
  }
  return t;
}

function filterByDayRange(
  rows: AggregateRow[],
  fromDay: string,
  toDay: string,
): AggregateRow[] {
  return rows.filter((r) => r.day >= fromDay && r.day <= toDay);
}

type ModelRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  eventCount: number;
};

function topModels(rows: AggregateRow[], limit = 10): ModelRow[] {
  const map = new Map<string, ModelRow>();
  for (const r of rows) {
    const cur = map.get(r.model) ?? {
      model: r.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      eventCount: 0,
    };
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.costUsd += r.costUsd;
    cur.eventCount += r.eventCount;
    map.set(r.model, cur);
  }
  return [...map.values()]
    .sort((a, b) => b.costUsd - a.costUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    .slice(0, limit);
}

export function Overview({ user }: Props) {
  const [rows, setRows] = useState<AggregateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = utcDay();
  const from30 = utcDayDaysAgo(29); // inclusive 30 calendar days

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAggregates({ from: from30, to: today });
        if (!cancelled) {
          setRows(res.aggregates);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load aggregates");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from30, today]);

  const periods = useMemo(() => {
    if (!rows) return null;
    const d7 = utcDayDaysAgo(6);
    const d30 = from30;
    return {
      today: sumRows(filterByDayRange(rows, today, today)),
      d7: sumRows(filterByDayRange(rows, d7, today)),
      d30: sumRows(filterByDayRange(rows, d30, today)),
      models: topModels(filterByDayRange(rows, d30, today)),
    };
  }, [rows, today, from30]);

  const budget =
    user.budgetUsdMonthly != null && user.budgetUsdMonthly !== ""
      ? Number(user.budgetUsdMonthly)
      : null;
  const monthSpend = periods?.d30.costUsd ?? 0;
  const overBudget =
    budget != null && Number.isFinite(budget) && monthSpend > budget;

  return (
    <div>
      <h1>Overview</h1>
      <p className="muted" style={{ marginTop: "-0.5rem", marginBottom: "1rem" }}>
        Tokens and estimated cost. Money figures are always <strong>estimated</strong>.
      </p>

      {error ? <div className="error">{error}</div> : null}
      {rows == null && !error ? <div className="loading">Loading aggregates…</div> : null}

      {overBudget ? (
        <div className="banner">
          Soft budget: estimated spend last 30 days ({formatUsd(monthSpend)}) is above
          your monthly budget of {formatUsd(budget)}.
        </div>
      ) : null}

      {periods ? (
        <>
          <div className="cards">
            <PeriodCard title="Today" totals={periods.today} />
            <PeriodCard title="Last 7 days" totals={periods.d7} />
            <PeriodCard title="Last 30 days" totals={periods.d30} />
          </div>

          <h2>Top models (30d)</h2>
          {periods.models.length === 0 ? (
            <div className="empty">No usage yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Input tokens</th>
                    <th className="num">Output tokens</th>
                    <th className="num">
                      Est. cost <span className="est-label">(estimated)</span>
                    </th>
                    <th className="num">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.models.map((m) => (
                    <tr key={m.model}>
                      <td className="mono">{m.model}</td>
                      <td className="num">{formatTokens(m.inputTokens)}</td>
                      <td className="num">{formatTokens(m.outputTokens)}</td>
                      <td className="num">{formatUsd(m.costUsd)}</td>
                      <td className="num">{m.eventCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function PeriodCard({ title, totals }: { title: string; totals: Totals }) {
  const tokens = totals.inputTokens + totals.outputTokens;
  return (
    <div className="card">
      <div className="label">{title}</div>
      <div className="value">{formatTokens(tokens)}</div>
      <div className="sub">
        tokens · est. {formatUsd(totals.costUsd)}{" "}
        <span className="est-label">(estimated)</span>
      </div>
      <div className="sub">{totals.eventCount} events</div>
    </div>
  );
}
