import { useEffect, useState } from "react";
import type { LocalStats } from "@tokenops/agent";

export type AgentStatus = {
  machineName: string;
  cloudUrl: string;
  /** Presence only -- never the token itself. */
  ingestTokenPresent: boolean;
  /** Presence only -- never the key itself. */
  upstreamKeyPresent: boolean;
  proxyListen: string | null;
  otelListen: string | null;
  claudeCodeWatching: boolean;
};

export type DesktopApi = {
  getStats(): Promise<LocalStats>;
  getStatus(): Promise<AgentStatus>;
  /**
   * No URL argument: main resolves and validates the real cloud.url itself
   * (main/ipc.ts) rather than trusting whatever the renderer sends -- see
   * that file's comment for why a renderer-supplied URL here would be a
   * hole through the app's http(s)-only shell.openExternal guard.
   */
  openDashboard(): void;
  openConfigFolder(): void;
};

declare global {
  interface Window {
    tokenops: DesktopApi;
  }
}

/**
 * `readLocalStats` (apps/agent/src/local-stats.ts) opens the SQLite outbox
 * read-only on every call while the agent may be mid-write to that same
 * file. 2s matches the agent's own flush/heartbeat cadence (FLUSH_INTERVAL_MS
 * in apps/agent/src/agent-main.ts), so the window never shows data staler
 * than the agent's own reporting interval, and a short-only read transaction
 * every 2s is cheap enough (a few small SELECTs against a local file) not to
 * matter even while the agent writes concurrently -- readLocalStats already
 * treats a transient SQLITE_BUSY as "no data this round" rather than a crash.
 */
const POLL_MS = 2000;

const usdFormat = (n: number): string =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });

export function App() {
  const [stats, setStats] = useState<LocalStats | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      // getStatus() throws until the agent has actually started (main/ipc.ts
      // gates it on a live AgentHandle, since its fields come from that
      // handle's config); getStats() reads the outbox file directly and
      // never throws. Fetch independently so a not-yet-started agent doesn't
      // also blank out stats that are otherwise available.
      const results = await Promise.allSettled([
        window.tokenops.getStats(),
        window.tokenops.getStatus(),
      ]);
      if (cancelled) return;
      if (results[0].status === "fulfilled") setStats(results[0].value);
      if (results[1].status === "fulfilled") setStatus(results[1].value);
    };

    void poll();

    // A window hidden to the tray (see main/window.ts's close-to-tray
    // behavior) has no one watching this data -- polling a SQLite file every
    // 2s for nobody is waste the user can't even see. Pause while hidden and
    // resume with an immediate refresh, rather than a stale wait for the next
    // tick, the moment the window is shown again.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        stop();
      } else {
        void poll();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  if (!stats || !status) {
    return (
      <div>
        <h1>TokenOps</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const { today, byApp, byModel, queue, recent } = stats;

  return (
    <div>
      <header>
        <h1>TokenOps</h1>
        <p>
          {status.machineName} — {status.cloudUrl}
        </p>
      </header>

      <section>
        <h2>Capture</h2>
        <ul>
          <li>
            Proxy: {status.proxyListen ?? "disabled"}
            {status.proxyListen && !status.upstreamKeyPresent && (
              <strong> — no upstream API key — upstream calls will fail auth</strong>
            )}
          </li>
          <li>OTEL (Claude Code metrics): {status.otelListen ?? "disabled"}</li>
          <li>
            Claude Code JSONL: {status.claudeCodeWatching ? "watching" : "disabled"}
          </li>
        </ul>
        {!status.ingestTokenPresent && (
          <p>not shipping to the cloud — no ingest token</p>
        )}
      </section>

      <section aria-label="Today">
        <h2>Today</h2>
        <dl>
          <dt>Input tokens</dt>
          <dd>{today.inputTokens.toLocaleString()}</dd>
          <dt>Output tokens</dt>
          <dd>{today.outputTokens.toLocaleString()}</dd>
          <dt>Estimated cost</dt>
          <dd>{usdFormat(today.estimatedUsd)}</dd>
          <dt>Events</dt>
          <dd>{today.eventCount.toLocaleString()}</dd>
        </dl>
      </section>

      <section>
        <h2>By app</h2>
        {byApp.length === 0 ? (
          <p>No activity yet today.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th>Input</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {byApp.map((row) => (
                <tr key={row.app}>
                  <td>{row.app}</td>
                  <td>{row.inputTokens.toLocaleString()}</td>
                  <td>{row.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>By model</h2>
        {byModel.length === 0 ? (
          <p>No activity yet today.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Input</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((row) => (
                <tr key={row.model}>
                  <td>{row.model}</td>
                  <td>{row.inputTokens.toLocaleString()}</td>
                  <td>{row.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Queue</h2>
        <p>Pending: {queue.pending}</p>
        {queue.lastError && <p role="alert">{queue.lastError}</p>}
      </section>

      <section>
        <h2>Recent activity</h2>
        {recent.length === 0 ? (
          <p>Nothing recent.</p>
        ) : (
          <ul>
            {recent.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                {r.at} — {r.app} / {r.model} — {r.inputTokens.toLocaleString()} in /{" "}
                {r.outputTokens.toLocaleString()} out
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>
        <button onClick={() => window.tokenops.openDashboard()}>
          Open dashboard
        </button>
        <button onClick={() => window.tokenops.openConfigFolder()}>
          Open config folder
        </button>
      </footer>
    </div>
  );
}
