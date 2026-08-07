/** Base URL for the API. Empty string = same origin (e.g. reverse-proxy). */
export const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const msg =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${status}`;
    super(msg);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Supplies the Clerk session token. Set once at app start; `api()` is a plain
 * module function and cannot call React hooks itself.
 */
let authTokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(getter: () => Promise<string | null>): void {
  authTokenGetter = getter;
}

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (
    init?.body != null &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const token = await authTokenGetter?.();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

// --- Types matching API DTOs ---

export type UserMe = {
  id: string;
  email: string;
  budgetUsdMonthly: string | number | null;
};

export type AggregateRow = {
  userId: string;
  day: string;
  machineId: string;
  app: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  eventCount: number;
};

export type UsageEventDto = {
  eventId: string;
  timestamp: string;
  machineId: string;
  machineName: string;
  app: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  sessionId: string | null;
  features: unknown;
  hasContent: boolean;
};

export type RecommendationDto = {
  id: string;
  ruleId: string;
  severity: string;
  title: string;
  detail: string;
  estimatedWastedTokens: number;
  estimatedWastedUsd: number | null;
  eventIds: string[];
  status: string;
  createdAt: string;
  counterfactual: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
  } | null;
  assumption: string | null;
};

export type MachineDto = {
  machineId: string;
  name: string;
  lastSeenAt: string;
  lastQueueDepth: number | null;
};

// --- Endpoint helpers ---

/** Clerk owns sign-in/out; this just hydrates the app's own user record (budget, etc). */
export function getMe() {
  return api<UserMe>("/v1/auth/me");
}

export function getAggregates(params?: { from?: string; to?: string }) {
  const q = new URLSearchParams();
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  const qs = q.toString();
  return api<{ aggregates: AggregateRow[] }>(
    `/v1/aggregates${qs ? `?${qs}` : ""}`,
  );
}

export function getEvents(params?: {
  machineId?: string;
  app?: string;
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const q = new URLSearchParams();
  if (params?.machineId) q.set("machineId", params.machineId);
  if (params?.app) q.set("app", params.app);
  if (params?.model) q.set("model", params.model);
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  if (params?.limit != null) q.set("limit", String(params.limit));
  const qs = q.toString();
  return api<{ events: UsageEventDto[] }>(
    `/v1/events${qs ? `?${qs}` : ""}`,
  );
}

export function getRecommendations(status: "open" | "dismissed" | "all" = "open") {
  return api<{ recommendations: RecommendationDto[] }>(
    `/v1/recommendations?status=${status}`,
  );
}

export function dismissRecommendation(id: string) {
  return api<{ ok: boolean }>(`/v1/recommendations/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
  });
}

export function getMachines() {
  return api<{ machines: MachineDto[] }>("/v1/machines");
}

export function putSettings(body: { budgetUsdMonthly: number | null }) {
  return api<{ budgetUsdMonthly: number | null }>("/v1/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Create agent ingest PAT. Token is shown once. */
export function createPat(name: string) {
  return api<{ token: string; id: string }>("/v1/auth/pats", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** Format estimated USD for display. Always labeled estimated in UI. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `$${value.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** UTC calendar day YYYY-MM-DD. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** UTC day string N days before `from` (default today). */
export function utcDayDaysAgo(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
