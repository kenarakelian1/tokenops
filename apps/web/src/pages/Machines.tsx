import { useEffect, useState } from "react";
import { getMachines, type MachineDto } from "../api/client";

export function Machines() {
  const [machines, setMachines] = useState<MachineDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getMachines();
        if (!cancelled) {
          setMachines(res.machines);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load machines");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1>Machines</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Agents that have heartbeated. Last-seen and outbox queue depth.
      </p>

      {error ? <div className="error">{error}</div> : null}
      {machines == null && !error ? <div className="loading">Loading…</div> : null}

      {machines && machines.length === 0 ? (
        <div className="empty">No machines yet. Start a local agent with a PAT.</div>
      ) : null}

      {machines && machines.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Machine ID</th>
                <th>Last seen</th>
                <th className="num">Queue depth</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const ageMs = Date.now() - new Date(m.lastSeenAt).getTime();
                const stale = ageMs > 15 * 60 * 1000;
                return (
                  <tr key={m.machineId}>
                    <td>{m.name}</td>
                    <td className="mono">{m.machineId}</td>
                    <td className="mono">{formatSeen(m.lastSeenAt)}</td>
                    <td className="num">
                      {m.lastQueueDepth != null ? m.lastQueueDepth : "—"}
                    </td>
                    <td>{stale ? "Stale" : "Recent"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function formatSeen(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return iso;
  }
}
