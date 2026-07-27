import type { Outbox } from "./outbox.js";

export type FlushOutboxOptions = {
  outbox: Outbox;
  cloudUrl: string;
  ingestToken: string;
  /** Max pending events per request (default 100). */
  limit?: number;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type FlushOutboxResult = {
  sent: number;
  error?: string;
};

function cloudBase(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * POST pending outbox events to `POST {cloudUrl}/v1/events` with Bearer PAT.
 * On 2xx: mark all shipped ids sent. On failure: markFailed each + return error.
 */
export async function flushOutbox(
  opts: FlushOutboxOptions,
): Promise<FlushOutboxResult> {
  const limit = opts.limit ?? 100;
  const events = opts.outbox.listPending(limit);
  if (events.length === 0) {
    return { sent: 0 };
  }

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const url = `${cloudBase(opts.cloudUrl)}/v1/events`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.ingestToken}`,
      },
      body: JSON.stringify({ events }),
    });

    if (res.ok) {
      const ids = events.map((e) => e.eventId);
      opts.outbox.markSent(ids);
      return { sent: ids.length };
    }

    const bodyText = await res.text().catch(() => "");
    const msg = `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`;
    for (const e of events) {
      opts.outbox.markFailed(e.eventId, msg);
    }
    return { sent: 0, error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const e of events) {
      opts.outbox.markFailed(e.eventId, msg);
    }
    return { sent: 0, error: msg };
  }
}

export type SendHeartbeatOptions = {
  cloudUrl: string;
  ingestToken: string;
  machineId: string;
  machineName: string;
  queueDepth: number;
  fetchImpl?: typeof fetch;
};

export type SendHeartbeatResult = {
  ok: boolean;
  error?: string;
};

/**
 * POST machine heartbeat to `POST {cloudUrl}/v1/heartbeats` with Bearer PAT.
 */
export async function sendHeartbeat(
  opts: SendHeartbeatOptions,
): Promise<SendHeartbeatResult> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const url = `${cloudBase(opts.cloudUrl)}/v1/heartbeats`;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.ingestToken}`,
      },
      body: JSON.stringify({
        machineId: opts.machineId,
        machineName: opts.machineName,
        queueDepth: opts.queueDepth,
      }),
    });

    if (res.ok) {
      return { ok: true };
    }

    const bodyText = await res.text().catch(() => "");
    const msg = `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`;
    return { ok: false, error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
