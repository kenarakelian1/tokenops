import http from "node:http";
import type { UsageEvent } from "@tokenops/shared";
import {
  buildUsageEvent,
  normalizeUpstreamBase,
  parseSseUsage,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from "./handler.js";

export type StartProxyOptions = {
  listen: string;
  upstream: string;
  apiKey: string;
  onEvent: (e: UsageEvent) => void;
  machineId: string;
  machineName: string;
};

function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(":");
  if (idx === -1) {
    return { host: "127.0.0.1", port: Number(listen) || 0 };
  }
  const host = listen.slice(0, idx) || "127.0.0.1";
  const port = Number(listen.slice(idx + 1));
  return { host, port: Number.isFinite(port) ? port : 0 };
}

function joinUpstream(upstream: string, pathWithQuery: string): string {
  const base = upstream.replace(/\/$/, "");
  const path = pathWithQuery.startsWith("/")
    ? pathWithQuery
    : `/${pathWithQuery}`;
  return `${base}${path}`;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Start a local OpenAI-compatible proxy that captures usage events.
 * Upstream API key is used only for Authorization to upstream — never in onEvent.
 */
export async function startProxy(
  opts: StartProxyOptions,
): Promise<http.Server> {
  const { host, port } = parseListen(opts.listen);
  const upstreamBase = normalizeUpstreamBase(opts.upstream);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        ...opts,
        upstream: upstreamBase,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "proxy_error",
            },
          }),
        );
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

type HandleOpts = StartProxyOptions;

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: HandleOpts,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    await handleChatCompletions(req, res, opts, url);
    return;
  }

  // Optional: proxy other /v1/* paths without usage capture
  if (url.pathname.startsWith("/v1/")) {
    await proxyPassthrough(req, res, opts, url);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: HandleOpts,
  url: URL,
): Promise<void> {
  const started = Date.now();
  const rawBody = await readBody(req);

  let requestBody: ChatCompletionRequest;
  try {
    requestBody = JSON.parse(rawBody.toString("utf8")) as ChatCompletionRequest;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Invalid JSON body", type: "invalid_request_error" },
      }),
    );
    return;
  }

  const wantsStream = requestBody.stream === true;
  const target = joinUpstream(
    opts.upstream,
    `${url.pathname}${url.search}`,
  );

  // Authorization uses local upstream key only — never logged into events.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    accept: wantsStream ? "text/event-stream" : "application/json",
  };

  const upstreamRes = await fetch(target, {
    method: "POST",
    headers,
    body: new Uint8Array(rawBody),
  });

  const contentType =
    upstreamRes.headers.get("content-type") ?? "application/json";

  if (wantsStream || contentType.includes("text/event-stream")) {
    await handleStreamResponse(
      upstreamRes,
      res,
      opts,
      requestBody,
      started,
      contentType,
    );
    return;
  }

  const responseBuf = Buffer.from(await upstreamRes.arrayBuffer());
  const latencyMs = Date.now() - started;

  res.writeHead(upstreamRes.status, {
    "content-type": contentType,
  });
  res.end(responseBuf);

  // Emit usage only on success-ish JSON; still try parse on error bodies.
  tryEmitJsonEvent({
    opts,
    requestBody,
    responseBuf,
    latencyMs,
    status: upstreamRes.status,
  });
}

function tryEmitJsonEvent(args: {
  opts: HandleOpts;
  requestBody: ChatCompletionRequest;
  responseBuf: Buffer;
  latencyMs: number;
  status: number;
}): void {
  const { opts, requestBody, responseBuf, latencyMs } = args;
  let responseBody: ChatCompletionResponse | null = null;
  try {
    responseBody = JSON.parse(
      responseBuf.toString("utf8"),
    ) as ChatCompletionResponse;
  } catch {
    responseBody = null;
  }

  try {
    const event = buildUsageEvent({
      machineId: opts.machineId,
      machineName: opts.machineName,
      upstream: opts.upstream,
      requestBody,
      responseBody,
      latencyMs,
    });
    // Defense: never leak api key into payload (should not be present)
    assertNoApiKey(event, opts.apiKey);
    opts.onEvent(event);
  } catch {
    // Feature extract / event build must never fail the client response
  }
}

async function handleStreamResponse(
  upstreamRes: Response,
  res: http.ServerResponse,
  opts: HandleOpts,
  requestBody: ChatCompletionRequest,
  started: number,
  contentType: string,
): Promise<void> {
  res.writeHead(upstreamRes.status, {
    "content-type": contentType,
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let sseText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(value);
        sseText += decoder.decode(value, { stream: true });
      }
    }
    sseText += decoder.decode();
  } finally {
    res.end();
  }

  const latencyMs = Date.now() - started;
  const accum = parseSseUsage(sseText);

  try {
    const event = buildUsageEvent({
      machineId: opts.machineId,
      machineName: opts.machineName,
      upstream: opts.upstream,
      requestBody,
      responseBody: null,
      streamAccum: accum,
      latencyMs,
    });
    assertNoApiKey(event, opts.apiKey);
    opts.onEvent(event);
  } catch {
    // best-effort
  }
}

async function proxyPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: HandleOpts,
  url: URL,
): Promise<void> {
  const rawBody =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await readBody(req);

  const target = joinUpstream(opts.upstream, `${url.pathname}${url.search}`);
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.apiKey}`,
  };
  const ct = req.headers["content-type"];
  if (typeof ct === "string") headers["content-type"] = ct;

  const upstreamRes = await fetch(target, {
    method: req.method ?? "GET",
    headers,
    body: rawBody ? new Uint8Array(rawBody) : undefined,
  });

  const responseBuf = Buffer.from(await upstreamRes.arrayBuffer());
  const contentType =
    upstreamRes.headers.get("content-type") ?? "application/octet-stream";
  res.writeHead(upstreamRes.status, { "content-type": contentType });
  res.end(responseBuf);
}

/** Ensure API key string does not appear in serialized event. */
function assertNoApiKey(event: UsageEvent, apiKey: string): void {
  if (!apiKey) return;
  const json = JSON.stringify(event);
  if (json.includes(apiKey)) {
    throw new Error("Refusing to emit event containing upstream API key");
  }
}
