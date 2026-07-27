import { describe, it, expect } from "vitest";
import { createApp } from "./app.js";

describe("health", () => {
  it("returns ok", async () => {
    const app = createApp({ db: null as never });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns service info at /", async () => {
    const app = createApp({ db: null as never });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; ok: boolean };
    expect(body.service).toBe("tokenops-api");
    expect(body.ok).toBe(true);
  });
});
