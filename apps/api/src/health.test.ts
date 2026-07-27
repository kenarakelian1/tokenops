import { describe, it, expect } from "vitest";
import { createApp } from "./app.js";

describe("health", () => {
  it("returns ok", async () => {
    const app = createApp({ db: null as never });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
