import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setAuthTokenGetter } from "./client";

describe("api()", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // Reset the module-level getter so one test's stub can't leak into the next.
    setAuthTokenGetter(() => Promise.resolve(null));
    vi.unstubAllGlobals();
  });

  function lastRequestInit(): RequestInit {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return call[1] as RequestInit;
  }

  it("attaches Authorization: Bearer <token> when the getter resolves a token", async () => {
    setAuthTokenGetter(() => Promise.resolve("test-token"));

    await api("/v1/whatever");

    const headers = new Headers(lastRequestInit().headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
  });

  it("omits the Authorization header when the getter resolves null", async () => {
    setAuthTokenGetter(() => Promise.resolve(null));

    await api("/v1/whatever");

    const headers = new Headers(lastRequestInit().headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("omits the Authorization header when no getter has been registered", async () => {
    await api("/v1/whatever");

    const headers = new Headers(lastRequestInit().headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("does not send cookie credentials — the API no longer reads them", async () => {
    setAuthTokenGetter(() => Promise.resolve("test-token"));

    await api("/v1/whatever");

    expect(lastRequestInit().credentials).toBeUndefined();
  });
});
