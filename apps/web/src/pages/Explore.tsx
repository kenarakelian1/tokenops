import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  formatUsd,
  getEvents,
  type UsageEventDto,
} from "../api/client";

type Filters = {
  machineId: string;
  app: string;
  model: string;
  from: string;
  to: string;
};

const emptyFilters: Filters = {
  machineId: "",
  app: "",
  model: "",
  from: "",
  to: "",
};

export function Explore() {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [events, setEvents] = useState<UsageEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (f: Filters) => {
    setBusy(true);
    setError(null);
    try {
      const res = await getEvents({
        machineId: f.machineId || undefined,
        app: f.app || undefined,
        model: f.model || undefined,
        from: f.from || undefined,
        to: f.to || undefined,
        limit: 200,
      });
      setEvents(res.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
      setEvents(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(applied);
  }, [applied, load]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setApplied({ ...draft });
  }

  function onReset() {
    setDraft(emptyFilters);
    setApplied(emptyFilters);
  }

  return (
    <div>
      <h1>Explore</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Filter usage events. Costs are <strong>estimated</strong>.
      </p>

      <form className="form-row" onSubmit={onSubmit}>
        <label>
          Machine ID
          <input
            value={draft.machineId}
            onChange={(e) => setDraft((d) => ({ ...d, machineId: e.target.value }))}
            placeholder="optional"
          />
        </label>
        <label>
          App
          <input
            value={draft.app}
            onChange={(e) => setDraft((d) => ({ ...d, app: e.target.value }))}
            placeholder="e.g. openai-proxy"
          />
        </label>
        <label>
          Model
          <input
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            placeholder="optional"
          />
        </label>
        <label>
          From (ISO)
          <input
            value={draft.from}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
            placeholder="2026-01-01"
          />
        </label>
        <label>
          To (ISO)
          <input
            value={draft.to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
            placeholder="2026-12-31"
          />
        </label>
        <button className="btn" type="submit" disabled={busy}>
          Apply
        </button>
        <button className="btn-ghost" type="button" onClick={onReset} disabled={busy}>
          Reset
        </button>
      </form>

      {error ? <div className="error">{error}</div> : null}
      {busy && events == null ? <div className="loading">Loading…</div> : null}

      {events && events.length === 0 ? (
        <div className="empty">No events match these filters.</div>
      ) : null}

      {events && events.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Machine</th>
                <th>App</th>
                <th>Model</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">
                  Est. $ <span className="est-label">(est.)</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.eventId}>
                  <td className="mono">{formatTs(ev.timestamp)}</td>
                  <td>
                    <div>{ev.machineName}</div>
                    <div className="muted mono" style={{ fontSize: "0.75rem" }}>
                      {ev.machineId}
                    </div>
                  </td>
                  <td className="mono">{ev.app}</td>
                  <td className="mono">{ev.model}</td>
                  <td className="num">{ev.inputTokens}</td>
                  <td className="num">{ev.outputTokens}</td>
                  <td className="num">{formatUsd(ev.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return iso;
  }
}
